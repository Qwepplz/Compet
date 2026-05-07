import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GameServerConfig } from "../config/config.js";
import type { RealtimeEventBus } from "../realtime/eventBus.js";
import type { MatchRecordStore } from "../records/matchRecordStore.js";
import { writeJsonFileAtomic } from "../storage/jsonFile.js";
import { buildGet5Config } from "./get5ConfigBuilder.js";
import type { GameServerExitInfo, GameServerLauncher, LaunchedGameServer } from "./gameServerLauncher.js";
import { buildRunCsgoLaunchSpec, type RunCsgoLaunchSpec } from "./runCsgoLaunchSpec.js";
import { waitForSourceServerExit, type SourceServerExitMonitorResult, type SourceServerExitMonitorSpec } from "./sourceServerMonitor.js";
import type { MatchParticipant, MatchPlan } from "../matchmaking/types.js";

export interface MatchConnectInfo {
  matchId: string;
  connectAddress: string;
  connectPassword: string;
  connectCommand: string;
  connectUrl: string;
  map: string;
}

export interface MatchExecutorOptions {
  launcher: GameServerLauncher;
  records?: Pick<MatchRecordStore, "saveServer" | "saveStatus" | "appendEvent">;
  events?: Pick<RealtimeEventBus, "publish">;
  config: GameServerConfig;
  mapPool?: string[];
  onServerExit?: (matchId: string, exitInfo: GameServerExitInfo) => Promise<void> | void;
}

const ACTIVE_MATCH_CFG_PATH = "compet/active_match.cfg";
const NO_RANDOM_BOTS_CFG_PATH = "compet/no_random_bots.cfg";
const COMPET_LOCK_PLUGIN_FILE = "compet_match_lock.smx";
const COMPET_LOCK_SOURCE_FILE = "compet_match_lock.sp";
const GET5_AUTOLOAD_COMMENT = "// Compet managed get5 autoload";

export class MatchExecutor {
  constructor(private readonly options: MatchExecutorOptions) {}

  async prepare(matchPlan: MatchPlan): Promise<MatchConnectInfo> {
    const safeMatchId = validateMatchId(matchPlan.id);
    const matchCfgPath = `compet/${safeMatchId}.cfg`;

    await this.writeMatchFiles(matchPlan, safeMatchId, matchCfgPath);
    await this.options.records?.saveStatus(matchPlan.id, { phase: "server_prepare" });
    await this.options.records?.appendEvent(matchPlan.id, { type: "server_preparing", at: new Date().toISOString() });
    this.options.events?.publish({ type: "server_preparing", matchId: matchPlan.id, accountIds: humanAudience(matchPlan) });

    const spec = buildRunCsgoLaunchSpec({
      serverRoot: this.options.config.serverRoot,
      map: matchPlan.map,
      port: this.options.config.portRange.start,
      clientPort: this.options.config.portRange.start + 1,
      serverPassword: matchPlan.connectPassword,
      startupCfgPath: ACTIVE_MATCH_CFG_PATH,
    });

    const launched = await this.options.launcher.launch(spec);
    this.watchServerExit(matchPlan.id, spec, launched);
    const connect = buildConnectInfo(matchPlan, this.options.config.publicConnectHost, launched.port);
    await this.saveConnectState(matchPlan.id, launched, connect);
    return connect;
  }

  private async writeMatchFiles(matchPlan: MatchPlan, safeMatchId: string, matchCfgPath: string): Promise<void> {
    const get5Config = buildGet5Config({
      matchPlan,
      mapPool: this.options.mapPool ?? [matchPlan.map],
    });
    await writeJsonFileAtomic(
      path.join(this.options.config.serverRoot, "csgo", "cfg", "get5", `${safeMatchId}.json`),
      get5Config,
    );
    await removeGet5AutoloadCfg(this.options.config.serverRoot);
    await installCompetLockPlugin(this.options.config.serverRoot);
    const noRandomBotsCfgFile = path.join(this.options.config.serverRoot, "csgo", "cfg", NO_RANDOM_BOTS_CFG_PATH);
    await mkdir(path.dirname(noRandomBotsCfgFile), { recursive: true });
    await writeFile(noRandomBotsCfgFile, `${buildNoRandomBotsCfg()}\n`, "utf8");
    const matchCfgFile = path.join(this.options.config.serverRoot, "csgo", "cfg", matchCfgPath);
    await mkdir(path.dirname(matchCfgFile), { recursive: true });
    await writeFile(matchCfgFile, `${buildMatchStartupCfg(matchPlan, safeMatchId)}\n`, "utf8");
    const activeCfgFile = path.join(this.options.config.serverRoot, "csgo", "cfg", ACTIVE_MATCH_CFG_PATH);
    await writeFile(activeCfgFile, `exec ${matchCfgPath}\n`, "utf8");
    await ensureBaseCfgLoadsNoRandomBots(this.options.config.serverRoot);
    await ensureSourceModCfgLoadsActiveMatch(this.options.config.serverRoot);
  }

