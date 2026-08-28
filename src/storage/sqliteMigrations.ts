import type { DatabaseSync } from "node:sqlite";

interface SqliteMigration {
  version: number;
  name: string;
  up: (database: DatabaseSync) => void;
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "create persistence schema",
    up(database) {
      database.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE BINARY UNIQUE,
          display_name TEXT NOT NULL,
          steam64 TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'player')),
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          dev INTEGER NOT NULL DEFAULT 0 CHECK (dev IN (0, 1)),
          password_hash TEXT NOT NULL,
          must_change_password INTEGER NOT NULL CHECK (must_change_password IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login_at TEXT
        );

        CREATE UNIQUE INDEX accounts_non_empty_steam64_unique
          ON accounts (steam64)
          WHERE steam64 <> '';

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          last_seen_at TEXT NOT NULL
        );

        CREATE INDEX sessions_account_id_idx ON sessions (account_id);

        CREATE TABLE friendships (
          id TEXT PRIMARY KEY,
          account_a_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
          account_b_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          CHECK (account_a_id <> account_b_id)
        );

        CREATE UNIQUE INDEX friendships_pair_unique
          ON friendships (min(account_a_id, account_b_id), max(account_a_id, account_b_id));

        CREATE TABLE friend_requests (
          id TEXT PRIMARY KEY,
          from_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
          to_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          CHECK (from_account_id <> to_account_id)
        );

        CREATE INDEX friend_requests_to_account_idx ON friend_requests (to_account_id, status);
        CREATE INDEX friend_requests_from_account_idx ON friend_requests (from_account_id, status);
        CREATE UNIQUE INDEX friend_requests_pending_pair_unique
          ON friend_requests (min(from_account_id, to_account_id), max(from_account_id, to_account_id))
          WHERE status = 'pending';

        CREATE TABLE matches (
          id TEXT PRIMARY KEY,
          map TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          result_json TEXT NOT NULL,
          status_json TEXT,
          server_json TEXT,
          events_json TEXT
        );

        CREATE INDEX matches_completed_at_idx ON matches (completed_at DESC, id DESC);

        CREATE TABLE match_participants (
          match_id TEXT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
          steam64 TEXT NOT NULL CHECK (length(steam64) > 0),
          side TEXT NOT NULL CHECK (side IN ('teamA', 'teamB')),
          PRIMARY KEY (match_id, steam64)
        );

        CREATE INDEX match_participants_steam64_idx ON match_participants (steam64, match_id);
      `);
    },
  },
  {
    version: 2,
    name: "remove redundant session token index",
    up(database) {
      database.exec("DROP INDEX IF EXISTS sessions_token_hash_idx");
    },
  },
];

const LATEST_SCHEMA_VERSION = SQLITE_MIGRATIONS.at(-1)?.version ?? 0;

function ensureSchemaMigrationsTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function readSchemaVersion(database: DatabaseSync): number {
  const table = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get();
  if (!table) return 0;

  const rows = database.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all();
  let expectedVersion = 1;
  for (const row of rows) {
    const version = Number(row.version);
    if (!Number.isInteger(version) || version !== expectedVersion || version < 1) {
      throw new Error(`Invalid SQLite migration history at version ${String(row.version)}`);
    }
    const migration = SQLITE_MIGRATIONS.find((candidate) => candidate.version === version);
    if (migration && row.name !== migration.name) {
      throw new Error(`SQLite migration name mismatch at version ${version}`);
    }
    expectedVersion += 1;
  }
  return expectedVersion - 1;
}

export function applySqliteMigrations(database: DatabaseSync): void {
  const currentVersion = readSchemaVersion(database);
  if (currentVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(`SQLite schema version ${currentVersion} is newer than supported version ${LATEST_SCHEMA_VERSION}`);
  }

  const pending = SQLITE_MIGRATIONS.filter((migration) => migration.version > currentVersion);
  if (pending.length === 0) return;

  database.exec("BEGIN IMMEDIATE");
  try {
    ensureSchemaMigrationsTable(database);
    for (const migration of pending) {
      migration.up(database);
      database.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, new Date().toISOString());
    }
    assertSqliteIntegrity(database);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export function assertSqliteIntegrity(database: DatabaseSync): void {
  const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length > 0) {
    throw new Error(`SQLite foreign key check failed: ${JSON.stringify(foreignKeyErrors)}`);
  }
  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (integrity?.integrity_check !== "ok") {
    throw new Error(`SQLite integrity check failed: ${String(integrity?.integrity_check)}`);
  }
}
