import type { DatabaseSync } from "node:sqlite";
import { withDatabaseTransaction } from "../storage/competDatabase.js";

export interface SessionRecord {
  id: string;
  accountId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string;
}

export class SessionRepository {
  constructor(private readonly database: DatabaseSync) {}

  async list(): Promise<SessionRecord[]> {
    return this.database.prepare(`
      SELECT id, account_id, token_hash, created_at, expires_at, revoked_at, last_seen_at
      FROM sessions
    `).all().map(sessionFromRow);
  }

  async upsert(session: SessionRecord): Promise<SessionRecord> {
    this.database.prepare(`
      INSERT INTO sessions (id, account_id, token_hash, created_at, expires_at, revoked_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
        token_hash = excluded.token_hash,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        revoked_at = COALESCE(sessions.revoked_at, excluded.revoked_at),
        last_seen_at = excluded.last_seen_at
    `).run(
      session.id,
      session.accountId,
      session.tokenHash,
      session.createdAt,
      session.expiresAt,
      session.revokedAt,
      session.lastSeenAt,
    );
    const stored = this.database.prepare(`
      SELECT id, account_id, token_hash, created_at, expires_at, revoked_at, last_seen_at
      FROM sessions WHERE id = ?
    `).get(session.id);
    return stored ? sessionFromRow(stored) : session;
  }

  async replaceActiveForAccount(session: SessionRecord, revokedAt: string): Promise<SessionRecord> {
    return withDatabaseTransaction(this.database, (database) => {
      database.prepare(
        "UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL",
      ).run(revokedAt, session.accountId);
      insertSession(database, session);
      return session;
    });
  }

  async insertIfNoActiveForAccount(session: SessionRecord, now: string, staleBefore?: string): Promise<SessionRecord> {
    return withDatabaseTransaction(this.database, (database) => {
      database.prepare(`
        UPDATE sessions
        SET revoked_at = ?
        WHERE account_id = ? AND revoked_at IS NULL AND julianday(expires_at) <= julianday(?)
      `).run(now, session.accountId, now);
      if (staleBefore) {
        database.prepare(`
          UPDATE sessions
          SET revoked_at = ?
          WHERE account_id = ? AND revoked_at IS NULL
            AND julianday(expires_at) > julianday(?) AND julianday(last_seen_at) <= julianday(?)
        `).run(now, session.accountId, now, staleBefore);
      }

      const active = database.prepare(`
        SELECT id FROM sessions
        WHERE account_id = ? AND revoked_at IS NULL AND julianday(expires_at) > julianday(?)
        LIMIT 1
      `).get(session.accountId, now);
      if (active) throw new Error("account already logged in");
      insertSession(database, session);
      return session;
    });
  }

  async updateActiveUniqueByTokenHash(tokenHash: string, seenAt: string, expiresAt: string): Promise<SessionRecord | undefined> {
    return withDatabaseTransaction(this.database, (database) => {
      const row = database.prepare(`
        SELECT id, account_id, token_hash, created_at, expires_at, revoked_at, last_seen_at
        FROM sessions WHERE token_hash = ?
      `).get(tokenHash);
      if (!row) return undefined;
      const current = sessionFromRow(row);
      if (current.revokedAt || Date.parse(current.expiresAt) <= Date.parse(seenAt)) return undefined;

      const activeRows = database.prepare(`
        SELECT id, account_id, token_hash, created_at, expires_at, revoked_at, last_seen_at
        FROM sessions
        WHERE account_id = ? AND revoked_at IS NULL AND julianday(expires_at) > julianday(?)
        ORDER BY julianday(created_at) ASC, id ASC
      `).all(current.accountId, seenAt).map(sessionFromRow);
      const allowed = activeRows[0];
      for (const session of activeRows.slice(1)) {
        database.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").run(seenAt, session.id);
      }
      if (!allowed || allowed.id !== current.id) return undefined;

      database.prepare(
        "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL",
      ).run(seenAt, expiresAt, current.id);
      return { ...current, lastSeenAt: seenAt, expiresAt };
    });
  }

  async revokeById(id: string, revokedAt: string): Promise<boolean> {
    const result = this.database.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(revokedAt, id);
    return result.changes > 0;
  }

  async revokeForAccount(accountId: string, revokedAt: string): Promise<number> {
    const result = this.database.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL",
    ).run(revokedAt, accountId);
    return Number(result.changes);
  }
}

function insertSession(database: DatabaseSync, session: SessionRecord): void {
  database.prepare(`
    INSERT INTO sessions (id, account_id, token_hash, created_at, expires_at, revoked_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    session.accountId,
    session.tokenHash,
    session.createdAt,
    session.expiresAt,
    session.revokedAt,
    session.lastSeenAt,
  );
}

function sessionFromRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    tokenHash: String(row.token_hash),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    lastSeenAt: String(row.last_seen_at),
  };
}