  private async saveConnectState(matchId: string, launched: LaunchedGameServer, connect: MatchConnectInfo): Promise<void> {
    await this.options.records?.saveServer(matchId, {
      pid: launched.pid,
      port: launched.port,
      clientPort: launched.clientPort,
      connect,
    });
    await this.options.records?.saveStatus(matchId, { phase: "connect", connect });
  }

  private watchServerExit(matchId: string, spec: RunCsgoLaunchSpec, launched: LaunchedGameServer): void {
    if (!this.options.onServerExit) return;

    if (spec.exitIndicatesServerExit) {
      void launched.waitForExit()
        .then((exitInfo) => this.publishServerExit(matchId, exitInfo))
        .catch(() => undefined);
    }

    if (spec.serverExitMonitor) {
      void waitForSourceServerExit(spec.serverExitMonitor)
        .then((result) => {
          this.publishServerExit(matchId, {
            code: null,
            signal: null,
            output: [formatServerExitMonitorOutput(result, spec.serverExitMonitor)],
          });
        })
        .catch(() => undefined);
    }
  }

  private publishServerExit(matchId: string, exitInfo: GameServerExitInfo): void {
    setTimeout(() => {
      void Promise.resolve(this.options.onServerExit?.(matchId, exitInfo)).catch(() => undefined);
    }, 0);
  }
}

function formatServerExitMonitorOutput(
  result: SourceServerExitMonitorResult,
  spec: SourceServerExitMonitorSpec | undefined,
): string {
  const address = `${spec?.host ?? "unknown"}:${spec?.port ?? "unknown"}`;
  return result === "closed"
    ? `Source server stopped responding or released UDP port ${address}`
    : `Source server was not observed on UDP port ${address}`;
}

function buildMatchStartupCfg(matchPlan: MatchPlan, safeMatchId: string): string {
  return [
    `sv_password ${quoteConsoleString(matchPlan.connectPassword)}`,
    ...buildTeamNameCommands(matchPlan),
    `compet_lock_reset ${quoteConsoleString(safeMatchId)}`,
    ...buildCompetLockCommands(matchPlan),
    "compet_lock_enable 1",
    ...buildBotAddCommands(matchPlan),
  ].join("\n");
}

function buildTeamNameCommands(matchPlan: MatchPlan): string[] {
  const ctTeam = [matchPlan.teamA, matchPlan.teamB].find((team) => team.gameSide === "ct");
  const tTeam = [matchPlan.teamA, matchPlan.teamB].find((team) => team.gameSide === "t");
  return [
    `mp_teamname_1 ${quoteConsoleString(ctTeam?.name ?? "")}`,
    `mp_teamname_2 ${quoteConsoleString(tTeam?.name ?? "")}`,
  ];
}

function buildCompetLockCommands(matchPlan: MatchPlan): string[] {
  return [matchPlan.teamA, matchPlan.teamB].flatMap((team) =>
    team.participants.filter(isHumanWithSteam64).map((participant) =>
      `compet_lock_add ${quoteConsoleString(participant.steam64?.trim() ?? "")} ${quoteConsoleString(team.gameSide)}`,
    ),
  );
}

async function installCompetLockPlugin(serverRoot: string): Promise<void> {
  const pluginSource = findBundledSourceModAsset(COMPET_LOCK_PLUGIN_FILE);
  if (!pluginSource) throw new Error(`Missing bundled SourceMod plugin: ${COMPET_LOCK_PLUGIN_FILE}`);

  const pluginDir = path.join(serverRoot, "csgo", "addons", "sourcemod", "plugins");
  await mkdir(pluginDir, { recursive: true });
  await copyFile(pluginSource, path.join(pluginDir, COMPET_LOCK_PLUGIN_FILE));

  const sourceFile = findBundledSourceModAsset(COMPET_LOCK_SOURCE_FILE);
  if (sourceFile) {
    const scriptDir = path.join(serverRoot, "csgo", "addons", "sourcemod", "scripting");
    await mkdir(scriptDir, { recursive: true });
    await copyFile(sourceFile, path.join(scriptDir, COMPET_LOCK_SOURCE_FILE));
  }
}

