import { existsSync, type Dirent } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertPlainPath, type FileFingerprint } from "../shared/managedFiles.js";
import type { GameServerConfig } from "../config/config.js";
import type { RealtimeEventBus } from "../realtime/eventBus.js";
import type { MatchRecordStore } from "../records/matchRecordStore.js";
import { EmptyServerWatchdog, readCurrentStatus, requestSourceModShutdown, type EmptyServerWatchdogConfig } from "./emptyServerWatchdog.js";
import { GameServerPresenceMonitor } from "./gameServerPresenceMonitor.js";
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
import { GameServerStartupExitError, type GameServerExitInfo, type GameServerLauncher, type LaunchedGameServer } from "./gameServerLauncher.js";
import { gameServerRecordKey, type GameServerAttempt } from "./gameServerAttempt.js";
import { inspectLinuxGameProcessIdentity, isGameProcessIdentity, type GameProcessIdentity } from "./linuxProcess.js";
import { installRunCsgoAssets, type RunCsgoSource } from "./runCsgoAssets.js";
import { captureShutdownLogBaseline, collectShutdownEvidence, readGet5FlowAtExit, type Get5FlowAtExit, type ShutdownEvidence, type ShutdownEvidenceCollection, type ShutdownLogHistoryCache } from "./shutdownEvidence.js";
import type { RunCsgoAssetTransaction } from "./runCsgoAssetState.js";
import { legacyRunCsgoFiles } from "./legacyRunCsgoFiles.js";
import { buildRunCsgoLaunchSpec, type RunCsgoLaunchSpec } from "./runCsgoLaunchSpec.js";
import { isSourceServerObservable, waitForSourceServerExit, type SourceServerExitMonitorResult, type SourceServerExitMonitorSpec } from "./sourceServerMonitor.js";
import { delay } from "../shared/async.js";
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
  demos?: import("./matchDemoLifecycle.js").MatchDemoLifecycle;
  assets?: () => Promise<RunCsgoSource>;
  launcher: GameServerLauncher;
  records?: Pick<MatchRecordStore, "saveServer" | "saveStatus" | "appendEvent"> & Partial<Pick<MatchRecordStore, "readServer" | "readShutdownLogBaseline" | "saveShutdownLogBaseline" | "readServerExitObservation" | "saveServerExitObservation" | "gameServerEngineExecPath" | "listGameServerAttemptIds">>;
  events?: Pick<RealtimeEventBus, "publish">;
  config: GameServerConfig;
  onServerExit?: (matchId: string, report: MatchServerExitReport, attempt?: GameServerAttempt) => Promise<void> | void;
  onServerExitReportPending?: (matchId: string, retry: () => Promise<void>, attempt?: GameServerAttempt) => void;
  onGameServerPresence?: (matchId: string, steam64s: readonly string[], attempt?: GameServerAttempt) => Promise<void> | void;
  emptyServerWatchdog?: EmptyServerWatchdogConfig;
  gameServerShutdownTimeoutMs?: number;
  gameServerShutdownPollIntervalMs?: number;
}

export type GameServerShutdownResult = "stopped" | "not_observed" | "timeout" | "not_owned" | "exit_report_pending";

export interface MatchServerExitObservation {
  matchId: string;
  observedAt: string;
  exitInfo: GameServerExitInfo;
}

export class GameServerShutdownRetryError extends AggregateError {}

export class ServerExitObservationPersistenceError extends GameServerShutdownRetryError {
  constructor(errors: unknown[]) {
    super(errors, "Failed to save pending server exit observations");
  }
}

interface PendingServerExitObservation {
  matchId: string;
  attempt?: GameServerAttempt;
  observation: MatchServerExitObservation;
  write?: Promise<MatchServerExitObservation>;
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
const DEFAULT_GAME_SERVER_SHUTDOWN_TIMEOUT_MS = 30_000;
const GAME_SERVER_SHUTDOWN_POLL_INTERVAL_MS = 1_000;
const GAME_SERVER_SHUTDOWN_STARTUP_OBSERVATION_TIMEOUT_MS = 5_000;
const WARMUP_CFG_LINES = [
  WARMUP_CFG_COMMENT,
  "mp_do_warmup_period 1",
  "mp_warmuptime 600",
  "mp_warmuptime_all_players_connected 0",
  "mp_warmup_pausetimer 1",
  "mp_warmup_start",
];

const activeAssetRoots = new Map<string, string>();

async function retryTemporaryServerIo<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 3 || !["EIO", "EAGAIN", "EINTR"].includes(code ?? "")) throw error;
      await delay(100);
    }
  }
}

