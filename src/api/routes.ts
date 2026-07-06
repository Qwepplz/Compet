import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AccountRecord } from "../accounts/accountTypes.js";
import type { AccountService } from "../accounts/accountService.js";
import type { AuthService } from "../auth/authService.js";
import type { SessionService } from "../auth/sessionService.js";
import type { ServerConfig } from "../config/config.js";
import type { FriendService } from "../friends/friendService.js";
import type { MatchmakingService } from "../matchmaking/matchmakingService.js";
import type { MatchPlan, MatchPlayerResult, MatchSeriesResult, TeamSide } from "../matchmaking/types.js";
import { DEFAULT_RANKME_SCORE, lookupRankmeScore, type RankmeScoreReader } from "../rankme/rankmeScoreStore.js";
import type { RealtimeEventBus } from "../realtime/eventBus.js";
import type { CompletedMatchRecord, MatchRecordStore } from "../records/matchRecordStore.js";
import { authenticateRequest, requireAdmin, requirePlayer } from "./authMiddleware.js";
import { badRequest, conflict, forbidden, HttpError, notFound, tooManyRequests, unauthorized } from "./httpErrors.js";

export interface RouteDeps {
  config?: ServerConfig;
  certificateFingerprintSha256: string;
  accounts: AccountService;
  sessions: SessionService;
  auth: AuthService;
  friends?: FriendService;
  matchmaking?: MatchmakingService;
  records?: Pick<MatchRecordStore, "listPlayerCompletedMatches" | "readPlayerCompletedMatch">;
  rankme?: RankmeScoreReader;
  events?: RealtimeEventBus;
}

type PublicAccount = Omit<AccountRecord, "passwordHash">;

function publicAccount(account: AccountRecord): PublicAccount {
  const { passwordHash: _passwordHash, ...rest } = account;
  return rest;
}
function readStringField(payload: unknown, field: string): string {
  if (!payload || typeof payload !== "object" || !(field in payload)) throw badRequest();
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.length === 0) throw badRequest();
  return value;
}

const createAccountSchema = z.object({ username: z.string().min(1), password: z.string().min(8), steam64: z.string().default("") });
const patchAccountSchema = z.object({ steam64: z.string().optional(), enabled: z.boolean().optional(), dev: z.boolean().optional() });
const matchmakingStartSchema = z.object({ dev: z.boolean().optional() });
const passwordSchema = z.object({ password: z.string().min(8) });
const accountIdParamsSchema = z.object({ id: z.string().min(1) });
const partyJoinSchema = z.object({ partyId: z.string().min(1) });
const queueSchema = z.object({ partyId: z.string().min(1).optional() }).default({});
const friendSearchQuerySchema = z.object({ q: z.string().default("") }).default({ q: "" });
const friendRequestSchema = z.object({ accountId: z.string().min(1) });
const matchRoomParamsSchema = z.object({ id: z.string().min(1) });
const matchHistoryQuerySchema = z.object({ accountId: z.string().min(1).optional() }).default({});
const matchHistoryLimit = 20;
const realtimeEventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  timeoutMs: z.coerce.number().int().min(0).max(30_000).default(25_000),
}).default({ afterSeq: 0, timeoutMs: 25_000 });

function mapAccountServiceError(error: unknown): never {
  if (error instanceof Error && error.message === "account not found") throw notFound();
  if (error instanceof Error && error.message === "username already exists") throw conflict("Username already exists");
  if (error instanceof Error && error.message === "steam64 already exists") throw conflict("Steam64 already exists");
  if (error instanceof Error && error.message === "admin account cannot be deleted") throw forbidden("Cannot delete the server admin account");
  throw error;
}

function mapClientLoginError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message === "account already logged in") throw conflict("账号已在另一个客户端登录");
    if (error.message === "account disabled") throw unauthorized("账号已被禁用");
    if (error.message === "admin account cannot use client login") throw unauthorized("管理员账号不能登录客户端，请使用服务端管理器登录");
    if (error.message === "too many login attempts") throw tooManyRequests("登录失败次数过多，请稍后再试");
  }
  throw unauthorized("用户名或密码错误");
}