async function removeGet5AutoloadCfg(serverRoot: string): Promise<void> {
  const cfgFile = path.join(serverRoot, "csgo", "cfg", "sourcemod", "get5.cfg");
  await mkdir(path.dirname(cfgFile), { recursive: true });
  let current = "";
  try {
    current = await readFile(cfgFile, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const lines = current.length > 0 ? current.split(/\r?\n/) : [];
  const nextLines: string[] = [];
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === GET5_AUTOLOAD_COMMENT) {
      const nextLine = lines[index + 1]?.trim() ?? "";
      if (nextLine.startsWith("get5_autoload_config ")) {
        index += 1;
      }
      changed = true;
      continue;
    }
    nextLines.push(lines[index]);
  }
  if (changed) {
    await writeFile(cfgFile, `${nextLines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
  }
}

function findBundledSourceModAsset(fileName: string): string | undefined {
  const candidates = [
    path.join(process.cwd(), "sourcemod", fileName),
    path.join(process.cwd(), "src", "sourcemod", fileName),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function buildNoRandomBotsCfg(): string {
  return [
    "mp_autoteambalance 0",
    "mp_limitteams 0",
    "bot_join_after_player 0",
    "bot_quota_mode normal",
    "bot_quota 0",
  ].join("\n");
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1].trim() === "") {
    next.pop();
  }
  return next;
}

function appendManagedLines(lines: string[], managedLines: string[]): void {
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(...managedLines);
}

async function ensureBaseCfgLoadsNoRandomBots(serverRoot: string): Promise<void> {
  const baseCfgFile = path.join(serverRoot, "csgo", "cfg", "1.cfg");
  await mkdir(path.dirname(baseCfgFile), { recursive: true });
  let current = "";
  try {
    current = await readFile(baseCfgFile, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const noRandomBotsHook = `exec ${NO_RANDOM_BOTS_CFG_PATH}`;
  const activeMatchHook = `exec ${ACTIVE_MATCH_CFG_PATH}`;
  const activeMatchComment = "// Compet managed match cfg hook";
  const noRandomBotsComment = "// Compet managed no random bot hook";

  const lines = current.length > 0 ? current.split(/\r?\n/) : [];
  const nextLines = trimTrailingBlankLines(lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== activeMatchComment && trimmed !== activeMatchHook;
  }));

  if (!nextLines.some((line) => line.trim() === noRandomBotsHook)) {
    appendManagedLines(nextLines, [noRandomBotsComment, noRandomBotsHook]);
  }

  const next = nextLines.join("\n").replace(/\n*$/, "\n");
  if (next !== current) {
    await writeFile(baseCfgFile, next, "utf8");
  }
}

async function ensureSourceModCfgLoadsActiveMatch(serverRoot: string): Promise<void> {
  const sourceModCfgFile = path.join(serverRoot, "csgo", "cfg", "sourcemod", "sourcemod.cfg");
  await mkdir(path.dirname(sourceModCfgFile), { recursive: true });
  let current = "";
  try {
    current = await readFile(sourceModCfgFile, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const activeMatchHook = `exec ${ACTIVE_MATCH_CFG_PATH}`;
  const activeMatchComment = "// Compet managed match cfg hook";
  const noRandomBotsHook = `exec ${NO_RANDOM_BOTS_CFG_PATH}`;
  const noRandomBotsComment = "// Compet managed no random bot hook";
  const lines = current.length > 0 ? current.split(/\r?\n/) : [];
  const nextLines = trimTrailingBlankLines(lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== activeMatchComment
      && trimmed !== activeMatchHook
      && trimmed !== noRandomBotsComment
      && trimmed !== noRandomBotsHook;
  }));
  appendManagedLines(nextLines, [
    noRandomBotsComment,
    noRandomBotsHook,
    activeMatchComment,
    activeMatchHook,
  ]);

  const next = nextLines.join("\n").replace(/\n*$/, "\n");
  if (next !== current) {
    await writeFile(sourceModCfgFile, next, "utf8");
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function buildConnectInfo(matchPlan: MatchPlan, host: string, port: number): MatchConnectInfo {
  const connectAddress = `${host}:${port}`;

  return {
    matchId: matchPlan.id,
    connectAddress,
    connectPassword: matchPlan.connectPassword,
    connectCommand: `password ${quoteConsoleString(matchPlan.connectPassword)}; connect ${connectAddress}`,
    connectUrl: `steam://connect/${connectAddress}/${encodeURIComponent(matchPlan.connectPassword)}`,
    map: matchPlan.map,
  };
}

function buildBotAddCommands(matchPlan: MatchPlan): string[] {
  const addCommands = [matchPlan.teamA, matchPlan.teamB].flatMap((team) =>
    team.participants.filter(isBot).map((participant) => {
      const command = team.gameSide === "t" ? "bot_add_t" : "bot_add_ct";
      return `${command} ${quoteConsoleString(resolveBotName(participant))}`;
    }),
  );

  return addCommands;
}

function humanAudience(matchPlan: MatchPlan): string[] {
  return [matchPlan.teamA, matchPlan.teamB].flatMap((team) =>
    team.participants.flatMap((participant) => (participant.kind === "human" && participant.accountId ? [participant.accountId] : [])),
  );
}

function isBot(participant: MatchParticipant): boolean {
  return participant.kind === "bot";
}

function isHumanWithSteam64(participant: MatchParticipant): boolean {
  return participant.kind === "human" && Boolean(participant.steam64?.trim());
}

function resolveBotName(participant: MatchParticipant): string {
  return participant.botProfileName || participant.displayName;
}

function validateMatchId(matchId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(matchId)) {
    throw new Error("Match id may only contain letters, numbers, underscores, and hyphens");
  }
  return matchId;
}

function quoteConsoleString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
