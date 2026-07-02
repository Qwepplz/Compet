import path from "node:path";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const steam64Base = 76561197960265728n;
export const DEFAULT_RANKME_SCORE = 1000;

export type RankmeScoreLookup =
  | { status: "found"; score: number }
  | { status: "missing" }
  | { status: "unavailable" };

export interface RankmeScoreReader {
  getScoreBySteam64(steam64: string): Promise<number | null>;
  lookupScoreBySteam64?(steam64: string): Promise<RankmeScoreLookup>;
}

export interface RankmeDatabaseConfig {
  host: string;
  database: string;
  user: string;
  password: string;
  port: number;
}

const mysqlCliPaths = [
  "mysql.exe",
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "MySQL", "MySQL Server 5.6", "bin", "mysql.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "MySQL", "MySQL Server 8.0", "bin", "mysql.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "MySQL", "MySQL Workbench 8.0", "mysql.exe"),
  path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "MySQL", "MySQL Server 5.6", "bin", "mysql.exe"),
];

export function parseRankmeDatabaseConfig(source: string): RankmeDatabaseConfig | null {
  const block = source.match(/"rankme"\s*\{([\s\S]*?)\}/)?.[1];
  if (!block) return null;

  const fields = new Map<string, string>();
  for (const match of block.matchAll(/"([^"]+)"\s+"([^"]*)"/g)) {
    fields.set(match[1]!, match[2]!);
  }

  const host = fields.get("host");
  const database = fields.get("database");
  const user = fields.get("user");
  if (!host || !database || !user) return null;

  const port = Number(fields.get("port") ?? 3306);
  return {
    host,
    database,
    user,
    password: fields.get("pass") ?? "",
    port: Number.isFinite(port) && port > 0 ? port : 3306,
  };
}

export function buildRankmeScoreQuery(steam64: string): string | null {
  const normalizedSteam64 = steam64.trim();
  if (!/^\d{17}$/.test(normalizedSteam64)) return null;
  const accountId = BigInt(normalizedSteam64) - steam64Base;
  if (accountId < 0n) return null;
  const steam2 = `STEAM_1:${accountId % 2n}:${accountId / 2n}`;
  return `SELECT score FROM \`rankme\` WHERE steam IN ('${normalizedSteam64}', '${steam2}') LIMIT 1;`;
}

export function parseMysqlScoreLookup(output: string): RankmeScoreLookup {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return { status: "missing" };
  if (lines.length !== 1) return { status: "unavailable" };
  const score = Number(lines[0]);
  return Number.isFinite(score) ? { status: "found", score } : { status: "unavailable" };
}

export function parseMysqlScoreOutput(output: string): number | null {
  const lookup = parseMysqlScoreLookup(output);
  return lookup.status === "found" ? lookup.score : null;
}

export async function lookupRankmeScore(reader: RankmeScoreReader, steam64: string): Promise<RankmeScoreLookup> {
  if (reader.lookupScoreBySteam64) return reader.lookupScoreBySteam64(steam64);
  const score = await reader.getScoreBySteam64(steam64);
  return typeof score === "number" && Number.isFinite(score) ? { status: "found", score } : { status: "unavailable" };
}

export async function resolveMysqlCliPath(): Promise<string | null> {
  for (const candidate of mysqlCliPaths) {
    if (candidate === "mysql.exe") {
      try {
        await execFileAsync(candidate, ["--version"], { windowsHide: true });
        return candidate;
      } catch {
        continue;
      }
    }
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export class RankmeScoreStore implements RankmeScoreReader {
  constructor(
    private readonly config: RankmeDatabaseConfig,
    private readonly mysqlPath: string,
  ) {}

  static async create(serverRoot: string): Promise<RankmeScoreStore | null> {
    if (!serverRoot) return null;
    const configPath = path.join(serverRoot, "csgo", "addons", "sourcemod", "configs", "databases.cfg");
    let config: RankmeDatabaseConfig | null;
    try {
      config = parseRankmeDatabaseConfig(await readFile(configPath, "utf8"));
    } catch {
      return null;
    }
    if (!config) return null;
    const mysqlPath = await resolveMysqlCliPath();
    if (!mysqlPath) return null;

    return new RankmeScoreStore(config, mysqlPath);
  }

  async getScoreBySteam64(steam64: string): Promise<number | null> {
    const lookup = await this.lookupScoreBySteam64(steam64);
    return lookup.status === "found" ? lookup.score : null;
  }

  async lookupScoreBySteam64(steam64: string): Promise<RankmeScoreLookup> {
    const query = buildRankmeScoreQuery(steam64);
    if (!query) return { status: "unavailable" };
    try {
      const { stdout } = await execFileAsync(this.mysqlPath, [
        "--batch",
        "--raw",
        "--skip-column-names",
        `--host=${this.config.host}`,
        `--port=${this.config.port}`,
        `--user=${this.config.user}`,
        this.config.database,
        `--execute=${query}`,
      ], {
        env: { ...process.env, MYSQL_PWD: this.config.password },
        maxBuffer: 8 * 1024,
        windowsHide: true,
      });
      return parseMysqlScoreLookup(stdout);
    } catch {
      return { status: "unavailable" };
    }
  }
}
