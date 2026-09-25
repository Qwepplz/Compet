import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AccountService } from "../accounts/accountService.js";
import { AccountRepository } from "../accounts/accountRepository.js";
import { AuthService } from "../auth/authService.js";
import { InMemoryLoginRateLimiter } from "../auth/rateLimiter.js";
import { SessionRepository } from "../auth/sessionRepository.js";
import { SessionService } from "../auth/sessionService.js";
import { bootstrapAdmin } from "../bootstrap/bootstrapAdmin.js";
import { loadBotCatalog, type BotCatalog } from "../bots/botCatalog.js";
import type { ServerConfig } from "../config/config.js";
import { FriendService } from "../friends/friendService.js";
import { FriendStore } from "../friends/friendStore.js";
import { MatchExecutor } from "../game/matchExecutor.js";
import { NodeGameServerLauncher } from "../game/gameServerLauncher.js";
import { MysqlDatabaseBackup } from "../game/mysqlDatabaseBackup.js";
import { MatchmakingService, type ServiceShutdownSummary } from "../matchmaking/matchmakingService.js";
import { MatchmakingStore } from "../matchmaking/matchmakingStore.js";
import { PresenceService } from "../presence/presenceService.js";
import { ServerSteamPersonaDirectory } from "../profiles/serverSteamPersonaDirectory.js";
import { RankmeScoreStore, type RankmeScoreReader } from "../rankme/rankmeScoreStore.js";
import { RealtimeEventBus } from "../realtime/eventBus.js";
import { MatchRecordStore } from "../records/matchRecordStore.js";
import { openCompetDatabase } from "../storage/competDatabase.js";
import { ensureServerCertificate } from "../tls/certificateService.js";
import { writeActivityLog } from "./activityLogger.js";
import { createServer } from "./createServer.js";
import { createOfflineCleanupScheduler } from "./offlineCleanup.js";

export interface Runtime {
  app: Awaited<ReturnType<typeof createServer>>;
  close(reason: string): Promise<ServiceShutdownSummary>;
  accounts: AccountService;
  sessions: SessionService;
  auth: AuthService;
  friends: FriendService;
  matchmaking: MatchmakingService;
  events: RealtimeEventBus;
  records: MatchRecordStore;
}

const DEFAULT_OFFLINE_CLEANUP_GRACE_MS = 15_000;

