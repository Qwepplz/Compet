import crypto from "node:crypto";
import type { JsonSessionRepository, SessionRecord } from "./sessionRepository.js";

const ACTIVE_CLIENT_STALE_AFTER_MS = 120_000;

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

  async createSession(accountId: string, options: { rejectExistingActive?: boolean } = {}): Promise<{ token: string; session: SessionRecord }> {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const nowIso = now.toISOString();
    const expires = new Date(now.getTime() + this.ttlMinutes * 60_000);
    const session: SessionRecord = {
      id: crypto.randomUUID(),
      accountId,
      tokenHash: this.hashToken(token),
      createdAt: nowIso,
      expiresAt: expires.toISOString(),
      revokedAt: null,
      lastSeenAt: nowIso,
    };
    if (options.rejectExistingActive) {
      const staleBefore = new Date(now.getTime() - ACTIVE_CLIENT_STALE_AFTER_MS).toISOString();
      await this.repository.insertIfNoActiveForAccount(session, nowIso, staleBefore);
    }
    else await this.repository.replaceActiveForAccount(session, nowIso);
    return { token, session };
  }

  async verifyToken(token: string): Promise<VerifiedSession | undefined> {
    const tokenHash = this.hashToken(token);
    const session = await this.repository.updateActiveUniqueByTokenHash(tokenHash, new Date().toISOString());
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

  async listLatestLastSeenByAccount(): Promise<Map<string, string>> {
    const latest = new Map<string, string>();
    for (const session of await this.repository.list()) {
      const current = latest.get(session.accountId);
      if (!current || Date.parse(session.lastSeenAt) > Date.parse(current)) {
        latest.set(session.accountId, session.lastSeenAt);
      }
    }
    return latest;
  }
}
