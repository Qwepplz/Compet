import { existsSync, type Dirent } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GameServerConfig } from "../config/config.js";
import type { RealtimeEventBus } from "../realtime/eventBus.js";
import type { MatchRecordStore } from "../records/matchRecordStore.js";
import { EmptyServerWatchdog, type EmptyServerWatchdogConfig } from "./emptyServerWatchdog.js";
import {
  competMatchStatsPath,
  readCompetMatchStatsReport,
  type CompetMatchHalfScores,
  type CompetMatchPlayerStats,
} from "./competMatchStats.js";
import {
  get5MatchStatsRelativePath,
  get5MatchStatsPath,
  readGet5MatchResult,
  type Get5MatchResultClassification,
} from "./get5MatchResult.js";
import type { GameServerExitInfo, GameServerLauncher, LaunchedGameServer } from "./gameServerLauncher.js";
import { installRunCsgoAssets } from "./runCsgoAssets.js";
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
  onServerExit?: (matchId: string, report: MatchServerExitReport) => Promise<void> | void;
  emptyServerWatchdog?: EmptyServerWatchdogConfig;
}

export interface MatchServerExitReport {
  exitInfo: GameServerExitInfo;
  get5Result: Get5MatchResultClassification;
  competStats: CompetMatchPlayerStats[];
  competHalfScores?: CompetMatchHalfScores;
}

const ACTIVE_MATCH_CFG_PATH = "compet/active_match.cfg";
const ACTIVE_MATCH_RUNTIME_CFG_PATH = "compet/active_match_runtime.cfg";
const NO_RANDOM_BOTS_CFG_PATH = "compet/no_random_bots.cfg";
const LEGACY_GET5_CONFIG_FILE = "compet_active.json";
const COMPET_LOCK_PLUGIN_FILE = "compet_match_lock.smx";
const GET5_AUTOLOAD_COMMENT = "// Compet managed get5 autoload";
const WARMUP_CFG_COMMENT = "// Compet managed warmup hook";
const TEAMLOGO_CFG_COMMENT = "// Compet managed team logo hook";
const TEAMLOGO_CFG_LINES = [
  TEAMLOGO_CFG_COMMENT,
  "teamlogo_randomlogos 0",
  "teamlogo_teamnames 0",
];
const WARMUP_CFG_LINES = [
  WARMUP_CFG_COMMENT,
  "mp_do_warmup_period 1",
  "mp_warmuptime 600",
  "mp_warmuptime_all_players_connected 0",
  "mp_warmup_pausetimer 1",
  "mp_warmup_start",
];

export class MatchExecutor {
  constructor(private readonly options: MatchExecutorOptions) {}

  async prepare(matchPlan: MatchPlan): Promise<MatchConnectInfo> {
    const safeMatchId = validateMatchId(matchPlan.id);
    const matchCfgPath = ACTIVE_MATCH_RUNTIME_CFG_PATH;

    await this.writeMatchFiles(matchPlan, safeMatchId, matchCfgPath);
    await this.options.records?.saveStatus(matchPlan.id, { phase: "server_prepare" });
    await this.options.records?.appendEvent(matchPlan.id, { type: "server_preparing", at: new Date().toISOString() });
    this.options.events?.publish({ type: "server_preparing", matchId: matchPlan.id, accountIds: humanAudience(matchPlan) });

    const spec = buildRunCsgoLaunchSpec({
      serverRoot: this.options.config.serverRoot,
      map: matchPlan.map,
      port: this.options.config.portRange.start,
      clientPort: this.options.config.portRange.start + 1,
    });

    const launched = await this.options.launcher.launch(spec);
    const emptyServerWatchdog = this.createEmptyServerWatchdog(matchPlan.id);
    this.watchServerExit(matchPlan.id, spec, launched, emptyServerWatchdog);
    const connect = buildConnectInfo(matchPlan, this.options.config.publicConnectHost, launched.port);
    await this.saveConnectState(matchPlan.id, launched, connect);
    emptyServerWatchdog.start();
    return connect;
  }

  async deleteMatchArtifacts(matchId: string): Promise<void> {
    const safeMatchId = validateMatchId(matchId);
    await rm(path.dirname(competMatchStatsPath(this.options.config.serverRoot, safeMatchId)), { recursive: true, force: true });
  }

