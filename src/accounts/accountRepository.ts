import type { DatabaseSync } from "node:sqlite";
import type { AccountRecord } from "./accountTypes.js";

export class AccountRepository {
  constructor(private readonly database: DatabaseSync) {}

  async list(): Promise<AccountRecord[]> {
    return this.database.prepare(`
      SELECT
        id, username, display_name, steam64, role, enabled, dev,
        password_hash, must_change_password, created_at, updated_at, last_login_at
      FROM accounts
    `).all().map(accountFromRow);
  }

  async findById(id: string): Promise<AccountRecord | undefined> {
    const row = this.database.prepare(`
      SELECT
        id, username, display_name, steam64, role, enabled, dev,
        password_hash, must_change_password, created_at, updated_at, last_login_at
      FROM accounts
      WHERE id = ?
    `).get(id);
    return row ? accountFromRow(row) : undefined;
  }

  async findByUsername(username: string): Promise<AccountRecord | undefined> {
    const row = this.database.prepare(`
      SELECT
        id, username, display_name, steam64, role, enabled, dev,
        password_hash, must_change_password, created_at, updated_at, last_login_at
      FROM accounts
      WHERE username = ? COLLATE BINARY
    `).get(username);
    return row ? accountFromRow(row) : undefined;
  }

  async upsert(account: AccountRecord): Promise<AccountRecord> {
    this.database.prepare(`
      INSERT INTO accounts (
        id, username, display_name, steam64, role, enabled, dev,
        password_hash, must_change_password, created_at, updated_at, last_login_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        display_name = excluded.display_name,
        steam64 = excluded.steam64,
        role = excluded.role,
        enabled = excluded.enabled,
        dev = excluded.dev,
        password_hash = excluded.password_hash,
        must_change_password = excluded.must_change_password,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        last_login_at = excluded.last_login_at
    `).run(
      account.id,
      account.username,
      account.displayName,
      account.steam64,
      account.role,
      account.enabled ? 1 : 0,
      account.dev ? 1 : 0,
      account.passwordHash,
      account.mustChangePassword ? 1 : 0,
      account.createdAt,
      account.updatedAt,
      account.lastLoginAt,
    );
    return account;
  }

  async deleteById(id: string): Promise<boolean> {
    const result = this.database.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    return result.changes > 0;
  }
}

function accountFromRow(row: Record<string, unknown>): AccountRecord {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    steam64: String(row.steam64),
    role: row.role as AccountRecord["role"],
    enabled: Number(row.enabled) === 1,
    dev: Number(row.dev) === 1,
    passwordHash: String(row.password_hash),
    mustChangePassword: Number(row.must_change_password) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastLoginAt: row.last_login_at === null ? null : String(row.last_login_at),
  };
}
