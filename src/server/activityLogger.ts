import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccountRecord } from "../accounts/accountTypes.js";
import { SERVER_ACTIVITY_PREFIX, type ActivityLogInput, type LogActor, type LogSource } from "../shared/activityLog.js";
import type { RealtimeCommand, RealtimeCommandAck } from "../realtime/realtimeCommands.js";
import type { RealtimeEvent } from "../realtime/realtimeTypes.js";

const ACTION_LABELS = {
  playerLogin: "玩家登录",
  managerLogin: "管理员登录",
  changePassword: "修改密码",
  logout: "退出登录",
  createAccount: "创建账号",
  updateAccount: "修改账号",
  resetPassword: "重置账号密码",
  deleteAccount: "删除账号",
  removeFriend: "删除好友",
  sendFriendRequest: "发送好友请求",
  acceptFriendRequest: "接受好友请求",
  declineFriendRequest: "拒绝好友请求",
  createParty: "创建队伍",
  inviteToParty: "邀请玩家加入队伍",
  acceptPartyInvite: "接受队伍邀请",
  declinePartyInvite: "拒绝队伍邀请",
  ignorePartyInvite: "忽略队伍邀请",
  createMatchRoom: "创建匹配房间",
  beginMatchmaking: "开始匹配",
  cancelMatchmaking: "取消匹配",
  joinParty: "加入队伍",
  leaveParty: "离开队伍",
  joinMatchmakingQueue: "加入匹配队列",
  acceptReady: "确认准备",
  declineReady: "拒绝准备",
  enterMatchRoom: "进入匹配房间",
} as const;

type ActionName = keyof typeof ACTION_LABELS;

const routeActions: Record<string, ActionName> = {
  "POST /auth/login": "playerLogin",
  "POST /auth/manager-login": "managerLogin",
  "POST /auth/change-password": "changePassword",
  "POST /auth/logout": "logout",
  "POST /admin/accounts": "createAccount",
  "PATCH /admin/accounts/:id": "updateAccount",
  "POST /admin/accounts/:id/reset-password": "resetPassword",
  "DELETE /admin/accounts/:id": "deleteAccount",
  "DELETE /friends/:id": "removeFriend",
  "POST /friends/requests": "sendFriendRequest",
  "POST /friends/requests/:id/accept": "acceptFriendRequest",
  "POST /friends/requests/:id/decline": "declineFriendRequest",
  "POST /party/create": "createParty",
  "POST /party/invite": "inviteToParty",
  "POST /party/invitations/:id/accept": "acceptPartyInvite",
  "POST /party/invitations/:id/decline": "declinePartyInvite",
  "POST /party/invitations/:id/ignore": "ignorePartyInvite",
  "POST /party/matchmaking/start": "createMatchRoom",
  "POST /party/matchmaking/begin": "beginMatchmaking",
  "POST /party/matchmaking/cancel": "cancelMatchmaking",
  "POST /party/join": "joinParty",
  "POST /party/leave": "leaveParty",
  "POST /matchmaking/queue": "joinMatchmakingQueue",
  "POST /matchmaking/ready": "acceptReady",
  "POST /matchmaking/ready/decline": "declineReady",
  "POST /matchmaking/cancel": "cancelMatchmaking",
  "POST /match-room/:id/entered": "enterMatchRoom",
};

const commandActions: Record<RealtimeCommand["name"], ActionName> = {
  "friends.sendRequest": "sendFriendRequest",
  "friends.acceptRequest": "acceptFriendRequest",
  "friends.declineRequest": "declineFriendRequest",
  "friends.removeFriend": "removeFriend",
  "party.create": "createParty",
  "party.invite": "inviteToParty",
  "party.acceptInvite": "acceptPartyInvite",
  "party.declineInvite": "declinePartyInvite",
  "party.ignoreInvite": "ignorePartyInvite",
  "party.leave": "leaveParty",
  "party.beginMatchmaking": "beginMatchmaking",
  "party.cancelMatchmaking": "cancelMatchmaking",
  "party.startMatchmaking": "createMatchRoom",
  "matchmaking.acceptReady": "acceptReady",
  "matchmaking.declineReady": "declineReady",
  "matchRoom.entered": "enterMatchRoom",
};

export function writeActivityLog(input: ActivityLogInput): void {
  const entry = { ...input, timestamp: input.timestamp ?? new Date().toISOString() };
  process.stdout.write(`${SERVER_ACTIVITY_PREFIX}${JSON.stringify(entry)}\n`);
}

