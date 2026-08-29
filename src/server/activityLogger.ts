import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccountRecord } from "../accounts/accountTypes.js";
import { SERVER_ACTIVITY_PREFIX, type ActivityLogInput, type LogActor, type LogSource } from "../shared/activityLog.js";
import { redactSensitiveText } from "../shared/redactSensitiveText.js";
import type { RealtimeCommand, RealtimeCommandAck } from "../realtime/realtimeCommands.js";
import type { RealtimeEvent } from "../realtime/realtimeTypes.js";

declare module "fastify" {
  interface FastifyContextConfig {
    logSuccessfulActivity?: boolean;
  }
}

type LogContext = NonNullable<ActivityLogInput["context"]>;

const requestStartedAt = new WeakMap<object, number>();
const requestErrors = new WeakMap<object, LogContext>();
let activitySequence = 0;

export function writeActivityLog(input: ActivityLogInput): void {
  const entry = { ...input, timestamp: input.timestamp ?? new Date().toISOString() };
  process.stdout.write(`${SERVER_ACTIVITY_PREFIX}${JSON.stringify(entry)}\n`);
}

export function nextActivityId(prefix: string): string {
  activitySequence += 1;
  return `${prefix}-${activitySequence}`;
}

export function installHttpActivityLogging(app: FastifyInstance<any, any, any, any, any>): void {
  app.addHook("onRequest", async (request) => {
    requestStartedAt.set(request, Date.now());
    const route = requestRoute(request);
    if (request.routeOptions.config.logSuccessfulActivity === false) return;
    writeActivityLog({
      source: routeSource(route),
      level: "info",
      message: `---> Request HTTP, id [${request.id}]`,
      context: httpContext(request, route),
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    const failed = reply.statusCode >= 400;
    if (!failed && request.routeOptions.config.logSuccessfulActivity === false) {
      requestStartedAt.delete(request);
      requestErrors.delete(request);
      return;
    }

    const route = requestRoute(request);
    const actor = requestActor(request);
    const source = routeSource(route);
    const context = httpContext(request, route);
    const errorContext = requestErrors.get(request);
    const startedAt = requestStartedAt.get(request);
    const durationMs = startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt);

    writeActivityLog({
      source,
      level: failed ? "warn" : "info",
      message: `<--- Response HTTP, id [${request.id}]`,
      ...(actor ? { actor } : {}),
      context: {
        ...context,
        statusCode: reply.statusCode,
        result: failed ? "failed" : "ok",
        durationMs,
        ...(errorContext ?? {}),
      },
    });

    requestStartedAt.delete(request);
    requestErrors.delete(request);
  });
}

export function recordHttpActivityError(request: FastifyRequest<any, any, any, any, any>, error: unknown): void {
  requestErrors.set(request, errorContext(error));
}

export function logRealtimeCommand(account: AccountRecord, command: RealtimeCommand, ack: RealtimeCommandAck): void {
  const id = command.commandId || nextActivityId("cmd");
  const context = commandContext(command);

  writeActivityLog({
    source: commandSource(command.name),
    level: "info",
    message: `---> Request WebSocket, id [${id}]: command=${command.name}`,
    actor: accountActor(account),
    context,
  });
  writeActivityLog({
    source: commandSource(command.name),
    level: ack.ok ? "info" : "warn",
    message: `<--- Response WebSocket, id [${id}]`,
    actor: accountActor(account),
    context: {
      ...context,
      result: ack.ok ? "ok" : "failed",
      ...(!ack.ok ? { statusCode: ack.error.statusCode, errorCode: "command_error" } : {}),
    },
  });
}

export function logRealtimeEvent(event: RealtimeEvent): void {
  const sequence = (event as { seq?: unknown }).seq;
  const id = typeof sequence === "number" ? `evt-${sequence}` : nextActivityId("evt");
  writeActivityLog({
    source: eventSource(event.type),
    level: event.type === "match_failed" ? "error" : "info",
    message: `---> Event Realtime, id [${id}]: type=${event.type}`,
    context: eventContext(event),
  });
}

export function accountActor(account: AccountRecord): LogActor {
  return {
    accountId: account.id,
    username: account.username,
    role: account.role,
    ...(account.steam64 ? { steam64: account.steam64 } : {}),
  };
}

function requestActor(request: FastifyRequest): LogActor | undefined {
  if (request.auth?.account) return accountActor(request.auth.account);
  const username = requestUsername(request);
  return username ? { username } : undefined;
}

function requestUsername(request: FastifyRequest): string | undefined {
  const body = request.body;
  if (!body || typeof body !== "object") return undefined;
  const username = (body as { username?: unknown }).username;
  return typeof username === "string" ? username : undefined;
}

function requestRoute(request: FastifyRequest): string {
  if (request.routeOptions.url) return request.routeOptions.url;
  return request.url.split("?", 1)[0] || "/";
}

function httpContext(request: FastifyRequest, route: string): LogContext {
  const context: LogContext = {
    method: request.method,
    route,
    ip: request.ip,
    requestId: request.id,
  };
  addSafeFields(context, request.params, ["id", "accountId", "partyId", "roomId"]);
  addSafeFields(context, request.body, ["accountId", "partyId", "roomId", "dev"]);
  return context;
}

function commandContext(command: RealtimeCommand): LogContext {
  const context: LogContext = { command: command.name, commandId: command.commandId };
  addSafeFields(context, command.payload, ["accountId", "requestId", "friendshipId", "invitationId", "roomId", "dev"]);
  return context;
}

function eventContext(event: RealtimeEvent): LogContext {
  const context: LogContext = {};
  if ("matchId" in event) context.matchId = event.matchId;
  if ("roomId" in event) context.roomId = event.roomId;
  if ("accountId" in event) context.accountId = event.accountId;
  if ("accountIds" in event && Array.isArray(event.accountIds)) {
    context.targetCount = event.accountIds.length;
    if (event.accountIds.length > 0) context.targets = event.accountIds.join(",");
  }

  switch (event.type) {
    case "presence_updated":
      context.online = event.online;
      context.connectionCount = event.connectionCount;
      if (event.lastSeenAt) context.lastSeenAt = event.lastSeenAt;
      break;
    case "ready_check_started":
    case "ready_check_updated":
      context.deadlineAt = event.deadlineAt;
      context.playerCount = event.accountIds.length;
      break;
    case "matchmaking_occupancy_updated":
      context.activeCount = event.occupancy.activeCount;
      break;
    case "connect_ready":
      context.address = event.connect.connectAddress;
      context.map = event.connect.map;
      break;
    case "match_failed":
      Object.assign(context, errorContext(event.error));
      break;
    default:
      break;
  }

  return context;
}

function addSafeFields(target: LogContext, value: unknown, fields: string[]): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const field of fields) {
    const fieldValue = record[field];
    if (["string", "number", "boolean"].includes(typeof fieldValue)) {
      target[field === "id" ? "targetId" : field] = fieldValue as string | number | boolean;
    }
  }
}

