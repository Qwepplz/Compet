import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AccountService } from "../accounts/accountService.js";
import { JsonAccountRepository } from "../accounts/accountRepository.js";
import { AuthService } from "../auth/authService.js";
import { InMemoryLoginRateLimiter } from "../auth/rateLimiter.js";
import { JsonSessionRepository } from "../auth/sessionRepository.js";
import { SessionService } from "../auth/sessionService.js";
import { bootstrapAdmin } from "../bootstrap/bootstrapAdmin.js";
import { loadBotCatalog, type BotCatalog } from "../bots/botCatalog.js";
import type { ServerConfig } from "../config/config.js";
import { FriendService } from "../friends/friendService.js";
import { FriendStore } from "../friends/friendStore.js";
import { MatchExecutor } from "../game/matchExecutor.js";
import { NodeGameServerLauncher } from "../game/gameServerLauncher.js";
import { isSourceServerObservable, type SourceServerExitMonitorSpec } from "../game/sourceServerMonitor.js";
import { MatchmakingService } from "../matchmaking/matchmakingService.js";
import { MatchmakingStore } from "../matchmaking/matchmakingStore.js";
import { PresenceService } from "../presence/presenceService.js";
import { RealtimeEventBus } from "../realtime/eventBus.js";
import { MatchRecordStore } from "../records/matchRecordStore.js";
import { ensureServerCertificate, type ServerCertificate } from "../tls/certificateService.js";
import { createServer } from "./createServer.js";

export interface Runtime {
  app: Awaited<ReturnType<typeof createServer>>;
  accounts: AccountService;
  sessions: SessionService;
  auth: AuthService;
  certificate: ServerCertificate;
  friends: FriendService;
  matchmaking: MatchmakingService;
  events: RealtimeEventBus;
  records: MatchRecordStore;
}

const DEFAULT_OFFLINE_CLEANUP_GRACE_MS = 15_000;

export async function createRuntime(config: ServerConfig): Promise<Runtime> {
  const recordsDir = path.join(config.dataDir, "records");
  await mkdir(recordsDir, { recursive: true });

  const certificate = await ensureServerCertificate(path.join(config.dataDir, "certs"));
  const accounts = new AccountService(await JsonAccountRepository.create(path.join(recordsDir, "accounts.json")));
  const sessions = new SessionService(
    await JsonSessionRepository.create(path.join(recordsDir, "sessions.json")),
    config.tokenTtlMinutes,
  );

  await bootstrapAdmin(accounts, path.join(config.dataDir, "bootstrap-admin.json"));

  const records = new MatchRecordStore(recordsDir);
  const events = new RealtimeEventBus();
  const presence = new PresenceService();
  const friends = new FriendService({
    store: await FriendStore.create(path.join(recordsDir, "friends")),
    accounts,
    presence,
    events,
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
    onServerExit: (matchId, exitInfo) => {
      void matchmaking?.completeMatchFromServerExit(matchId, exitInfo).catch((error) => {
        process.stderr.write(`Failed to complete match after srcds exit: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    },
  });
  const botCatalog = await loadRuntimeBotCatalog(config.gameServer.serverRoot);
  const matchmakingService = new MatchmakingService({
    store: await MatchmakingStore.create(path.join(recordsDir, "matchmaking")),
    accounts,
    friends,
    botCatalog,
    executor,
    records,
    events,
  });
  matchmaking = matchmakingService;
  await completeRoomsIfGameServerUnavailable(matchmakingService, config.gameServer.portRange.start);
  const offlineCleanupGraceMs = resolveOfflineCleanupGraceMs();
  const offlineCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  events.subscribe((event) => {
    if (event.type !== "presence_updated") return;
    const existingTimer = offlineCleanupTimers.get(event.accountId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      offlineCleanupTimers.delete(event.accountId);
    }
    if (event.online) return;

    const timer = setTimeout(() => {
      offlineCleanupTimers.delete(event.accountId);
      if (presence.isOnline(event.accountId)) return;
      void friends.expireDisconnectedRequests(event.accountId).catch(() => undefined);
      void matchmakingService.handleAccountOffline(event.accountId).catch(() => undefined);
    }, offlineCleanupGraceMs);
    timer.unref?.();
    offlineCleanupTimers.set(event.accountId, timer);
  });

  const auth = new AuthService(accounts, sessions, new InMemoryLoginRateLimiter());
  const app = await createServer({
    accounts,
    sessions,
    auth,
    friends,
    matchmaking: matchmakingService,
    events,
    presence,
    certificateFingerprintSha256: certificate.fingerprintSha256,
    https: { key: certificate.keyPem, cert: certificate.certPem },
  });
  app.addHook("onClose", (_instance, done) => {
    for (const timer of offlineCleanupTimers.values()) {
      clearTimeout(timer);
    }
    offlineCleanupTimers.clear();
    done();
  });

  return { app, accounts, sessions, auth, certificate, friends, matchmaking: matchmakingService, events, records };
}

function resolveOfflineCleanupGraceMs(): number {
  const configured = Number(process.env.COMPET_OFFLINE_CLEANUP_GRACE_MS);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return DEFAULT_OFFLINE_CLEANUP_GRACE_MS;
}

async function completeRoomsIfGameServerUnavailable(matchmaking: MatchmakingService, port: number): Promise<void> {
  const monitor: SourceServerExitMonitorSpec = {
    host: "127.0.0.1",
    port,
    intervalMs: 1_000,
    queryTimeoutMs: 750,
    missedResponsesBeforeExit: 3,
    startupObservationTimeoutMs: 60_000,
  };
  if (await isSourceServerObservable(monitor)) return;
  await matchmaking.completeServerManagedRoomsFromServerUnavailable({
    code: null,
    signal: null,
    output: [`Source server was unavailable on startup at ${monitor.host}:${monitor.port}`],
  });
}

async function loadRuntimeBotCatalog(serverRoot: string) {
  if (!serverRoot.trim()) return emptyBotCatalog();

  try {
    return await loadBotCatalog({
      profileDbPath: path.join(serverRoot, "csgo", "botprofile.db"),
      botInfoPath: path.join(serverRoot, "csgo", "addons", "sourcemod", "data", "bot_info.json"),
      botRostersPath: path.join(serverRoot, "csgo", "addons", "sourcemod", "configs", "bot_rosters.txt"),
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