export function installHttpActivityLogging(app: FastifyInstance<any, any, any, any, any>): void {
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route) return;
    const action = routeActions[`${request.method} ${route}`];
    if (!action) return;

    const actor = requestActor(request);
    const failed = reply.statusCode >= 400;
    const actorName = actor?.username ?? requestUsername(request) ?? "未认证用户";
    writeActivityLog({
      source: routeSource(route),
      level: failed ? "warn" : "info",
      message: `${ACTION_LABELS[action]}${failed ? "失败" : "成功"}`,
      actor: actor ?? (actorName === "未认证用户" ? undefined : { username: actorName }),
      context: requestContext(request, reply.statusCode),
    });
  });
}

export function logRealtimeCommand(account: AccountRecord, command: RealtimeCommand, ack: RealtimeCommandAck): void {
  const failed = !ack.ok;
  writeActivityLog({
    source: commandSource(command.name),
    level: failed ? "warn" : "info",
    message: `${ACTION_LABELS[commandActions[command.name]]}${failed ? `失败: ${ack.error.message}` : "成功"}`,
    actor: accountActor(account),
    context: commandContext(command),
  });
}

export function logRealtimeEvent(event: RealtimeEvent): void {
  const context: Record<string, string | number | boolean | null> = {};
  if ("matchId" in event) context.matchId = event.matchId;
  if ("roomId" in event) context.roomId = event.roomId;

  switch (event.type) {
    case "ready_check_started":
      writeActivityLog({ source: "matchmaking", level: "info", message: "准备确认开始", context: { ...context, players: event.accountIds.length, deadlineAt: event.deadlineAt } });
      break;
    case "match_room_created":
      writeActivityLog({ source: "match", level: "info", message: "匹配房间已创建", context });
      break;
    case "teams_assigned":
      writeActivityLog({ source: "match", level: "info", message: "比赛队伍已分配", context });
      break;
    case "map_randomizing_started":
      writeActivityLog({ source: "match", level: "info", message: "地图随机开始", context });
      break;
    case "server_preparing":
      writeActivityLog({ source: "game", level: "info", message: "游戏服务器准备中", context });
      break;
    case "connect_ready":
      writeActivityLog({ source: "game", level: "info", message: "游戏服务器可连接", context: { ...context, address: event.connect.connectAddress, map: event.connect.map } });
      break;
    case "match_live":
      writeActivityLog({ source: "match", level: "info", message: "比赛已开始", context });
      break;
    case "match_completed":
      writeActivityLog({ source: "match", level: "info", message: "比赛已完成并保存结果", context });
      break;
    case "match_failed":
      writeActivityLog({ source: "match", level: "error", message: `比赛失败: ${errorMessage(event.error)}`, context });
      break;
    default:
      break;
  }
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
  return request.auth?.account ? accountActor(request.auth.account) : undefined;
}

function requestUsername(request: FastifyRequest): string | undefined {
  const body = request.body;
  if (!body || typeof body !== "object") return undefined;
  const username = (body as { username?: unknown }).username;
  return typeof username === "string" ? username : undefined;
}

function requestContext(request: FastifyRequest, statusCode: number): Record<string, string | number | boolean | null> {
  const context: Record<string, string | number | boolean | null> = {
    method: request.method,
    statusCode,
    ip: request.ip,
    requestId: request.id,
  };
  if (request.routeOptions.url) context.route = request.routeOptions.url;
  addSafeFields(context, request.params, ["id", "accountId", "partyId", "roomId"]);
  addSafeFields(context, request.body, ["accountId", "partyId", "roomId", "dev"]);
  return context;
}

function commandContext(command: RealtimeCommand): Record<string, string | number | boolean | null> {
  const context: Record<string, string | number | boolean | null> = { command: command.name, commandId: command.commandId };
  addSafeFields(context, command.payload, ["accountId", "requestId", "friendshipId", "invitationId", "roomId", "dev"]);
  return context;
}

function addSafeFields(target: Record<string, string | number | boolean | null>, value: unknown, fields: string[]): void {
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
  if (route.startsWith("/match-room")) return "match";
  return "matchmaking";
}

function commandSource(name: RealtimeCommand["name"]): LogSource {
  if (name.startsWith("friends.")) return "friend";
  if (name.startsWith("party.")) return "party";
  if (name.startsWith("matchRoom.")) return "match";
  return "matchmaking";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
