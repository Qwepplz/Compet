import type { FastifyInstance, RawServerBase } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { AccountRecord } from "../accounts/accountTypes.js";
import type { AccountService } from "../accounts/accountService.js";
import type { SessionService } from "../auth/sessionService.js";
import type { FriendService } from "../friends/friendService.js";
import type { PresenceService, PresenceSummary } from "../presence/presenceService.js";
import type { RealtimeEventBus } from "./eventBus.js";
import { executeRealtimeCommand, parseRealtimeCommand, type RealtimeCommandMatchmaking } from "./realtimeCommands.js";
import { RealtimeSocketRegistry } from "./realtimeSocketRegistry.js";
import { accountActor, logRealtimeCommand, nextActivityId, writeActivityLog } from "../server/activityLogger.js";

export interface WebSocketDeps {
  accounts: AccountService;
  sessions: SessionService;
  events?: RealtimeEventBus;
  presence?: PresenceService;
  friends?: FriendService;
  matchmaking?: RealtimeCommandMatchmaking;
}
interface WebSocketQuery {
  token?: string;
  lastSeq?: string;
}

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

export async function registerWebSocket<RawServer extends RawServerBase>(
  app: FastifyInstance<RawServer>,
  deps: WebSocketDeps,
): Promise<void> {
  const sockets = new RealtimeSocketRegistry();
  const unsubscribeEvents = deps.events?.subscribe((event) => {
    const delivery = sockets.publish(event);
    const failedConnections = delivery.targetedConnections - delivery.sentConnections;
    const sequence = (event as { seq?: unknown }).seq;
    const eventId = typeof sequence === "number" ? `evt-${sequence}` : nextActivityId("evt-delivery");
    let result = "ok";
    if (delivery.targetedConnections === 0) result = "no_connections";
    else if (delivery.sentConnections === 0) result = "failed";
    else if (failedConnections > 0) result = "partial";
    writeActivityLog({
      source: "realtime",
      level: failedConnections > 0 ? "warn" : "info",
      message: `<--- Event WebSocket, id [${eventId}]: type=${event.type}`,
      context: {
        targetedConnections: delivery.targetedConnections,
        sentConnections: delivery.sentConnections,
        failedConnections,
        result,
      },
    });
  });

  app.addHook("onClose", (_instance, done) => {
    unsubscribeEvents?.();
    done();
  });

  app.get<{ Querystring: WebSocketQuery }>("/ws", { websocket: true }, (socket, request) => {
    const connectionId = `ws-${request.id}`;
    writeActivityLog({
      source: "realtime",
      level: "info",
      message: `---> Connection WebSocket, id [${connectionId}]`,
      context: { ip: request.ip },
    });
    const token = request.query.token;
    const accountPromise = authorizeWebSocket(token, deps).catch(() => undefined);
    let authorizationCheck: ReturnType<typeof setInterval> | undefined;
    let registeredAccountId: string | undefined;
    let registeredAccount: AccountRecord | undefined;
    let cleanedUp = false;
    const cleanup = (reason: string, closeCode?: number) => {
      if (cleanedUp) return;
      cleanedUp = true;
      sockets.unregister(socket);
      let connectionCount: number | null = null;
      if (registeredAccountId && deps.presence) {
        const summary = deps.presence.unregister(registeredAccountId);
        connectionCount = summary.connectionCount;
        void publishPresenceUpdated("disconnect", deps, summary);
      }
      writeActivityLog({
        source: "realtime",
        level: "info",
        message: `<--- Connection WebSocket, id [${connectionId}]: state=closed`,
        ...(registeredAccount ? { actor: accountActor(registeredAccount) } : {}),
        context: { ip: request.ip, connectionCount, reason, ...(closeCode === undefined ? {} : { closeCode }) },
      });
      registeredAccountId = undefined;
      registeredAccount = undefined;
      if (authorizationCheck) {
        clearInterval(authorizationCheck);
        authorizationCheck = undefined;
      }
    };

    socket.on("close", (code) => cleanup("closed", code));
    socket.on("error", () => {
      writeActivityLog({
        source: "realtime",
        level: "error",
        message: `WebSocket error, id [${connectionId}]`,
        ...(registeredAccount ? { actor: accountActor(registeredAccount) } : {}),
        context: { ip: request.ip, errorCode: "websocket_error" },
      });
      cleanup("error");
    });

    socket.on("message", async (data) => {
      const account = await accountPromise;
      if (!account) {
        const messageId = nextActivityId("msg");
        writeActivityLog({ source: "realtime", level: "warn", message: `---> Request WebSocket, id [${messageId}]: type=unauthorized_message`, context: { connectionId } });
        writeActivityLog({ source: "realtime", level: "warn", message: `<--- Response WebSocket, id [${messageId}]`, context: { connectionId, result: "failed", errorCode: "unauthorized" } });
        return;
      }
      await handleMessage(socket, data, account, deps, connectionId);
    });

    void accountPromise.then((account) => {
      if (!account) {
        writeActivityLog({
          source: "realtime",
          level: "warn",
          message: `<--- Connection WebSocket, id [${connectionId}]: result=unauthorized`,
          context: { ip: request.ip, result: "unauthorized", errorCode: "unauthorized" },
        });
        closeUnauthorized(socket);
        return;
      }

      if (socket.readyState !== SOCKET_OPEN) return;
      authorizationCheck = setInterval(() => {
        void authorizeWebSocket(token, deps).then((currentAccount) => {
          if (!currentAccount || currentAccount.id !== account.id) {
            writeActivityLog({
              source: "realtime",
              level: "warn",
              message: `<--- Reauthorize WebSocket, id [${connectionId}]: result=failed`,
              actor: accountActor(account),
              context: { ip: request.ip, errorCode: "unauthorized" },
            });
            closeUnauthorized(socket);
          }
        }).catch(() => {
          writeActivityLog({
            source: "realtime",
            level: "error",
            message: `<--- Reauthorize WebSocket, id [${connectionId}]: result=failed`,
            actor: accountActor(account),
            context: { ip: request.ip, errorCode: "reauthorization_error" },
          });
          closeUnauthorized(socket);
        });
      }, 5_000);
      sockets.register(account.id, socket);
      registeredAccount = account;
      sendJson(socket, { type: "hello", accountId: account.id, serverTime: now() });
      sendJson(socket, { type: "server_status", status: "online", serverTime: now() });
      replayEvents(socket, account, request.query.lastSeq, deps, connectionId);
      let connectionCount = 1;
      if (deps.presence) {
        registeredAccountId = account.id;
        const summary = deps.presence.register(account.id);
        connectionCount = summary.connectionCount;
        void publishPresenceUpdated("connect", deps, summary);
      }
      writeActivityLog({
        source: "realtime",
        level: "info",
        message: `<--- Connection WebSocket, id [${connectionId}]: state=opened`,
        actor: accountActor(account),
        context: { ip: request.ip, connectionCount, result: "ok" },
      });
    });
  });
}

