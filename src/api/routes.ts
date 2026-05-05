import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AccountRecord } from "../accounts/accountTypes.js";
import type { AccountService } from "../accounts/accountService.js";
import type { AuthService } from "../auth/authService.js";
import type { SessionService } from "../auth/sessionService.js";
import type { ServerConfig } from "../config/config.js";
import type { FriendService } from "../friends/friendService.js";
import type { MatchmakingService } from "../matchmaking/matchmakingService.js";
import type { VetoAction } from "../matchmaking/vetoService.js";
import { authenticateRequest, requireAdmin, requirePasswordChangeComplete } from "./authMiddleware.js";
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from "./httpErrors.js";

export interface RouteDeps {
  config?: ServerConfig;
  certificateFingerprintSha256: string;
  accounts: AccountService;
  sessions: SessionService;
  auth: AuthService;
  friends?: FriendService;
  matchmaking?: MatchmakingService;
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

const roleSchema = z.enum(["admin", "player"]);
const createAccountSchema = z.object({ username: z.string().min(1), password: z.string().min(8), displayName: z.string().min(1), steam64: z.string().default(""), role: roleSchema.default("player") });
const patchAccountSchema = z.object({ displayName: z.string().min(1).optional(), steam64: z.string().optional(), enabled: z.boolean().optional(), role: roleSchema.optional() });
const passwordSchema = z.object({ password: z.string().min(8) });
const accountIdParamsSchema = z.object({ id: z.string().min(1) });
const partyJoinSchema = z.object({ partyId: z.string().min(1) });
const queueSchema = z.object({ partyId: z.string().min(1).optional() }).default({});
const friendSearchQuerySchema = z.object({ q: z.string().default("") }).default({ q: "" });
const friendRequestSchema = z.object({ accountId: z.string().min(1) });
const matchRoomParamsSchema = z.object({ id: z.string().min(1) });
const vetoSchema = z.object({ action: z.enum(["ban", "pick"]), map: z.string().min(1) });

function mapAccountServiceError(error: unknown): never {
  if (error instanceof Error && error.message === "account not found") throw notFound();
  if (error instanceof Error && error.message === "username already exists") throw conflict("Username already exists");
  throw error;
}

function requireMatchmaking(deps: RouteDeps): MatchmakingService {
  if (!deps.matchmaking) throw new HttpError(503, "service_unavailable", "Matchmaking service unavailable");
  return deps.matchmaking;
}

function requireFriends(deps: RouteDeps): FriendService {
  if (!deps.friends) throw new HttpError(503, "service_unavailable", "Friend service unavailable");
  return deps.friends;
}

function mapMatchmakingServiceError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message.includes("party owner required")) throw forbidden(error.message);
    if (error.message.includes("steam64 required for matchmaking")) throw badRequest(error.message);
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
      error.message.includes("Invalid veto") ||
      error.message.includes("party is full") ||
      error.message.includes("party is not open") ||
      error.message.includes("party matchmaking must use party owner start") ||
      error.message.includes("party matchmaking must be started by owner") ||
      error.message.includes("party invitation") ||
      error.message.includes("already in another party") ||
      error.message.includes("already a party member") ||
      error.message.includes("not a friend") ||
      error.message.includes("offline")
    ) {
      throw badRequest(error.message);
    }
  }
  throw error;
}

function mapFriendServiceError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message.includes("friend request not found")) throw notFound();
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

  app.post("/auth/login", async (request) => {
    const username = readStringField(request.body, "username");
    const password = readStringField(request.body, "password");
    try {
      const result = await deps.auth.login(username, password, request.ip);
      return { token: result.token, expiresAt: result.expiresAt, account: publicAccount(result.account) };
    } catch {
      throw unauthorized("Invalid username or password");
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
      const account = await deps.accounts.createAccount({ ...input, mustChangePassword: false });
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
    if (id === auth.account.id && (input.enabled === false || input.role === "player")) throw forbidden("Cannot disable or demote current admin");
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
      return { account: publicAccount(await deps.accounts.resetPassword(id, password)) };
    } catch (error) {
      mapAccountServiceError(error);
    }
  });

  app.post("/admin/accounts/:id/revoke-sessions", async (request) => {
    await authenticateRequest(request, deps);
    requireAdmin(request);
    const { id } = accountIdParamsSchema.parse(request.params);
    return { revoked: await deps.sessions.revokeSessionsForAccount(id) };
  });

  app.get("/me", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
    return publicAccount(auth.account);
  });

  app.get("/friends/search", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
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
    requirePasswordChangeComplete(request);
    const friends = requireFriends(deps);
    try {
      return await friends.listFriends(auth.account.id);
    } catch (error) {
      mapFriendServiceError(error);
    }
  });

  app.post("/friends/requests", async (request, reply) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
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
    requirePasswordChangeComplete(request);
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
    requirePasswordChangeComplete(request);
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
    requirePasswordChangeComplete(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return { party: (await matchmaking.getPartyForAccount(auth.account.id)) ?? null };
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/create", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return { party: await matchmaking.createParty(auth.account.id) };
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/invite", async (request, reply) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
    const matchmaking = requireMatchmaking(deps);
    const { accountId } = friendRequestSchema.parse(request.body);
    try {
      return reply.status(201).send({ invitation: await matchmaking.inviteToParty(auth.account.id, accountId) });
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/invitations/:id/accept", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
    const matchmaking = requireMatchmaking(deps);
    const { id } = accountIdParamsSchema.parse(request.params);
    try {
      return { party: await matchmaking.acceptPartyInvite(auth.account.id, id) };
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/invitations/:id/decline", async (request, reply) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
    const matchmaking = requireMatchmaking(deps);
    const { id } = accountIdParamsSchema.parse(request.params);
    try {
      await matchmaking.declinePartyInvite(auth.account.id, id);
      return reply.status(204).send();
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/matchmaking/start", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return { room: await matchmaking.startPartyMatchmaking(auth.account.id) };
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/party/join", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
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
    requirePasswordChangeComplete(request);
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
    requirePasswordChangeComplete(request);
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
    requirePasswordChangeComplete(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return { room: await matchmaking.acceptReady(auth.account.id) };
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/matchmaking/ready/decline", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return { room: await matchmaking.declineReady(auth.account.id) };
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/matchmaking/cancel", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return { queue: await matchmaking.cancelQueue(auth.account.id) };
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.get("/matchmaking/state", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
    const matchmaking = requireMatchmaking(deps);
    try {
      return await matchmaking.getState(auth.account.id);
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });

  app.post("/match-room/:id/veto", async (request) => {
    const auth = await authenticateRequest(request, deps);
    requirePasswordChangeComplete(request);
    const matchmaking = requireMatchmaking(deps);
    const { id } = matchRoomParamsSchema.parse(request.params);
    const input = vetoSchema.parse(request.body);
    try {
      return { room: await matchmaking.applyVeto({ roomId: id, accountId: auth.account.id, action: input.action as VetoAction, map: input.map }) };
    } catch (error) {
      mapMatchmakingServiceError(error);
    }
  });
}
