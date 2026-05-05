import type { FastifyRequest } from "fastify";
import type { AccountRecord } from "../accounts/accountTypes.js";
import type { AccountService } from "../accounts/accountService.js";
import type { SessionService } from "../auth/sessionService.js";
import { forbidden, unauthorized } from "./httpErrors.js";

export interface RequestAuth { sessionId: string; token: string; account: AccountRecord; expiresAt: string; }
export interface AuthDeps { accounts: AccountService; sessions: SessionService; }

declare module "fastify" { interface FastifyRequest { auth?: RequestAuth; } }

export async function authenticateRequest(request: FastifyRequest<any, any>, deps: AuthDeps): Promise<RequestAuth> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) throw unauthorized();
  const verified = await deps.sessions.verifyToken(token);
  if (!verified) throw unauthorized();
  const account = await deps.accounts.getById(verified.accountId);
  if (!account || !account.enabled) throw unauthorized();
  request.auth = { token, sessionId: verified.sessionId, account, expiresAt: verified.expiresAt };
  return request.auth;
}

export function requirePasswordChangeComplete(request: FastifyRequest<any, any>): void {
  if (request.auth?.account.mustChangePassword) throw forbidden("Password change required");
}

export function requireAdmin(request: FastifyRequest<any, any>): void {
  requirePasswordChangeComplete(request);
  if (request.auth?.account.role !== "admin") throw forbidden("Admin role required");
}