  private async writeMatchFiles(matchPlan: MatchPlan, safeMatchId: string, matchCfgPath: string): Promise<void> {
    await cleanupLegacyManagedMatchFiles(this.options.config.serverRoot);
    await installRunCsgoAssets(this.options.config.serverRoot);
    await cleanupGet5MatchStatsFiles(this.options.config.serverRoot);
    const get5StatsPath = get5MatchStatsPath(this.options.config.serverRoot, safeMatchId);
    await mkdir(path.dirname(get5StatsPath), { recursive: true });
    await unlinkIfExists(get5StatsPath);
    await unlinkIfExists(competMatchStatsPath(this.options.config.serverRoot, safeMatchId));
    await removeGet5AutoloadCfg(this.options.config.serverRoot);
    await installCompetLockPlugin(this.options.config.serverRoot);
    const noRandomBotsCfgFile = path.join(this.options.config.serverRoot, "csgo", "cfg", NO_RANDOM_BOTS_CFG_PATH);
    await mkdir(path.dirname(noRandomBotsCfgFile), { recursive: true });
    await writeFile(noRandomBotsCfgFile, `${buildNoRandomBotsCfg()}\n`, "utf8");
    const matchCfgFile = path.join(this.options.config.serverRoot, "csgo", "cfg", matchCfgPath);
    await mkdir(path.dirname(matchCfgFile), { recursive: true });
    await writeFile(matchCfgFile, `${buildMatchStartupCfg(matchPlan, safeMatchId)}\n`, "utf8");
    const activeCfgFile = path.join(this.options.config.serverRoot, "csgo", "cfg", ACTIVE_MATCH_CFG_PATH);
    await mkdir(path.dirname(activeCfgFile), { recursive: true });
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

  private watchServerExit(
    matchId: string,
    spec: RunCsgoLaunchSpec,
    launched: LaunchedGameServer,
    emptyServerWatchdog: EmptyServerWatchdog,
  ): void {
    const publishExit = (exitInfo: GameServerExitInfo) => {
      emptyServerWatchdog.stop();
      this.publishServerExit(matchId, exitInfo);
    };

    if (!this.options.onServerExit) {
      if (spec.exitIndicatesServerExit) {
        void launched.waitForExit()
          .then(() => emptyServerWatchdog.stop())
          .catch(() => undefined);
      }
      return;
    }

    if (spec.exitIndicatesServerExit) {
      void launched.waitForExit()
        .then((exitInfo) => publishExit(exitInfo))
        .catch(() => undefined);
    }

    if (spec.serverExitMonitor) {
      void waitForSourceServerExit(spec.serverExitMonitor)
        .then((result) => {
          publishExit({
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
      void Promise.all([
        readGet5MatchResult(this.options.config.serverRoot, matchId, new Date().toISOString()),
        readCompetMatchStatsReport(this.options.config.serverRoot, matchId),
      ])
        .then(([get5Result, competReport]) => this.options.onServerExit?.(matchId, {
          exitInfo,
          get5Result,
          competStats: competReport.players,
          competHalfScores: extractCompetHalfScores(competReport),
        }))
        .catch(() => undefined);
    }, 0);
  }

  private createEmptyServerWatchdog(matchId: string): EmptyServerWatchdog {
    return new EmptyServerWatchdog({
      matchId,
      serverRoot: this.options.config.serverRoot,
      config: this.options.emptyServerWatchdog,
      records: this.options.records,
    });
  }
}

function extractCompetHalfScores(report: CompetMatchHalfScores): CompetMatchHalfScores | undefined {
  const halfScores = {
    ...(report.firstHalfScore ? { firstHalfScore: report.firstHalfScore } : {}),
    ...(report.secondHalfScore ? { secondHalfScore: report.secondHalfScore } : {}),
  };
  return halfScores.firstHalfScore || halfScores.secondHalfScore ? halfScores : undefined;
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
    `get5_stats_path_format ${quoteConsoleString(get5MatchStatsRelativePath(safeMatchId))}`,
    ...TEAMLOGO_CFG_LINES.slice(1),
    ...buildTeamNameCommands(matchPlan),
    ...buildTeamLogoCommands(matchPlan),
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

function buildTeamLogoCommands(matchPlan: MatchPlan): string[] {
  const ctTeam = [matchPlan.teamA, matchPlan.teamB].find((team) => team.gameSide === "ct");
  const tTeam = [matchPlan.teamA, matchPlan.teamB].find((team) => team.gameSide === "t");
  return [
    ctTeam?.logo ? `mp_teamlogo_1 ${ctTeam.logo}` : `mp_teamlogo_1 ${quoteConsoleString("")}`,
    tTeam?.logo ? `mp_teamlogo_2 ${tTeam.logo}` : `mp_teamlogo_2 ${quoteConsoleString("")}`,
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

async function cleanupLegacyManagedMatchFiles(serverRoot: string): Promise<void> {
  await Promise.all([
    cleanupLegacyGet5Configs(path.join(serverRoot, "csgo", "cfg", "get5")),
    cleanupLegacyCompetCfgs(path.join(serverRoot, "csgo", "cfg", "compet")),
  ]);
}

async function cleanupGet5MatchStatsFiles(serverRoot: string): Promise<void> {
  const csgoRoot = path.join(serverRoot, "csgo");
  let entries: Dirent[];
  try {
    entries = await readdir(csgoRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }

  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^get5_matchstats_.*\.cfg$/i.test(entry.name))
    .map((entry) => unlinkIfExists(path.join(csgoRoot, entry.name))));
}

async function cleanupLegacyGet5Configs(get5Dir: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(get5Dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }

  await unlinkIfExists(path.join(get5Dir, LEGACY_GET5_CONFIG_FILE));
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) return;
    const matchId = entry.name.slice(0, -".json".length);
    if (!isValidMatchFileStem(matchId)) return;
    const filePath = path.join(get5Dir, entry.name);
    if (await isLegacyCompetGet5Config(filePath, matchId)) {
      await unlinkIfExists(filePath);
    }
  }));
}

async function cleanupLegacyCompetCfgs(competDir: string): Promise<void> {
  const activeFileNames = new Set([
    path.basename(ACTIVE_MATCH_CFG_PATH),
    path.basename(ACTIVE_MATCH_RUNTIME_CFG_PATH),
    path.basename(NO_RANDOM_BOTS_CFG_PATH),
  ]);
  let entries: Dirent[];
  try {
    entries = await readdir(competDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".cfg") || activeFileNames.has(entry.name)) return;
    const matchId = entry.name.slice(0, -".cfg".length);
    if (!isValidMatchFileStem(matchId)) return;
    const filePath = path.join(competDir, entry.name);
    if (await isLegacyCompetMatchCfg(filePath, matchId)) {
      await unlinkIfExists(filePath);
    }
  }));
}

