import type { FastifyInstance, RawServerBase } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { AccountRecord } from "../accounts/accountTypes.js";
import type { AccountService } from "../accounts/accountService.js";
import type { SessionService } from "../auth/sessionService.js";
import type { PresenceService, PresenceSummary } from "../presence/presenceService.js";
import type { RealtimeEventBus } from "./eventBus.js";
import type { RealtimeEvent } from "./realtimeTypes.js";

export interface WebSocketDeps {
  accounts: AccountService;
  sessions: SessionService;
  events?: RealtimeEventBus;
  presence?: PresenceService;
}
interface WebSocketQuery { token?: string; }

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

export async function registerWebSocket<RawServer extends RawServerBase>(
  app: FastifyInstance<RawServer>,
  deps: WebSocketDeps,
): Promise<void> {
  app.get<{ Querystring: WebSocketQuery }>("/ws", { websocket: true }, (socket, request) => {
    const token = request.query.token;
    const accountPromise = authorizeWebSocket(token, deps).catch(() => undefined);
    let unsubscribe: (() => void) | undefined;
    let authorizationCheck: ReturnType<typeof setInterval> | undefined;
    let registeredAccountId: string | undefined;
    const cleanup = () => {
      if (registeredAccountId && deps.presence) {
        publishPresenceUpdated("disconnect", deps, deps.presence.unregister(registeredAccountId));
        registeredAccountId = undefined;
      }
      if (authorizationCheck) {
        clearInterval(authorizationCheck);
        authorizationCheck = undefined;
      }
      unsubscribe?.();
      unsubscribe = undefined;
    };

    socket.on("close", cleanup);
    socket.on("error", cleanup);

    socket.on("message", async (data) => {
      const account = await accountPromise;
      if (!account) return;
      handleMessage(socket, data);
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
      if (deps.events) {
        unsubscribe = deps.events.subscribe((event) => {
          if (shouldSendEventToAccount(event, account.id)) sendJson(socket, event);
        });
      }
      sendJson(socket, { type: "hello", accountId: account.id, serverTime: now() });
      sendJson(socket, { type: "server_status", status: "online", serverTime: now() });
      if (deps.presence) {
        registeredAccountId = account.id;
        publishPresenceUpdated("connect", deps, deps.presence.register(account.id));
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

function handleMessage(socket: WebSocket, data: RawData): void {
  let message: unknown;
  try {
    message = JSON.parse(data.toString());
  } catch {
    sendJson(socket, { type: "error", code: "invalid_message", message: "Invalid JSON message" });
    return;
  }

  if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === "ping") {
    sendJson(socket, { type: "pong", serverTime: now() });
  }
}

function shouldSendEventToAccount(event: RealtimeEvent, accountId: string): boolean {
  if ("accountIds" in event && event.accountIds) return event.accountIds.includes(accountId);
  if ("accountId" in event) return event.accountId === accountId;
  return true;
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

function publishPresenceUpdated(
  phase: "connect" | "disconnect",
  deps: Pick<WebSocketDeps, "events">,
  summary: PresenceSummary,
): void {
  if (!deps.events) return;
  if (phase === "connect" && (!summary.online || summary.connectionCount !== 1)) return;
  if (phase === "disconnect" && (summary.online || summary.connectionCount !== 0)) return;

  deps.events.publish({
    type: "presence_updated",
    accountId: summary.accountId,
    online: summary.online,
    connectionCount: summary.connectionCount,
    lastSeenAt: summary.lastSeenAt,
  });
}

function now(): string {
  return new Date().toISOString();
}
