import type { AccountService } from "../accounts/accountService.js";
import type { AccountRecord } from "../accounts/accountTypes.js";
import { hashPassword, verifyPassword } from "./passwordHasher.js";
import type { InMemoryLoginRateLimiter } from "./rateLimiter.js";
import type { SessionService } from "./sessionService.js";

export interface LoginResult {
  token: string;
  sessionId: string;
  account: AccountRecord;
  expiresAt: string;
}

export interface LoginOptions {
  requireAdmin?: boolean;
}

export class AuthService {
  constructor(
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
    private readonly limiter: InMemoryLoginRateLimiter,
  ) {}

  async login(username: string, password: string, ip: string, options: LoginOptions = {}): Promise<LoginResult> {
    this.limiter.check(username, ip);
    const account = await this.accounts.getByUsername(username);
    if (!account || !(await verifyPassword(account.passwordHash, password))) {
      this.limiter.recordFailure(username, ip);
      throw new Error("invalid username or password");
    }
    if (!account.enabled) throw new Error("account disabled");
    if (options.requireAdmin && account.role !== "admin") throw new Error("admin account required");
    if (!options.requireAdmin && account.role === "admin") throw new Error("admin account cannot use client login");
    this.limiter.clear(username, ip);
    const updatedAccount = await this.accounts.markLogin(account.id);
    const { token, session } = await this.sessions.createSession(account.id, { rejectExistingActive: !options.requireAdmin });
    return {
      token,
      sessionId: session.id,
      account: updatedAccount ?? account,
      expiresAt: session.expiresAt,
    };
  }

  async changePassword(accountId: string, currentPassword: string, newPassword: string): Promise<void> {
    const account = await this.accounts.getById(accountId);
    if (!account || !(await verifyPassword(account.passwordHash, currentPassword))) {
      throw new Error("invalid current password");
    }
    const passwordHash = await hashPassword(newPassword);
    await this.accounts.setPasswordHash(account.id, passwordHash, false);
  }
}