function mapManagerLoginError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message === "account disabled") throw unauthorized("管理员账号已被禁用");
    if (error.message === "admin account required") throw unauthorized("只有管理员账号可以登录服务端管理器");
    if (error.message === "too many login attempts") throw tooManyRequests("登录失败次数过多，请稍后再试");
  }
  throw unauthorized("用户名或密码错误");
}

function requireMatchmaking(deps: RouteDeps): MatchmakingService {
  if (!deps.matchmaking) throw new HttpError(503, "service_unavailable", "Matchmaking service unavailable");
  return deps.matchmaking;
}

function requireFriends(deps: RouteDeps): FriendService {
  if (!deps.friends) throw new HttpError(503, "service_unavailable", "Friend service unavailable");
  return deps.friends;
}

function requireRealtimeEvents(deps: RouteDeps): RealtimeEventBus {
  if (!deps.events) throw new HttpError(503, "service_unavailable", "Realtime event service unavailable");
  return deps.events;
}

function requireRecords(deps: RouteDeps): Pick<MatchRecordStore, "listPlayerCompletedMatches" | "readPlayerCompletedMatch"> {
  if (!deps.records) throw new HttpError(503, "service_unavailable", "Match records unavailable");
  return deps.records;
}

function withServerNow<T extends object>(payload: T): T & { serverNow: string } {
  return { ...payload, serverNow: new Date().toISOString() };
}

function accountTeam(plan: MatchPlan, steam64: string): TeamSide | null {
  if (plan.teamA.participants.some((participant) => participant.kind === "human" && participant.steam64?.trim() === steam64)) return "teamA";
  if (plan.teamB.participants.some((participant) => participant.kind === "human" && participant.steam64?.trim() === steam64)) return "teamB";
  return null;
}

function resultPlayer(result: MatchSeriesResult, steam64: string): MatchPlayerResult | null {
  if (!steam64) return null;
  return result.players.find((player) => player.steam64.trim() === steam64) ?? null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function matchHistoryRankmeScore(plan: MatchPlan, self: MatchPlayerResult): number | undefined {
  const before = plan.rankmeScoresBefore?.[self.steam64.trim()];
  if (finiteNumber(before)) return before;
  return finiteNumber(self.rankmeScore) && finiteNumber(self.rankmeScoreDelta) ? self.rankmeScore - self.rankmeScoreDelta : undefined;
}

function toMatchHistoryEntry(record: CompletedMatchRecord, account: AccountRecord) {
  const steam64 = account.steam64.trim();
  const selfTeam = accountTeam(record.plan, steam64);
  if (!selfTeam) return null;
  const self = resultPlayer(record.result, steam64);
  if (!self) return null;
  return {
    matchId: record.matchId,
    completedAt: record.result.completedAt,
    mapName: record.result.mapName,
    winner: record.result.winner,
    score: { team1: record.result.team1Score, team2: record.result.team2Score },
    selfTeam,
    selfWon: record.result.winner === selfTeam,
    self: {
      kills: self.kills,
      deaths: self.deaths,
      assists: self.assists,
      damage: self.damage,
      headshots: self.headshots,
      rating2: self.rating2,
      rankmeScore: matchHistoryRankmeScore(record.plan, self),
      rankmeScoreDelta: self.rankmeScoreDelta,
    },
  };
}

async function rankmeScoreFor(deps: RouteDeps, account: AccountRecord, hasCompletedMatches: boolean | undefined): Promise<number | null> {
  const steam64 = account.steam64.trim();
  if (!steam64 || !deps.rankme) return null;
  const lookup = await lookupRankmeScore(deps.rankme, steam64);
  if (lookup.status === "found") return lookup.score;
  return lookup.status === "missing" && hasCompletedMatches === false ? DEFAULT_RANKME_SCORE : null;
}

async function resolveMatchHistoryAccount(deps: RouteDeps, authAccount: AccountRecord, accountId?: string): Promise<AccountRecord> {
  const targetAccountId = accountId?.trim();
  if (!targetAccountId || targetAccountId === authAccount.id) return authAccount;
  const targetAccount = await deps.accounts.getById(targetAccountId);
  if (!targetAccount || targetAccount.role !== "player" || !targetAccount.enabled) throw notFound();
  const friends = requireFriends(deps);
  const friendList = await friends.listFriends(authAccount.id);
  if (!friendList.friends.some((friend) => friend.accountId === targetAccount.id)) throw forbidden();
  return targetAccount;
}

function mapMatchmakingServiceError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message.includes("party owner required")) throw forbidden(error.message);
    if (error.message.includes("steam64 required for matchmaking")) throw badRequest(error.message);
    if (error.message.includes("matchmaking is already active")) throw conflict(error.message);
    if (
      error.message.includes("party not found") ||
      error.message.includes("party invitation not found") ||
      error.message.includes("queue entry not found") ||
      error.message.includes("ready room not found") ||
      error.message.includes("room not found") ||
      error.message.includes("account not found")
    ) {
      throw notFound();
    }
    if (
      error.message.includes("is not a member of party") ||
      error.message.includes("party is full") ||
      error.message.includes("party is not open") ||
      error.message.includes("party matchmaking must use party owner start") ||
      error.message.includes("party matchmaking must be started by owner") ||
      error.message.includes("party invitation") ||
      error.message.includes("ready check has not started") ||
      error.message.includes("match room is closed") ||
      error.message.includes("account is not in match room") ||
      error.message.includes("already in another party") ||
      error.message.includes("already a party member") ||
      error.message.includes("not a friend") ||
      error.message.includes("offline") ||
      error.message.includes("Not enough bot candidates") ||
      error.message.includes("dev mode")
    ) {
      throw badRequest(error.message);
    }
  }
  throw error;
}

