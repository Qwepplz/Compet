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
  const unsubscribeEvents = deps.events?.subscribe((event) => sockets.publish(event));

  app.addHook("onClose", (_instance, done) => {
    unsubscribeEvents?.();
    done();
  });

  app.get<{ Querystring: WebSocketQuery }>("/ws", { websocket: true }, (socket, request) => {
    const token = request.query.token;
    const accountPromise = authorizeWebSocket(token, deps).catch(() => undefined);
    let authorizationCheck: ReturnType<typeof setInterval> | undefined;
    let registeredAccountId: string | undefined;
    const cleanup = () => {
      sockets.unregister(socket);
      if (registeredAccountId && deps.presence) {
        void publishPresenceUpdated("disconnect", deps, deps.presence.unregister(registeredAccountId));
        registeredAccountId = undefined;
      }
      if (authorizationCheck) {
        clearInterval(authorizationCheck);
        authorizationCheck = undefined;
      }
    };

    socket.on("close", cleanup);
    socket.on("error", cleanup);

    socket.on("message", async (data) => {
      const account = await accountPromise;
      if (!account) return;
      await handleMessage(socket, data, account.id, deps);
    });

    void accountPromise.then((account) => {
      if (!account) {
        closeUnauthorized(socket);
        return;
      }

      if (socket.readyState !== SOCKET_OPEN) return;
      authorizationCheck = setInterval(() => {
        void authorizeWebSocket(token, deps).then((currentAccount) => {
          if (!currentAccount || currentAccount.id !== account.id) closeUnauthorized(socket);
        }).catch(() => closeUnauthorized(socket));
      }, 5_000);
      sockets.register(account.id, socket);
      sendJson(socket, { type: "hello", accountId: account.id, serverTime: now() });
      sendJson(socket, { type: "server_status", status: "online", serverTime: now() });
      replayEvents(socket, account.id, request.query.lastSeq, deps);
      if (deps.presence) {
        registeredAccountId = account.id;
        void publishPresenceUpdated("connect", deps, deps.presence.register(account.id));
      }
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

async function handleMessage(socket: WebSocket, data: RawData, accountId: string, deps: WebSocketDeps): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(data.toString());
  } catch {
    sendJson(socket, { type: "error", code: "invalid_message", message: "Invalid JSON message" });
    return;
  }

  if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === "ping") {
    sendJson(socket, { type: "pong", serverTime: now() });
    return;
  }

  const command = parseRealtimeCommand(message);
  if (command) {
    sendJson(socket, await executeRealtimeCommand(command, accountId, deps));
  }
}

function replayEvents(socket: WebSocket, accountId: string, lastSeq: string | undefined, deps: WebSocketDeps): void {
  const parsedLastSeq = Number(lastSeq);
  if (!deps.events || !Number.isSafeInteger(parsedLastSeq) || parsedLastSeq <= 0) return;
  const replay = deps.events.getEventsAfter(accountId, parsedLastSeq);
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