export async function createRuntime(config: ServerConfig): Promise<Runtime> {
  const recordsDir = path.join(config.dataDir, "records");
  await mkdir(recordsDir, { recursive: true });
  const database = await openCompetDatabase(recordsDir, {
    maintenance: {
      now: new Date().toISOString(),
      retentionDays: 30,
      maxDeleteRows: 5000,
    },
  });

  try {
    const certificate = await ensureServerCertificate(path.join(config.dataDir, "certs"));
    const accounts = new AccountService(new AccountRepository(database));
    const sessions = new SessionService(
      new SessionRepository(database),
      config.tokenTtlMinutes,
    );

    await sessions.revokePlayerSessions();
    await bootstrapAdmin(accounts, path.join(config.dataDir, "bootstrap-admin.json"));

    const records = new MatchRecordStore(recordsDir, database);
    const databaseBackup = new MysqlDatabaseBackup({
      serverRoot: config.gameServer.serverRoot,
      backupDir: path.join(recordsDir, "mysql-backups"),
    });
    const rankme: RankmeScoreReader = await RankmeScoreStore.create(config.gameServer.serverRoot) ?? {
      getScoreBySteam64: async () => null,
      lookupScoreBySteam64: async () => ({ status: "unavailable" as const }),
      lookupStandingBySteam64: async () => ({ status: "unavailable" as const }),
      lookupStandingByBotName: async () => ({ status: "unavailable" as const }),
    };
    const events = new RealtimeEventBus();
    const presence = new PresenceService();
    for (const [accountId, lastSeenAt] of await sessions.listLatestLastSeenByAccount()) {
      presence.seedLastSeen(accountId, lastSeenAt);
    }
    const friends = new FriendService({
      store: new FriendStore(database),
      accounts,
      presence,
      events,
      rankme,
    });
    const steamPersonas = await ServerSteamPersonaDirectory.create({
      baseUrl: config.profileBaseUrl,
      seedPath: path.join(process.cwd(), "runtime", "profiles", "human-index.json"),
      cachePath: path.join(recordsDir, "profiles", "human-index.json"),
      onLog: (message) => writeActivityLog({ source: "server", level: "info", message: `Steam profile directory: ${message}` }),
    });
    const gameStdoutHandler = (chunk: string) => {
      process.stdout.write(chunk);
    };
    let matchmaking: MatchmakingService | undefined;
    const executor = new MatchExecutor({
      launcher: new NodeGameServerLauncher({
        onStdout: gameStdoutHandler,
        onStderr: (chunk) => process.stderr.write(chunk),
      }),
      records,
      config: config.gameServer,
      onServerExit: (matchId, report) => {
        void matchmaking?.completeMatchFromServerExit(matchId, report).catch((error) => {
          process.stderr.write(`Failed to complete match after srcds exit: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      },
      onGameServerPresence: (matchId, steam64s) => matchmaking?.updateGameServerPresence(matchId, steam64s),
    });
    const botCatalog = await loadRuntimeBotCatalog(config.gameServer.serverRoot);
    const matchmakingService = new MatchmakingService({
      store: await MatchmakingStore.create(path.join(recordsDir, "matchmaking")),
      accounts,
      friends,
      botCatalog,
      executor,
      databaseBackup,
      records,
      rankme,
      events,
      steamPersonas,
      presence,
    });
    await matchmakingService.recoverCompletedMatches();
    matchmaking = matchmakingService;
    await matchmakingService.recoverInterruptedMatches();
    await matchmakingService.resumePendingTimeouts();
    const offlineCleanupScheduler = createOfflineCleanupScheduler({
      presence,
      matchmaking: {
        isMatchmakingParticipant: (accountId) => matchmakingService.isMatchmakingParticipant(accountId),
        handleAccountOffline: (accountId, shouldContinue) => (
          matchmakingService.handleAccountOffline(accountId, undefined, shouldContinue)
        ),
      },
      friends,
      graceMs: resolveOfflineCleanupGraceMs(),
      onError: (accountId, operation, error) => {
        process.stderr.write(
          `Offline cleanup ${operation} failed for ${accountId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    });
    const unsubscribePresence = events.subscribe((event) => {
      if (event.type === "presence_updated") {
        offlineCleanupScheduler.onPresenceUpdated(event.accountId, event.online);
      }
    });
    let offlineCleanupClosed = false;
    const closeOfflineCleanup = () => {
      if (offlineCleanupClosed) return;
      offlineCleanupClosed = true;
      unsubscribePresence();
      offlineCleanupScheduler.close();
    };

    const auth = new AuthService(accounts, sessions, new InMemoryLoginRateLimiter());
    const app = await createServer({
      accounts,
      sessions,
      auth,
      friends,
      matchmaking: matchmakingService,
      records,
      rankme,
      events,
      presence,
      https: { key: certificate.keyPem, cert: certificate.certPem },
    });
    app.addHook("onClose", async () => {
      closeOfflineCleanup();
      const errors: unknown[] = [];
      try { await matchmakingService.stopBackgroundTasks(); }
      catch (error) { errors.push(error); }
      try { await sessions.revokePlayerSessions(); }
      catch (error) { errors.push(error); }
      try { database.close(); }
      catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Service close failed");
    });

    let closePromise: Promise<ServiceShutdownSummary> | undefined;
    const close = (reason: string): Promise<ServiceShutdownSummary> => {
      void reason;
      closePromise ??= (async () => {
        closeOfflineCleanup();
        try {
          return await matchmakingService.shutdownForServiceStop();
        } finally {
          await app.close();
        }
      })();
      return closePromise;
    };
    return { app, close, accounts, sessions, auth, friends, matchmaking: matchmakingService, events, records };
  } catch (error) {
    if (database.isOpen) database.close();
    throw error;
  }
}

function resolveOfflineCleanupGraceMs(): number {
  const configured = Number(process.env.COMPET_OFFLINE_CLEANUP_GRACE_MS);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return DEFAULT_OFFLINE_CLEANUP_GRACE_MS;
}

async function loadRuntimeBotCatalog(serverRoot: string) {
  if (!serverRoot.trim()) return emptyBotCatalog();

  try {
    return await loadBotCatalog({
      profileDbPath: path.join(serverRoot, "csgo", "botprofile.db"),
      botInfoPath: path.join(serverRoot, "csgo", "addons", "sourcemod", "data", "bot_info.json"),
      botRostersPath: path.join(serverRoot, "csgo", "addons", "sourcemod", "configs", "bot_rosters.txt"),
      teamLogoDirectoryPath: path.join(serverRoot, "csgo", "materials", "panorama", "images", "tournaments", "teams"),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyBotCatalog();
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load BetterBots catalog from ${serverRoot}: ${message}`);
  }
}

function emptyBotCatalog(): BotCatalog {
  return {
    candidates: [],
    rosters: [],
    findCandidate() {
      return undefined;
    },
    pickRandom() {
      return [];
    },
  };
}