function routeSource(route: string): LogSource {
  if (route.startsWith("/auth")) return "auth";
  if (route.startsWith("/admin/accounts")) return "account";
  if (route.startsWith("/friends")) return "friend";
  if (route.startsWith("/party")) return "party";
  if (route.startsWith("/match-room") || route.startsWith("/matches")) return "match";
  if (route.startsWith("/matchmaking")) return "matchmaking";
  if (route.startsWith("/realtime") || route.startsWith("/ws")) return "realtime";
  return "server";
}

function commandSource(name: RealtimeCommand["name"]): LogSource {
  if (name.startsWith("friends.")) return "friend";
  if (name.startsWith("party.")) return "party";
  if (name.startsWith("matchRoom.")) return "match";
  return "matchmaking";
}

function eventSource(type: RealtimeEvent["type"]): LogSource {
  if (type.startsWith("friend_")) return "friend";
  if (type.startsWith("party_")) return "party";
  if (type === "queue_updated" || type === "matchmaking_occupancy_updated" || type.startsWith("ready_check_")) return "matchmaking";
  if (type === "server_preparing" || type === "connect_ready") return "game";
  if (type.startsWith("match_")) return "match";
  return "realtime";
}

function errorContext(error: unknown): LogContext {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const candidate = record?.code;
  const context: LogContext = {
    errorCode: typeof candidate === "string" && isSafeToken(candidate) ? candidate : "request_error",
    errorType: error instanceof Error && isSafeToken(error.name) ? error.name : "unknown_error",
  };
  if (!record || typeof candidate !== "string" || !candidate.startsWith("ERR_SQLITE_")) return context;

  if (typeof record.message === "string") {
    context.errorMessage = redactSensitiveText(record.message);
  }
  if (typeof record.errcode === "number" && Number.isInteger(record.errcode)) {
    context.sqliteErrorCode = record.errcode;
  }
  return context;
}

function isSafeToken(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/u.test(value);
}