async function isLegacyCompetGet5Config(filePath: string, matchId: string): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return false;
  }

  if (!isRecord(value)) return false;
  const cvars = value.cvars;
  return value.matchid === matchId
    && value.players_per_team === 5
    && value.num_maps === 1
    && value.skip_veto === true
    && Array.isArray(value.maplist)
    && Array.isArray(value.map_sides)
    && isRecord(value.team1)
    && isRecord(value.team2)
    && isRecord(cvars)
    && cvars.mp_autoteambalance === "0"
    && cvars.mp_limitteams === "0"
    && cvars.tv_enable === "1";
}

async function isLegacyCompetMatchCfg(filePath: string, matchId: string): Promise<boolean> {
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }

  const lines = content.split(/\r?\n/);
  return lines.some((line) => line.trim() === `compet_lock_reset ${quoteConsoleString(matchId)}`)
    && lines.some((line) => line.trim() === "compet_lock_enable 1");
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isValidMatchFileStem(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findBundledSourceModAsset(fileName: string): string | undefined {
  const candidates = buildSourceModAssetCandidates(fileName);
  return candidates.find((candidate) => existsSync(candidate));
}

function buildSourceModAssetCandidates(fileName: string): string[] {
  const cjsModuleDir = typeof __dirname === "string" ? __dirname : undefined;
  const baseDirs = [
    process.cwd(),
    process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : undefined,
    cjsModuleDir,
  ];
  const candidates: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (candidate: string): void => {
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  for (const baseDir of baseDirs) {
    if (!baseDir) continue;
    for (const dir of getAncestorDirs(path.resolve(baseDir))) {
      addCandidate(path.join(dir, "sourcemod", fileName));
      addCandidate(path.join(dir, "src", "sourcemod", fileName));
    }
  }

  return candidates;
}

function getAncestorDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let current = startDir;
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
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
  const managedTeamLogoLines = new Set(TEAMLOGO_CFG_LINES);
  const lines = current.length > 0 ? current.split(/\r?\n/) : [];
  const nextLines = trimTrailingBlankLines(lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== activeMatchComment
      && trimmed !== activeMatchHook
      && trimmed !== noRandomBotsComment
      && trimmed !== noRandomBotsHook
      && !isManagedWarmupLine(trimmed)
      && !managedTeamLogoLines.has(trimmed)
      && !trimmed.startsWith("teamlogo_randomlogos ")
      && !trimmed.startsWith("teamlogo_teamnames ");
  }));
  appendManagedLines(nextLines, [
    ...WARMUP_CFG_LINES,
    ...TEAMLOGO_CFG_LINES,
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

function isManagedWarmupLine(line: string): boolean {
  return line === WARMUP_CFG_COMMENT
    || line.startsWith("mp_do_warmup_period ")
    || line.startsWith("mp_warmuptime ")
    || line.startsWith("mp_warmuptime_all_players_connected ")
    || line.startsWith("mp_warmup_pausetimer ")
    || line === "mp_warmup_start";
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
