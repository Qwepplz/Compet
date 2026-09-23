import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import {
  parseRankmeDatabaseConfig,
  resolveMysqlCliPath,
  type RankmeDatabaseConfig,
} from "../rankme/rankmeScoreStore.js";

const execFileAsync = promisify(execFile);
const SAFE_MATCH_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type MysqlDatabaseConfig = RankmeDatabaseConfig;

export interface MysqlBackupProcess {
  dump(database: MysqlDatabaseConfig, filePath: string, signal?: AbortSignal): Promise<void>;
  restore(database: MysqlDatabaseConfig, filePath: string): Promise<void>;
}

export interface MysqlDatabaseBackupOptions {
  backupDir: string;
  database?: MysqlDatabaseConfig;
  serverRoot?: string;
  process?: MysqlBackupProcess;
}

export class MysqlDatabaseBackup {
  constructor(private readonly options: MysqlDatabaseBackupOptions) {}

  async create(matchId: string, signal?: AbortSignal): Promise<void> {
    const filePath = mysqlBackupFilePath(this.options.backupDir, matchId);
    const temporary = `${filePath}.${randomUUID()}.partial`;
    await mkdir(path.dirname(filePath), { recursive: true });
    const database = await this.resolveDatabase();
    await this.discard(matchId);
    try {
      signal?.throwIfAborted();
      try {
        await (await this.resolveProcess()).dump(database, temporary, signal);
      } catch (error) {
        if (!signal?.aborted && isEmptyDatabaseDumpError(error, database.database)) {
          await writeFile(temporary, emptyDatabaseDump(database.database), "utf8");
        } else { throw error; }
      }
      signal?.throwIfAborted();
      await rename(temporary, filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async restore(matchId: string, options: { preserveBackup?: boolean } = {}): Promise<void> {
    const filePath = mysqlBackupFilePath(this.options.backupDir, matchId);
    if (!existsSync(filePath)) throw new Error(`mysql backup not found: ${matchId}`);
    await (await this.resolveProcess()).restore(await this.resolveDatabase(), filePath);
    if (options.preserveBackup !== true) {
      await this.discard(matchId);
    }
  }

  async exists(matchId: string): Promise<boolean> {
    return existsSync(mysqlBackupFilePath(this.options.backupDir, matchId));
  }

  async discard(matchId: string): Promise<void> {
    const filePath = mysqlBackupFilePath(this.options.backupDir, matchId);
    await rm(filePath, { force: true });
    const entries = await readdir(this.options.backupDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.startsWith(`${matchId}.sql.`) && entry.endsWith(".partial")) {
        await rm(path.join(this.options.backupDir, entry), { force: true });
      }
    }
  }

  private async resolveDatabase(): Promise<MysqlDatabaseConfig> {
    if (this.options.database) return this.options.database;
    if (!this.options.serverRoot) throw new Error("mysql database config unavailable");

    const configPath = path.join(this.options.serverRoot, "csgo", "addons", "sourcemod", "configs", "databases.cfg");
    const database = parseRankmeDatabaseConfig(await readFile(configPath, "utf8"));
    if (!database) throw new Error("mysql database config unavailable");
    return database;
  }

  private async resolveProcess(): Promise<MysqlBackupProcess> {
    if (this.options.process) return this.options.process;
    return MysqlCliBackupProcess.create();
  }
}

export function mysqlBackupFilePath(backupDir: string, matchId: string): string {
  if (!SAFE_MATCH_ID_PATTERN.test(matchId)) throw new Error(`Unsafe match id: ${matchId}`);
  return path.join(backupDir, `${matchId}.sql`);
}

class MysqlCliBackupProcess implements MysqlBackupProcess {
  private constructor(
    private readonly mysqlPath: string,
    private readonly mysqldumpPath: string,
  ) {}

  static async create(): Promise<MysqlCliBackupProcess> {
    const mysqlPath = await resolveMysqlCliPath();
    if (!mysqlPath) throw new Error("mysql.exe not found");

    const mysqldumpPath = await resolveMysqldumpCliPath(mysqlPath);
    if (!mysqldumpPath) throw new Error("mysqldump.exe not found");

    return new MysqlCliBackupProcess(mysqlPath, mysqldumpPath);
  }

  async dump(database: MysqlDatabaseConfig, filePath: string, signal?: AbortSignal): Promise<void> {
    const child = spawn(this.mysqldumpPath, [
      "--single-transaction",
      "--quick",
      "--routines",
      "--triggers",
      "--events",
      "--add-drop-database",
      "--default-character-set=utf8mb4",
      `--host=${database.host}`,
      `--port=${database.port}`,
      `--user=${database.user}`,
      "--databases",
      database.database,
    ], {
      env: mysqlEnv(database),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });

    const results = await Promise.allSettled([
      pipeline(child.stdout, createWriteStream(filePath)),
      waitForProcess(child, "mysqldump"),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  async restore(database: MysqlDatabaseConfig, filePath: string): Promise<void> {
    const child = spawn(this.mysqlPath, [
      "--default-character-set=utf8mb4",
      `--host=${database.host}`,
      `--port=${database.port}`,
      `--user=${database.user}`,
    ], {
      env: mysqlEnv(database),
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });

    await Promise.all([
      pipeline(createReadStream(filePath), child.stdin),
      waitForProcess(child, "mysql"),
    ]);
  }
}

async function resolveMysqldumpCliPath(mysqlPath: string): Promise<string | null> {
  const candidates: string[] = [];
  const mysqlDir = path.dirname(mysqlPath);
  if (mysqlDir && mysqlDir !== ".") candidates.push(path.join(mysqlDir, "mysqldump.exe"));
  candidates.push("mysqldump.exe");

  for (const candidate of candidates) {
    if (candidate === "mysqldump.exe") {
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

function mysqlEnv(database: MysqlDatabaseConfig): NodeJS.ProcessEnv {
  return { ...process.env, MYSQL_PWD: database.password };
}

function isEmptyDatabaseDumpError(error: unknown, databaseName: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (message.includes("Unknown database") && message.includes(databaseName))
    || message.includes("No tables found");
}

function emptyDatabaseDump(databaseName: string): string {
  const database = quoteMysqlIdentifier(databaseName);
  return [
    `DROP DATABASE IF EXISTS ${database};`,
    `CREATE DATABASE ${database};`,
    `USE ${database};`,
    "",
  ].join("\n");
}

function quoteMysqlIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}

function waitForProcess(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 8192) stderr += chunk.toString("utf8");
  });

  return new Promise((resolve, reject) => {
    let processError: Error | undefined;
    child.on("error", (error) => { processError = error; });
    child.on("close", (code) => {
      if (processError) { reject(processError); return; }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