export class MatchExecutor {
  private readonly gameServerPresenceMonitors = new Map<string, GameServerPresenceMonitor>();
  private readonly emptyServerWatchdogs = new Map<string, EmptyServerWatchdog>();
  private readonly serverExitHandoffs = new Map<string, Promise<void>>();
  private readonly pendingServerExitObservations = new Map<string, PendingServerExitObservation>();
  private readonly pendingControlledShutdowns = new Map<string, { identity: GameProcessIdentity; error: unknown }>();
  private readonly shutdownLogHistory: ShutdownLogHistoryCache = new Map();

  constructor(private readonly options: MatchExecutorOptions) {}

  async prepare(matchPlan: MatchPlan, signal?: AbortSignal, attempt?: GameServerAttempt): Promise<MatchConnectInfo> {
    signal?.throwIfAborted();
    const matchId = validateMatchId(matchPlan.id);
    const gameKey = gameServerRecordKey(matchId, attempt);
    const { serverRoot, portRange, publicConnectHost } = this.options.config;
    const assetRoot = path.resolve(serverRoot).toLowerCase();
    if (activeAssetRoots.has(assetRoot)) throw new Error("asset_game_active");
    activeAssetRoots.set(assetRoot, gameKey);
    let launchedGame = false;
    try {
      await this.prepareShutdownEvidence(matchId, signal, attempt);
      signal?.throwIfAborted();
      await this.options.demos?.prepare({ matchId: gameKey, dev: matchPlan.dev === true });
      const launchScriptFingerprint = await this.writeMatchFiles(matchPlan, gameKey, ACTIVE_MATCH_RUNTIME_CFG_PATH);
      await this.options.records?.saveStatus(matchId, { phase: "server_prepare" });
      await this.options.records?.appendEvent(matchId, { type: "server_preparing", at: new Date().toISOString() });
      this.options.events?.publish({ type: "server_preparing", matchId, accountIds: humanAudience(matchPlan) });

      const marker = attempt && this.options.records?.gameServerEngineExecPath?.(matchId, attempt);
      if (attempt && (!marker || !launchScriptFingerprint)) throw new Error("game_attempt_launch_assets_unavailable");
      const spec = buildRunCsgoLaunchSpec({
        serverRoot, map: matchPlan.map, port: portRange.start, clientPort: portRange.start + 1,
        ...(attempt && marker ? { engineExecMarker: { path: marker, attemptId: gameKey }, launchScriptFingerprint } : {}),
      });

      let launched: LaunchedGameServer;
      signal?.throwIfAborted();
      try { launched = await this.options.launcher.launch(spec); }
      catch (error) {
        const saveOwner = async () => {
          const identity = this.options.launcher.getIdentity?.(serverRoot);
          if (identity) await this.options.records?.saveServer(matchId, { identity, port: spec.port }, attempt);
          await this.bindDemoOwner(gameKey);
        };
        if (attempt && error instanceof GameServerStartupExitError) {
          void this.handoffServerExit(matchId, Promise.resolve(error.exitInfo), attempt, saveOwner)
            .catch(this.serverExitErrorLogger(matchId));
        } else {
          await saveOwner();
        }
        throw error;
      }
      launchedGame = true;
      const watchdog = this.createEmptyServerWatchdog(matchId, attempt);
      this.emptyServerWatchdogs.set(gameKey, watchdog);
      const connect = buildConnectInfo(matchPlan, publicConnectHost, launched.port);
      try {
        await this.bindDemoOwner(gameKey, launched);
        await this.saveConnectState(matchId, launched, connect, attempt);
      } catch (error) {
        this.watchServerExit(matchId, spec, launched, watchdog, undefined, attempt);
        watchdog.start();
        throw error;
      }
      const monitor = this.createGameServerPresenceMonitor(matchId, attempt);
      if (monitor) {
        this.gameServerPresenceMonitors.set(gameKey, monitor);
        monitor.start();
      }
      this.watchServerExit(matchId, spec, launched, watchdog, monitor, attempt);
      watchdog.start();
      return connect;
    } catch (error) {
      if (!launchedGame && !attempt) await this.settleMatchDemos(matchId).catch(() => undefined);
      throw error;
    }
  }