async function authorizeWebSocket(
  token: string | undefined,
  deps: WebSocketDeps,
): Promise<AccountRecord | undefined> {
  if (!token) return undefined;

  const verified = await deps.sessions.verifyToken(token);
  if (!verified) return undefined;

  const account = await deps.accounts.getById(verified.accountId);
  if (!account || !account.enabled || account.mustChangePassword || account.role !== "player") return undefined;
  return account;
}

async function handleMessage(socket: WebSocket, data: RawData, account: AccountRecord, deps: WebSocketDeps, connectionId: string): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(data.toString());
  } catch {
    const messageId = nextActivityId("msg");
    writeActivityLog({ source: "realtime", level: "warn", message: `---> Request WebSocket, id [${messageId}]: type=invalid_json`, actor: accountActor(account), context: { connectionId } });
    sendJson(socket, { type: "error", code: "invalid_message", message: "Invalid JSON message" });
    writeActivityLog({ source: "realtime", level: "warn", message: `<--- Response WebSocket, id [${messageId}]`, actor: accountActor(account), context: { connectionId, result: "failed", errorCode: "invalid_message" } });
    return;
  }

  if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === "ping") {
    sendJson(socket, { type: "pong", serverTime: now() });
    return;
  }

  const command = parseRealtimeCommand(message);
  if (command) {
    const ack = await executeRealtimeCommand(command, account.id, deps);
    logRealtimeCommand(account, command, ack);
    sendJson(socket, withCommandServerNow(ack));
    return;
  }
  const messageId = nextActivityId("msg");
  writeActivityLog({ source: "realtime", level: "warn", message: `---> Request WebSocket, id [${messageId}]: type=unknown_command`, actor: accountActor(account), context: { connectionId } });
  writeActivityLog({ source: "realtime", level: "warn", message: `<--- Response WebSocket, id [${messageId}]`, actor: accountActor(account), context: { connectionId, result: "ignored", errorCode: "unknown_command" } });
}