function mapFriendServiceError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message.includes("friend request not found") || error.message.includes("friendship not found")) throw notFound();
    if (error.message.includes("friendship already exists") || error.message.includes("pending friend request already exists")) throw conflict(error.message);
    if (
      error.message.includes("account not found") ||
      error.message.includes("offline") ||
      error.message.includes("self") ||
      error.message.includes("not pending") ||
      error.message.includes("does not belong") ||
      error.message.includes("disabled")
    ) {
      throw badRequest(error.message);
    }
  }
  throw error;
}

export async function registerRoutes(app: FastifyInstance<any, any, any, any, any>, deps: RouteDeps): Promise<void> {
  app.get("/health", async () => ({ ok: true, serverTime: new Date().toISOString() }));

  app.get("/server/info", async () => ({
    version: "0.1.0",
    certificateFingerprintSha256: deps.certificateFingerprintSha256,
    websocketPath: "/ws",
  }));

  app.get("/realtime/events", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const events = requireRealtimeEvents(deps);
    const { afterSeq, timeoutMs } = realtimeEventsQuerySchema.parse(request.query ?? {});
    return withServerNow(await events.waitForEventsAfter(auth.account.id, afterSeq, timeoutMs));
  });

  app.post("/auth/login", async (request) => {
    const username = readStringField(request.body, "username");
    const password = readStringField(request.body, "password");
    try {
      const result = await deps.auth.login(username, password, request.ip);
      return { token: result.token, expiresAt: result.expiresAt, account: publicAccount(result.account) };
    } catch (error) {
      mapClientLoginError(error);
    }
  });

  app.post("/auth/manager-login", async (request) => {
    const username = readStringField(request.body, "username");
    const password = readStringField(request.body, "password");
    try {
      const result = await deps.auth.login(username, password, request.ip, { requireAdmin: true });
      return { token: result.token, expiresAt: result.expiresAt, account: publicAccount(result.account) };
    } catch (error) {
      mapManagerLoginError(error);
    }
  });

  app.post("/auth/change-password", async (request, reply) => {
    const auth = await authenticateRequest(request, deps);
    const currentPassword = readStringField(request.body, "currentPassword");
    const { password: newPassword } = passwordSchema.parse({ password: readStringField(request.body, "newPassword") });
    try {
      await deps.auth.changePassword(auth.account.id, currentPassword, newPassword);
    } catch {
      throw badRequest("Invalid current password");
    }
    return reply.status(204).send();
  });

  app.post("/auth/logout", async (request, reply) => {
    const auth = await authenticateRequest(request, deps);
    await deps.sessions.revokeSession(auth.sessionId);
    return reply.status(204).send();
  });

  app.get("/admin/accounts", async (request) => {
    await authenticateRequest(request, deps);
    requireAdmin(request);
    return { accounts: (await deps.accounts.listAccounts()).map(publicAccount) };
  });

  app.post("/admin/accounts", async (request, reply) => {
    await authenticateRequest(request, deps);
    requireAdmin(request);
    const input = createAccountSchema.parse(request.body);
    try {
      const account = await deps.accounts.createAccount({ ...input, role: "player", mustChangePassword: false });
      return reply.status(201).send({ account: publicAccount(account) });
    } catch (error) {
      mapAccountServiceError(error);
    }
  });

  app.patch("/admin/accounts/:id", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requireAdmin(request);
    const { id } = accountIdParamsSchema.parse(request.params);
    const input = patchAccountSchema.parse(request.body);
    if (id === auth.account.id && input.enabled === false) throw forbidden("Cannot disable current admin");
    try {
      return { account: publicAccount(await deps.accounts.updateAccount(id, input)) };
    } catch (error) {
      mapAccountServiceError(error);
    }
  });

  app.post("/admin/accounts/:id/reset-password", async (request) => {
    await authenticateRequest(request, deps);
    requireAdmin(request);
    const { id } = accountIdParamsSchema.parse(request.params);
    const { password } = passwordSchema.parse(request.body);
    try {
      const account = await deps.accounts.resetPassword(id, password);
      await deps.sessions.revokeSessionsForAccount(id);
      return { account: publicAccount(account) };
    } catch (error) {
      mapAccountServiceError(error);
    }
  });

  app.delete("/admin/accounts/:id", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requireAdmin(request);
    const { id } = accountIdParamsSchema.parse(request.params);
    if (id === auth.account.id) throw forbidden("Cannot delete current admin");
    try {
      await deps.sessions.revokeSessionsForAccount(id);
    } catch {
      // Deleting the account makes any leftover sessions fail account lookup.
    }
    try {
      await deps.accounts.deleteAccount(id);
    } catch (error) {
      mapAccountServiceError(error);
    }
    return { ok: true };
  });

  app.get("/admin/matchmaking/occupancy", async (request) => {
    await authenticateRequest(request, deps);
    requireAdmin(request);
    const matchmaking = requireMatchmaking(deps);
    return { occupancy: await matchmaking.getOccupancy() };
  });

  app.get("/me", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    return publicAccount(auth.account);
  });

  app.get("/me/rankme-score", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const completedMatches = deps.records ? await deps.records.listPlayerCompletedMatches(auth.account.steam64, 1) : undefined;
    return { score: await rankmeScoreFor(deps, auth.account, completedMatches ? completedMatches.length > 0 : undefined) };
  });

  app.get("/matches/history", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const records = requireRecords(deps);
    const { accountId } = matchHistoryQuerySchema.parse(request.query ?? {});
    const historyAccount = await resolveMatchHistoryAccount(deps, auth.account, accountId);
    const completedRecords = await records.listPlayerCompletedMatches(historyAccount.steam64, matchHistoryLimit);
    const matches = completedRecords
      .map((record) => toMatchHistoryEntry(record, historyAccount))
      .filter((record): record is NonNullable<typeof record> => Boolean(record));
    const rankmeScore = await rankmeScoreFor(deps, historyAccount, completedRecords.length > 0);
    return { rankmeScore, matches };
  });

  app.get("/matches/:id/result", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const records = requireRecords(deps);
    const { id } = matchRoomParamsSchema.parse(request.params);
    const { accountId } = matchHistoryQuerySchema.parse(request.query ?? {});
    const historyAccount = await resolveMatchHistoryAccount(deps, auth.account, accountId);
    const match = await records.readPlayerCompletedMatch(historyAccount.steam64, id);
    if (!match) throw notFound();
    return { result: match.result };
  });

  app.get("/friends/search", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const friends = requireFriends(deps);
    const { q } = friendSearchQuerySchema.parse(request.query ?? {});
    try {
      return { results: await friends.search(auth.account.id, q) };
    } catch (error) {
      mapFriendServiceError(error);
    }
  });

  app.get("/friends", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const friends = requireFriends(deps);
    try {
      return await friends.listFriends(auth.account.id);
    } catch (error) {
      mapFriendServiceError(error);
    }
  });

  app.delete("/friends/:id", async (request, reply) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const friends = requireFriends(deps);
    const { id } = accountIdParamsSchema.parse(request.params);
    try {
      await friends.removeFriend(auth.account.id, id);
      return reply.status(204).send();
    } catch (error) {
      mapFriendServiceError(error);
    }
  });

  app.post("/friends/requests", async (request, reply) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const friends = requireFriends(deps);
    const { accountId } = friendRequestSchema.parse(request.body);
    try {
      return reply.status(201).send({ request: await friends.sendRequest(auth.account.id, accountId) });
    } catch (error) {
      mapFriendServiceError(error);
    }
  });

  app.post("/friends/requests/:id/accept", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const friends = requireFriends(deps);
    const { id } = accountIdParamsSchema.parse(request.params);
    try {
      return await friends.acceptRequest(auth.account.id, id);
    } catch (error) {
      mapFriendServiceError(error);
    }
  });

  app.post("/friends/requests/:id/decline", async (request, reply) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const friends = requireFriends(deps);
    const { id } = accountIdParamsSchema.parse(request.params);
    try {
      await friends.declineRequest(auth.account.id, id);
      return reply.status(204).send();
    } catch (error) {
      mapFriendServiceError(error);
    }
  });

  app.get("/party", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return withServerNow({ party: (await matchmaking.getPartyForAccount(auth.account.id)) ?? null });
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/create", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return withServerNow({ party: await matchmaking.createParty(auth.account.id) });
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/invite", async (request, reply) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    const { accountId } = friendRequestSchema.parse(request.body);
    try {
      return reply.status(201).send(withServerNow({ invitation: await matchmaking.inviteToParty(auth.account.id, accountId) }));
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/invitations/:id/accept", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    const { id } = accountIdParamsSchema.parse(request.params);
    try {
      return withServerNow({ party: await matchmaking.acceptPartyInvite(auth.account.id, id) });
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/invitations/:id/decline", async (request, reply) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    const { id } = accountIdParamsSchema.parse(request.params);
    try {
      await matchmaking.declinePartyInvite(auth.account.id, id);
      return reply.status(204).send();
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/invitations/:id/ignore", async (request, reply) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    const { id } = accountIdParamsSchema.parse(request.params);
    try {
      await matchmaking.ignorePartyInvite(auth.account.id, id);
      return reply.status(204).send();
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/matchmaking/start", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    const { dev } = matchmakingStartSchema.parse(request.body ?? {});
    try {
      return withServerNow({ room: await matchmaking.startPartyMatchmaking(auth.account.id, { dev }) });
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/matchmaking/begin", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return withServerNow({ party: await matchmaking.beginPartyMatchmaking(auth.account.id) });
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/matchmaking/cancel", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return withServerNow({ party: await matchmaking.cancelPartyMatchmaking(auth.account.id) });
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/join", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    const { partyId } = partyJoinSchema.parse(request.body);
    try {
      const currentParty = await matchmaking.getPartyForAccount(auth.account.id);
      if (!currentParty || currentParty.id !== partyId) throw badRequest("Use party invitation accept to join a party");
      return { party: await matchmaking.joinParty(partyId, auth.account.id) };
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/leave", async (request, reply) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      await matchmaking.leaveParty(auth.account.id);
      return reply.status(204).send();
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/matchmaking/queue", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    const { partyId } = queueSchema.parse(request.body ?? {});
    try {
      return { queue: await matchmaking.enqueue({ accountId: auth.account.id, partyId }) };
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/matchmaking/ready", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return withServerNow({ room: await matchmaking.acceptReady(auth.account.id) });
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/matchmaking/ready/decline", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return withServerNow({ room: await matchmaking.declineReady(auth.account.id) });
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/matchmaking/cancel", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return { queue: await matchmaking.cancelQueue(auth.account.id) };
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.get("/matchmaking/state", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return withServerNow(await matchmaking.getState(auth.account.id));
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/match-room/:id/entered", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePlayer(request);
    const matchmaking = requireMatchmaking(deps);
    const { id } = matchRoomParamsSchema.parse(request.params);
    try {
      return withServerNow({ room: await matchmaking.ackReadyRoomEntered(id, auth.account.id) });
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });
}
