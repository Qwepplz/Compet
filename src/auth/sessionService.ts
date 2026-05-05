import crypto from "node:crypto";
import type { JsonSessionRepository, SessionRecord } from "./sessionRepository.js";

export interface VerifiedSession {
  sessionId: string;
  accountId: string;
  expiresAt: string;
}

export class SessionService {
  constructor(
    private readonly repository: JsonSessionRepository,
    private readonly ttlMinutes: number,
  ) {}

  hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  async createSession(accountId: string): Promise<{ token: string; session: SessionRecord }> {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const expires = new Date(now.getTime() + this.ttlMinutes * 60_000);
    const session: SessionRecord = {
      id: crypto.randomUUID(),
      accountId,
      tokenHash: this.hashToken(token),
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      revokedAt: null,
      lastSeenAt: now.toISOString(),
    };
    await this.repository.upsert(session);
    return { token, session };
  }

  async verifyToken(token: string): Promise<VerifiedSession | undefined> {
    const tokenHash = this.hashToken(token);
    const session = await this.repository.updateByTokenHash(tokenHash, (current) => {
      if (current.revokedAt || Date.parse(current.expiresAt) <= Date.now()) return undefined;
      return { ...current, lastSeenAt: new Date().toISOString() };
    });
    if (!session) return undefined;
    return { sessionId: session.id, accountId: session.accountId, expiresAt: session.expiresAt };
  }

  async revokeSession(sessionId: string): Promise<void> {
    const revokedAt = new Date().toISOString();
    await this.repository.updateById(sessionId, (session) => {
      if (session.revokedAt) return undefined;
      return { ...session, revokedAt };
    });
  }

  async revokeSessionsForAccount(accountId: string): Promise<number> {
    return this.repository.revokeForAccount(accountId, new Date().toISOString());
  }
}