function replayEvents(socket: WebSocket, account: AccountRecord, lastSeq: string | undefined, deps: WebSocketDeps, connectionId: string): void {
  const parsedLastSeq = Number(lastSeq);
  if (!deps.events || !Number.isSafeInteger(parsedLastSeq) || parsedLastSeq <= 0) return;
  const replay = deps.events.getEventsAfter(account.id, parsedLastSeq);
  for (const event of replay.events) {
    sendJson(socket, event);
  }
  sendJson(socket, {
    type: "replay_complete",
    afterSeq: parsedLastSeq,
    gap: replay.gap,
    lastSeq: replay.events.at(-1)?.seq ?? parsedLastSeq,
    serverTime: now(),
  });
  writeActivityLog({
    source: "realtime",
    level: "info",
    message: `---> Replay WebSocket, id [${connectionId}]`,
    actor: accountActor(account),
    context: {
      afterSeq: parsedLastSeq,
      eventCount: replay.events.length,
      gap: replay.gap,
      lastSeq: replay.events.at(-1)?.seq ?? parsedLastSeq,
    },
  });
}

function closeUnauthorized(socket: WebSocket): void {
  if (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN) {
    socket.close(1008, "unauthorized");
  }
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === SOCKET_OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function withCommandServerNow(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || (payload as { type?: unknown }).type !== "command_ack") {
    return payload;
  }
  const ack = payload as { ok?: unknown; result?: unknown };
  if (ack.ok !== true || typeof ack.result !== "object" || ack.result === null || Array.isArray(ack.result)) {
    return payload;
  }
  return {
    ...payload,
    result: { ...ack.result, serverNow: now() },
  };
}

async function publishPresenceUpdated(
  phase: "connect" | "disconnect",
  deps: Pick<WebSocketDeps, "events" | "friends">,
  summary: PresenceSummary,
): Promise<void> {
  if (!deps.events) return;
  if (phase === "connect" && (!summary.online || summary.connectionCount !== 1)) return;
  if (phase === "disconnect" && (summary.online || summary.connectionCount !== 0)) return;

  deps.events.publish({
    type: "presence_updated",
    accountId: summary.accountId,
    accountIds: await resolvePresenceAudience(deps, summary.accountId),
    online: summary.online,
    connectionCount: summary.connectionCount,
    lastSeenAt: summary.lastSeenAt,
  });
}

async function resolvePresenceAudience(deps: Pick<WebSocketDeps, "friends">, accountId: string): Promise<string[]> {
  const audience = new Set([accountId]);
  if (!deps.friends) return [...audience];
  try {
    const friendList = await deps.friends.listFriends(accountId);
    for (const friend of friendList.friends) {
      audience.add(friend.accountId);
    }
  } catch {
    // Presence should still reach the account itself if friend lookup fails.
  }
  return [...audience];
}

function now(): string {
  return new Date().toISOString();
}