  async getGameServerStatus(): Promise<import("../server/adminStatus.js").AdminGameStatus> {
    const port = this.options.config.portRange.start;
    if (process.platform === "linux") {
      const processModule = await import("./linuxProcess.js");
      const identity = this.options.launcher.getIdentity?.(this.options.config.serverRoot);
      const [processState, portState] = await Promise.all([
        identity ? processModule.probeLinuxGameProcess(identity) : processModule.inspectLinuxGameRoot(this.options.config.serverRoot),
        processModule.inspectLinuxUdpPort(port),
      ]);
      const state = processState === "alive" ? "running" : processState === "gone" && portState === "free" ? "stopped" : "unknown";
      return { state, port, ...(identity && processState === "alive" ? { pid: identity.pid } : {}) };
    }
    const { querySourceServer } = await import("./sourceServerMonitor.js");
    return { state: await querySourceServer("127.0.0.1", port, 500) ? "running" : "unknown", port };
  }

  async stopGameServerPresence(matchId: string, attempt?: GameServerAttempt): Promise<void> {
    const gameKey = gameServerRecordKey(matchId, attempt);
    const monitor = this.gameServerPresenceMonitors.get(gameKey);
    if (monitor) await this.stopGameServerPresenceMonitor(gameKey, monitor);
  }

  async checkPendingGameServerStartup(matchId: string, attempt: GameServerAttempt): Promise<"pending" | "owned" | "reported" | undefined> {
    const { serverRoot } = this.options.config;
    const gameKey = gameServerRecordKey(matchId, attempt);
    const exit = await this.options.launcher.inspectPendingStartupExit?.(serverRoot, gameKey);
    if (!exit || typeof exit === "string") return exit;
    await this.handoffServerExit(matchId, Promise.resolve(exit), attempt, () => this.bindDemoOwner(gameKey));
    return "reported";
  }

  async confirmGameServerExit(matchId: string, attempt: GameServerAttempt): Promise<boolean> {
    if (process.platform !== "linux") return false;
    const { serverRoot, portRange } = this.options.config;
    const root = path.resolve(serverRoot);
    const gameKey = gameServerRecordKey(matchId, attempt);
    const owner = activeAssetRoots.get(root.toLowerCase());
    if (owner && owner !== gameKey) return false;
    const saved = await this.options.records?.readServer?.(matchId, attempt) as { identity?: unknown } | null | undefined;
    const identity = isGameProcessIdentity(saved?.identity) ? saved.identity
      : owner === gameKey ? this.options.launcher.getIdentity?.(root) : undefined;
    if (identity) {
      if (identity.serverRoot !== root) return false;
      const state = await inspectLinuxGameProcessIdentity(identity);
      if (state !== "gone" && state !== "mismatch") return false;
    }
    const { inspectLinuxGameRoot, inspectLinuxUdpPort } = await import("./linuxProcess.js");
    return await inspectLinuxGameRoot(root) === "gone" && await inspectLinuxUdpPort(portRange.start) === "free";
  }

  async requestGameServerShutdown(matchId: string, attempt?: GameServerAttempt): Promise<GameServerShutdownResult> {
    const { serverRoot } = this.options.config;
    const gameKey = gameServerRecordKey(matchId, attempt);
    const owner = activeAssetRoots.get(path.resolve(serverRoot).toLowerCase());
    if (attempt && owner && owner !== gameKey) return "not_owned";
    await this.emptyServerWatchdogs.get(gameKey)?.stopAndDrain();
    if (attempt && await this.checkPendingGameServerStartup(matchId, attempt) === "reported") return "exit_report_pending";
    const { identity, owned } = await retryTemporaryServerIo(async () => {
      const pending = this.pendingControlledShutdowns.get(gameKey);
      let identity = pending?.identity ?? this.options.launcher.getIdentity?.(serverRoot);
      if (!identity) {
        const saved = await this.options.records?.readServer?.(matchId, attempt) as { identity?: unknown } | null | undefined;
        if (isGameProcessIdentity(saved?.identity)) identity = saved.identity;
      }
      const status = await readCurrentStatus(serverRoot, gameKey, { staleAfterMs: 90_000, nowMs: Date.now });
      const processState = identity && await inspectLinuxGameProcessIdentity(identity);
      const trackedLaunch = this.emptyServerWatchdogs.has(gameKey);
      if (processState === "gone" || (processState === "mismatch" && !trackedLaunch)) {
        this.pendingControlledShutdowns.delete(gameKey);
        return { identity: processState === "gone" ? identity : undefined, owned: false };
      }
      const hasMatchEvidence = Boolean(status) || this.gameServerPresenceMonitors.has(gameKey);
      // The watchdog is registered after launch, even if saving connection state fails.
      if (!identity || (!hasMatchEvidence && !trackedLaunch)) {
        // An unavailable ownership check cannot resolve an earlier failed publication.
        if (pending) throw pending.error;
        return { identity, owned: false };
      }
      try {
        if (!hasMatchEvidence || processState !== "alive") {
          const message = hasMatchEvidence ? "Game process ownership could not be verified" : "Waiting for game server match status";
          throw pending?.error ?? Object.assign(new Error(message), { code: "EAGAIN" });
        }
        await requestSourceModShutdown(serverRoot, gameKey, "controlled");
      } catch (error) {
        this.pendingControlledShutdowns.set(gameKey, { identity, error });
        throw error;
      }
      this.pendingControlledShutdowns.delete(gameKey);
      return { identity, owned: true };
    }).catch(error => {
      throw new GameServerShutdownRetryError([error], "Failed to prepare or publish controlled shutdown for " + matchId);
    });
    const timeoutMs = this.options.gameServerShutdownTimeoutMs ?? DEFAULT_GAME_SERVER_SHUTDOWN_TIMEOUT_MS;
    const pollIntervalMs = this.options.gameServerShutdownPollIntervalMs ?? GAME_SERVER_SHUTDOWN_POLL_INTERVAL_MS;
    const result = await this.waitForGameServerShutdown({
      ...(identity ? { identity } : {}),
      serverRoot: this.options.config.serverRoot,
      host: "127.0.0.1",
      port: this.options.config.portRange.start,
      intervalMs: pollIntervalMs,
      queryTimeoutMs: Math.min(750, timeoutMs),
      missedResponsesBeforeExit: 3,
      startupObservationTimeoutMs: GAME_SERVER_SHUTDOWN_STARTUP_OBSERVATION_TIMEOUT_MS,
    });
    if (result === "closed" || result === "not_observed") {
      if (attempt && await this.checkPendingGameServerStartup(matchId, attempt)) return "exit_report_pending";
      try { await this.serverExitHandoffs.get(gameKey); }
      catch { return "exit_report_pending"; }
      return result === "closed" ? "stopped" : "not_observed";
    }
    return owned ? "timeout" : "not_owned";
  }

  async settleMatchDemos(matchId: string, attempt?: GameServerAttempt): Promise<void> {
    const gameKey = gameServerRecordKey(matchId, attempt);
    const root = path.resolve(this.options.config.serverRoot).toLowerCase();
    const owner = activeAssetRoots.get(root);
    if (attempt && owner && owner !== gameKey) throw new Error("asset_game_active");
    const result = await this.options.demos?.settle(gameKey);
    if (result === "blocked") throw Object.assign(new Error("demo_settle_blocked"), { code: "demo_settle_blocked" });
    if (activeAssetRoots.get(root) === gameKey) activeAssetRoots.delete(root);
  }

  async deleteMatchArtifacts(matchId: string, attempt?: GameServerAttempt): Promise<void> {
    await this.settleMatchDemos(matchId, attempt);
    const gameKeys = new Set([gameServerRecordKey(validateMatchId(matchId), attempt)]);
    if (attempt) {
      for (const id of await this.options.records?.listGameServerAttemptIds?.(matchId) ?? []) gameKeys.add(id);
    }
    for (const gameKey of gameKeys) {
      const directory = path.dirname(competMatchStatsPath(this.options.config.serverRoot, gameKey));
      if (attempt) await assertPlainPath(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }

  async readGet5FlowAtExit(matchId: string, attempt: GameServerAttempt): Promise<Get5FlowAtExit> {
    return retryTemporaryServerIo(() =>
      readGet5FlowAtExit(this.options.config.serverRoot, gameServerRecordKey(matchId, attempt)));
  }

  async collectShutdownEvidence(
    matchId: string, attempt?: GameServerAttempt, includeGet5Flow = false, collection?: ShutdownEvidenceCollection,
  ): Promise<ShutdownEvidence> {
    return collectShutdownEvidence(this.options.config.serverRoot, gameServerRecordKey(matchId, attempt),
      async () => this.options.records?.readShutdownLogBaseline?.(matchId, attempt), includeGet5Flow, collection);
  }

  private async prepareShutdownEvidence(matchId: string, signal?: AbortSignal, attempt?: GameServerAttempt): Promise<void> {
    const records = this.options.records;
    if (!records?.readShutdownLogBaseline || !records.saveShutdownLogBaseline) return;
    if (await records.readShutdownLogBaseline(matchId, attempt)) throw new Error("shutdown_log_baseline_already_exists");
    const { serverRoot } = this.options.config;
    if (process.platform === "linux") {
      const { inspectLinuxGameRoot } = await import("./linuxProcess.js");
      if (await inspectLinuxGameRoot(serverRoot) !== "gone") throw new Error("shutdown_log_game_root_busy");
    }
    const gameKey = gameServerRecordKey(matchId, attempt);
    const baseline = await captureShutdownLogBaseline(serverRoot, gameKey, { signal, historyCache: this.shutdownLogHistory });
    signal?.throwIfAborted();
    await records.saveShutdownLogBaseline(matchId, baseline, attempt);
  }

  private async writeMatchFiles(matchPlan: MatchPlan, safeMatchId: string, matchCfgPath: string): Promise<FileFingerprint | undefined> {
    if (!this.options.assets) throw new Error("asset_source_required");
    const source = await this.options.assets();
    const transaction = await installRunCsgoAssets({ sourceRoot: source.root, serverRoot: this.options.config.serverRoot,
      version: source.version, files: source.files, legacyFiles: legacyRunCsgoFiles });
    try {
      await cleanupLegacyManagedMatchFiles(this.options.config.serverRoot);
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
      await ensureBaseCfgLoadsNoRandomBots(this.options.config.serverRoot, transaction);
      await ensureSourceModCfgLoadsActiveMatch(this.options.config.serverRoot, transaction);
      await transaction.commit();
      return source.files.find(file => file.path === "run_csgo.sh");
    } catch (error) { await transaction.rollback(); throw error; }
  }

  private async bindDemoOwner(matchId: string, launched?: LaunchedGameServer): Promise<void> {
    if (!this.options.demos) return;
    const port = launched?.port ?? this.options.config.portRange.start;
    if (process.platform === "linux") {
      const identity = launched?.identity ?? this.options.launcher.getIdentity?.(this.options.config.serverRoot);
      if (identity) await this.options.demos.attachServer(matchId, { platform: "linux", identity, port });
    }
  }

  private async saveConnectState(
    matchId: string, launched: LaunchedGameServer, connect: MatchConnectInfo, attempt?: GameServerAttempt,
  ): Promise<void> {
    await this.options.records?.saveServer(matchId, {
      pid: launched.pid,
      ...(launched.identity ? { identity: launched.identity } : {}),
      port: launched.port,
      clientPort: launched.clientPort,
      connect,
    }, attempt);
    await this.options.records?.saveStatus(matchId, { phase: "connect", connect });
  }

  private watchServerExit(
    matchId: string,
    spec: RunCsgoLaunchSpec,
    launched: LaunchedGameServer,
    watchdog: EmptyServerWatchdog,
    monitor?: GameServerPresenceMonitor,
    attempt?: GameServerAttempt,
  ): void {
    const gameKey = gameServerRecordKey(matchId, attempt);
    const stopMonitors = async () => {
      await watchdog.stopAndDrain();
      if (this.emptyServerWatchdogs.get(gameKey) === watchdog) this.emptyServerWatchdogs.delete(gameKey);
      if (monitor) await this.stopGameServerPresenceMonitor(gameKey, monitor);
    };
    const monitored = spec.serverExitMonitor;
    const exit = spec.exitIndicatesServerExit ? launched.waitForExit() : monitored
      ? waitForSourceServerExit({ ...monitored, onObservation: async () => {
          try { await this.bindDemoOwner(gameKey, launched); }
          catch (error) { this.serverExitErrorLogger(matchId)(error); }
        } }).then(result => ({ code: null, signal: null, output: [formatServerExitMonitorOutput(result, monitored)] }))
      : undefined;
    const logError = this.serverExitErrorLogger(matchId);
    if (exit) void this.handoffServerExit(matchId, exit, attempt, stopMonitors).catch(logError);
    else if (monitor && !this.options.onServerExit) void stopMonitors().catch(logError);
  }

  private serverExitErrorLogger(matchId: string): (error: unknown) => void {
    return error => { process.stderr.write("Server exit cleanup " + matchId + ": " + String(error) + "\n"); };
  }

  private handoffServerExit(
    matchId: string, exit: Promise<GameServerExitInfo>, attempt?: GameServerAttempt, drain?: () => Promise<void>,
  ): Promise<void> {
    const gameKey = gameServerRecordKey(matchId, attempt);
    const active = this.serverExitHandoffs.get(gameKey);
    if (active) return active;
    const onServerExit = this.options.onServerExit;
    const track = (handoff: Promise<void>) => {
      this.serverExitHandoffs.set(gameKey, handoff);
      void handoff.then(() => {
        if (this.serverExitHandoffs.get(gameKey) === handoff) this.serverExitHandoffs.delete(gameKey);
      }, () => undefined);
      return handoff;
    };
    return track(exit.then(async exitInfo => {
      this.pendingControlledShutdowns.delete(gameKey);
      if (!onServerExit) {
        await drain?.();
        await this.settleMatchDemos(matchId, attempt);
        return;
      }
      const pending = { matchId, attempt, observation: { matchId: gameKey, observedAt: new Date().toISOString(), exitInfo } };
      this.pendingServerExitObservations.set(gameKey, pending);
      const submitReport = async () => {
        await drain?.();
        const observation = await this.persistServerExitObservation(pending);
        const report = await this.readObservedServerExitReport(observation);
        // Settlement may await the current prepare promise. Hand off without awaiting it.
        void Promise.resolve(onServerExit(matchId, report, attempt)).catch(this.serverExitErrorLogger(matchId));
      };
      try {
        await submitReport();
      } catch (error) {
        this.options.onServerExitReportPending?.(matchId, () => track(submitReport()), attempt);
        throw error;
      }
    }));
  }

  async waitForServerExitHandoffs(): Promise<ReadonlySet<string>> {
    const deferred = new Set<string>();
    await Promise.all([...this.serverExitHandoffs].map(async ([matchId, handoff]) => {
      try { await handoff; }
      catch { deferred.add(matchId); }
    }));
    return deferred;
  }

  async flushPendingServerExitObservations(): Promise<void> {
    const results = await Promise.allSettled([...this.pendingServerExitObservations.values()].map(async pending => {
      // Give a failed online write a fresh attempt during shutdown.
      await pending.write?.catch(() => undefined);
      await this.persistServerExitObservation(pending);
    }));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new ServerExitObservationPersistenceError(errors);
  }

  private persistServerExitObservation(pending: PendingServerExitObservation): Promise<MatchServerExitObservation> {
    if (!pending.write) {
      const { matchId, attempt, observation } = pending;
      const gameKey = observation.matchId;
      const records = this.options.records;
      pending.write = (async () => {
        const saved = await retryTemporaryServerIo(async () => records?.readServerExitObservation?.(matchId, attempt));
        const checkpoint = saved ?? observation;
        // A failed directory sync can leave a visible file. Confirm a durable write before clearing the pending exit.
        await retryTemporaryServerIo(async () => records?.saveServerExitObservation?.(matchId, checkpoint, attempt));
        if (this.pendingServerExitObservations.get(gameKey) === pending) this.pendingServerExitObservations.delete(gameKey);
        return checkpoint;
      })().catch(error => {
        delete pending.write;
        throw error;
      });
    }
    return pending.write;
  }

  async readObservedServerExitReport(observation: MatchServerExitObservation): Promise<MatchServerExitReport> {
    const { matchId, observedAt, exitInfo } = observation;
    const get5Result = await retryTemporaryServerIo(() =>
      readGet5MatchResult(this.options.config.serverRoot, matchId, observedAt));
    const competReport = await readCompetMatchStatsReport(this.options.config.serverRoot, matchId);
    return {
      exitInfo, get5Result, competStats: competReport.players,
      competHalfScores: extractCompetHalfScores(competReport),
    };
  }

  private createEmptyServerWatchdog(matchId: string, attempt?: GameServerAttempt): EmptyServerWatchdog {
    const records = this.options.records;
    return new EmptyServerWatchdog({
      matchId: gameServerRecordKey(matchId, attempt),
      serverRoot: this.options.config.serverRoot,
      config: this.options.emptyServerWatchdog,
      records: records && { appendEvent: (_gameKey, event) => records.appendEvent(matchId, event) },
    });
  }

  private createGameServerPresenceMonitor(matchId: string, attempt?: GameServerAttempt): GameServerPresenceMonitor | undefined {
    const onChange = this.options.onGameServerPresence;
    if (!onChange) return undefined;
    return new GameServerPresenceMonitor({
      serverRoot: this.options.config.serverRoot,
      matchId: gameServerRecordKey(matchId, attempt),
      onChange: (steam64s) => onChange(matchId, steam64s, attempt),
    });
  }

  private async stopGameServerPresenceMonitor(matchId: string, monitor: GameServerPresenceMonitor): Promise<void> {
    try {
      await monitor.stop();
    } finally {
      if (this.gameServerPresenceMonitors.get(matchId) === monitor) {
        this.gameServerPresenceMonitors.delete(matchId);
      }
    }
  }

  private async waitForGameServerShutdown(spec: SourceServerExitMonitorSpec): Promise<"closed" | "not_observed" | "timeout"> {
    const startedAt = Date.now();
    let observed = false;
    let missedResponses = 0;
    const timeoutMs = this.options.gameServerShutdownTimeoutMs ?? DEFAULT_GAME_SERVER_SHUTDOWN_TIMEOUT_MS;
    const missedResponsesBeforeExit = Math.max(1, spec.missedResponsesBeforeExit);
    const observationBudgetMs = Math.max(1, Math.floor(timeoutMs * 0.8));
    const maxObservationStepMs = Math.max(1, Math.floor(observationBudgetMs / (missedResponsesBeforeExit * 2 - 1)));
    const intervalMs = Math.min(spec.intervalMs, maxObservationStepMs);
    const queryTimeoutMs = Math.min(
      spec.queryTimeoutMs,
      Math.max(1, Math.floor((observationBudgetMs - intervalMs * (missedResponsesBeforeExit - 1)) / missedResponsesBeforeExit)),
    );
    while (Date.now() - startedAt < timeoutMs) {
      const alive = await isSourceServerObservable({ ...spec, queryTimeoutMs });
      if (alive) {
        observed = true;
        missedResponses = 0;
      } else if (observed) {
        missedResponses += 1;
        if (missedResponses >= missedResponsesBeforeExit) return "closed";
      } else if (Date.now() - startedAt >= spec.startupObservationTimeoutMs) {
        return "not_observed";
      }
      await delay(Math.min(intervalMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
    }
    return observed ? "timeout" : "not_observed";
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

async function ensureBaseCfgLoadsNoRandomBots(serverRoot: string, transaction: RunCsgoAssetTransaction): Promise<void> {
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
    if (!await transaction.writeTemplate("csgo/cfg/1.cfg", current, next)) await writeFile(baseCfgFile, next, "utf8");
  }
}

async function ensureSourceModCfgLoadsActiveMatch(serverRoot: string, transaction: RunCsgoAssetTransaction): Promise<void> {
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
    if (!await transaction.writeTemplate("csgo/cfg/sourcemod/sourcemod.cfg", current, next)) await writeFile(sourceModCfgFile, next, "utf8");
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
