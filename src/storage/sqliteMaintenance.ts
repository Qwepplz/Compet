import { rmSync, rmdirSync } from "node:fs";
import { access, link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { redactSensitiveText } from "../shared/redactSensitiveText.js";
import {
  LATEST_SCHEMA_VERSION,
  readSchemaVersion,
  readSqliteIntegrity,
} from "./sqliteMigrations.js";

export type MaintenanceMode = "inspect" | "clean" | "compact";

export interface MaintenanceOptions {
  now: string;
  retentionDays?: number;
  maxDeleteRows?: number;
}

export interface MaintenanceIssue {
  code: string;
  count: number;
}

export interface MaintenanceReport {
  status: "ok" | "skipped" | "blocked" | "failed";
  checkedAt: string;
  candidates: { sessions: number; friendRequests: number };
  deleted: { sessions: number; friendRequests: number };
  remainingCandidates: number;
  pageCount: number;
  freelistCount: number;
  pageSize: number;
  issues: MaintenanceIssue[];
}

export interface MaintenanceGuards {
  expectedDataVersion?: number;
  preflight?: MaintenanceReport;
}

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_DELETE_ROWS = 5000;

const REQUIRED_TABLES = [
  "accounts",
  "sessions",
  "friendships",
  "friend_requests",
  "matches",
  "match_participants",
  "schema_migrations",
] as const;
const RESOLVED_REQUEST_STATUSES = new Set(["accepted", "declined", "expired"]);
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const CONNECTION_MARKER_SUFFIX = "-connections";
const MAINTENANCE_LOCK_SUFFIX = "-maintenance.lock";
const MAINTENANCE_COORDINATION_SUFFIX = "-maintenance-coordination.sqlite3";
const LEASE_RECOVERY_SUFFIX = ".recovery";
const COORDINATION_BUSY_TIMEOUT_MS = 1000;
const activeMaintenanceLeasePaths = new Set<string>();

export interface SqliteLease {
  release(): void;
}

export async function acquireSqliteMaintenanceLease(databasePath: string): Promise<SqliteLease> {
  const leaseKey = path.resolve(databasePath);
  if (activeMaintenanceLeasePaths.has(leaseKey)) {
    throw new Error("SQLite database maintenance is in use");
  }
  activeMaintenanceLeasePaths.add(leaseKey);
  const lockPath = `${databasePath}${MAINTENANCE_LOCK_SUFFIX}`;
  let coordinationLease: SqliteLease | undefined;
  let lease: SqliteLease | undefined;
  try {
    await mkdir(path.dirname(databasePath), { recursive: true });
    coordinationLease = await acquireSqliteCoordinationLease(
      databasePath,
      "SQLite database maintenance is in use",
    );
    lease = await createLeaseFile(lockPath, "SQLite database maintenance");
    const activeConnections = await listLiveConnectionMarkers(databasePath);
    if (activeConnections.length > 0) {
      throw new Error("SQLite database is in use by an application connection");
    }
    const fileLease = lease;
    const coordination = coordinationLease;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        fileLease.release();
        coordination.release();
        activeMaintenanceLeasePaths.delete(leaseKey);
      },
    };
  } catch (error) {
    lease?.release();
    coordinationLease?.release();
    activeMaintenanceLeasePaths.delete(leaseKey);
    throw error;
  }
}

export async function acquireSqliteConnectionLease(
  databasePath: string,
  ignoreMaintenanceLock = false,
): Promise<SqliteLease> {
  const markerDirectory = `${databasePath}${CONNECTION_MARKER_SUFFIX}`;
  await mkdir(markerDirectory, { recursive: true });
  const markerPath = path.join(markerDirectory, `${process.pid}-${randomUUID()}.lock`);
  const coordinationLease = ignoreMaintenanceLock
    ? undefined
    : await acquireSqliteCoordinationLease(databasePath, "SQLite database is in maintenance mode");
  let lease: SqliteLease | undefined;
  try {
    lease = await createLeaseFile(markerPath, "SQLite application connection", markerDirectory);
    if (!ignoreMaintenanceLock) {
      const maintenanceLockPath = `${databasePath}${MAINTENANCE_LOCK_SUFFIX}`;
      if (activeMaintenanceLeasePaths.has(path.resolve(databasePath))) {
        throw new Error("SQLite database is in maintenance mode");
      }
      await ensureMaintenanceLockIsAbsent(maintenanceLockPath);
    }
    coordinationLease?.release();
    return lease;
  } catch (error) {
    lease?.release();
    coordinationLease?.release();
    throw error;
  }
}

async function acquireSqliteCoordinationLease(
  databasePath: string,
  busyMessage: string,
): Promise<SqliteLease> {
  const coordinationPath = `${databasePath}${MAINTENANCE_COORDINATION_SUFFIX}`;
  await mkdir(path.dirname(databasePath), { recursive: true });
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(coordinationPath);
    database.exec(`PRAGMA busy_timeout = ${COORDINATION_BUSY_TIMEOUT_MS}`);
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (database?.isOpen) database.close();
    if (isSqliteLockContention(error)) throw new Error(busyMessage);
    throw error;
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        if (database?.isTransaction) database.exec("ROLLBACK");
      } catch {
        // Closing the connection still releases the OS-level coordination lock.
      } finally {
        try {
          if (database?.isOpen) database.close();
        } catch {
          // The process exit path will release any remaining SQLite lock.
        }
      }
    },
  };
}

function isSqliteLockContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database is locked|database table is locked/i.test(String(error));
}

export function attachSqliteConnectionLease(database: DatabaseSync, lease: SqliteLease): void {
  const close = database.close.bind(database);
  let released = false;
  database.close = () => {
    close();
    if (!released) {
      released = true;
      lease.release();
    }
  };
}

async function createLeaseFile(filePath: string, label: string, cleanupDirectory?: string): Promise<SqliteLease> {
  const contents = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await clearStaleRecovery(filePath, label);
      try {
        await link(temporaryPath, filePath);
        return createFileLease(filePath, cleanupDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await isLeaseOwnerAlive(filePath)) throw new Error(`${label} is in use`);
        const reclaimed = await reclaimStaleLease(filePath, label);
        if (!reclaimed) continue;
      }
    }
    throw new Error(`${label} could not be acquired`);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function clearStaleRecovery(filePath: string, label: string): Promise<void> {
  const recoveryPath = `${filePath}${LEASE_RECOVERY_SUFFIX}`;
  if (!(await fileExists(recoveryPath))) return;
  if (await isLeaseOwnerAlive(recoveryPath)) throw new Error(`${label} is in use`);
  await rm(recoveryPath, { force: true });
}

async function ensureMaintenanceLockIsAbsent(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await clearStaleRecovery(lockPath, "SQLite database maintenance");
    if (!(await fileExists(lockPath))) return;
    if (await isLeaseOwnerAlive(lockPath)) throw new Error("SQLite database is in maintenance mode");
    if (await reclaimStaleLease(lockPath, "SQLite database maintenance")) return;
  }
  throw new Error("SQLite database maintenance lock could not be checked");
}

async function reclaimStaleLease(filePath: string, label: string): Promise<boolean> {
  const recoveryPath = `${filePath}${LEASE_RECOVERY_SUFFIX}`;
  await clearStaleRecovery(filePath, label);
  try {
    await rename(filePath, recoveryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  let keepRecovery = false;
  try {
    if (await isLeaseOwnerAlive(recoveryPath)) {
      try {
        await link(recoveryPath, filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        keepRecovery = true;
      }
      throw new Error(`${label} is in use`);
    }
    return true;
  } finally {
    if (!keepRecovery) await rm(recoveryPath, { force: true });
  }
}

function createFileLease(filePath: string, cleanupDirectory?: string): SqliteLease {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        rmSync(filePath, { force: true });
      } catch {
        // Keep the live marker if it cannot be removed; PID liveness prevents unsafe reuse.
      }
      if (cleanupDirectory) {
        try {
          rmdirSync(cleanupDirectory);
        } catch {
          // Another connection marker may still be using the directory.
        }
      }
    },
  };
}

async function listLiveConnectionMarkers(databasePath: string): Promise<string[]> {
  const markerDirectory = `${databasePath}${CONNECTION_MARKER_SUFFIX}`;
  let entries;
  try {
    entries = await readdir(markerDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const activeMarkers: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;
    const markerPath = path.join(markerDirectory, entry.name);
    if (await isLeaseOwnerAlive(markerPath)) activeMarkers.push(markerPath);
    else await rm(markerPath, { force: true });
  }
  return activeMarkers;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isLeaseOwnerAlive(filePath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
  try {
    const pid = Number((JSON.parse(raw) as { pid?: unknown }).pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    return isProcessAlive(pid);
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface ResolvedOptions {
  nowMs: number;
  retentionDays: number;
  maxDeleteRows: number;
}

interface SessionCandidate {
  id: string;
  accountId: string;
}

interface FriendRequestCandidate {
  id: string;
}

interface ProtectedSnapshot {
  protectedTableDigests: Record<string, string>;
  sessionIds: string[];
  pendingRequestIds: string[];
  latestLastSeenByAccount: Array<[string, string | number]>;
}

interface Analysis {
  report: MaintenanceReport;
  options: ResolvedOptions;
  sessionCandidates: SessionCandidate[];
  friendRequestCandidates: FriendRequestCandidate[];
}

class IssueCollector {
  private readonly counts = new Map<string, number>();

  add(code: string, count = 1): void {
    if (count <= 0) return;
    this.counts.set(code, (this.counts.get(code) ?? 0) + count);
  }

  has(code: string): boolean {
    return this.counts.has(code);
  }

  toArray(): MaintenanceIssue[] {
    return [...this.counts.entries()].map(([code, count]) => ({ code, count }));
  }
}

class MaintenanceFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function readSqliteDataVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA data_version").get() as Record<string, unknown> | undefined;
  const value = Number(row ? Object.values(row)[0] : NaN);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("SQLite data_version is invalid");
  }
  return value;
}

export function inspectSqliteMaintenance(
  database: DatabaseSync,
  options: MaintenanceOptions,
): MaintenanceReport {
  let startedTransaction = false;
  try {
    const resolved = resolveOptions(options);
    if (!database.isTransaction) {
      database.exec("BEGIN");
      startedTransaction = true;
    }
    const analysis = analyzeDatabase(database, options, resolved);
    if (startedTransaction && database.isTransaction) database.exec("COMMIT");
    return analysis.report;
  } catch (error) {
    if (startedTransaction && database.isTransaction) database.exec("ROLLBACK");
    return failedReport(options, error);
  }
}

export function cleanSqliteMaintenance(
  database: DatabaseSync,
  options: MaintenanceOptions,
  guards: MaintenanceGuards = {},
): MaintenanceReport {
  const before = guards.preflight ?? inspectSqliteMaintenance(database, options);
  const resolved = resolveOptions(options);
  if (before.status !== "ok") return before;

  const totalCandidates = before.candidates.sessions + before.candidates.friendRequests;
  if (totalCandidates === 0) return before;
  if (resolved.maxDeleteRows === 0) {
    return {
      ...before,
      status: "skipped",
      issues: mergeIssues(before.issues, [{ code: "delete_limit_zero", count: 1 }]),
    };
  }

  const deleted = { sessions: 0, friendRequests: 0 };
  let committed = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    if (guards.expectedDataVersion !== undefined) {
      const currentDataVersion = readSqliteDataVersion(database);
      if (currentDataVersion !== guards.expectedDataVersion) {
        throw new MaintenanceFailure("database_changed_during_backup", "SQLite data changed after backup");
      }
    }

    const inTransaction = analyzeDatabase(database, options, resolved);
    if (inTransaction.report.status !== "ok") {
      database.exec("ROLLBACK");
      return inTransaction.report;
    }

    const snapshot = readProtectedSnapshot(database);
    const sessionIds = inTransaction.sessionCandidates
      .slice(0, resolved.maxDeleteRows)
      .map((candidate) => candidate.id);
    const remainingSlots = resolved.maxDeleteRows - sessionIds.length;
    const friendRequestIds = inTransaction.friendRequestCandidates
      .slice(0, remainingSlots)
      .map((candidate) => candidate.id);
    const deletedSessionIds = new Set(sessionIds);

    for (const id of sessionIds) {
      const result = database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      if (Number(result.changes) !== 1) {
        throw new MaintenanceFailure("delete_row_missing", "Session candidate disappeared during maintenance");
      }
      deleted.sessions += 1;
    }
    for (const id of friendRequestIds) {
      const result = database.prepare("DELETE FROM friend_requests WHERE id = ?").run(id);
      if (Number(result.changes) !== 1) {
        throw new MaintenanceFailure("delete_row_missing", "Friend request candidate disappeared during maintenance");
      }
      deleted.friendRequests += 1;
    }

    assertTransactionIntegrity(database);
    verifyProtectedSnapshot(database, snapshot, deletedSessionIds);
    database.exec("COMMIT");
    committed = true;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    return {
      ...before,
      status: "failed",
      deleted: { sessions: 0, friendRequests: 0 },
      remainingCandidates: totalCandidates,
      issues: mergeIssues(before.issues, [issueForError(error)]),
    };
  }

  if (!committed) return before;

  const after = inspectSqliteMaintenance(database, options);
  const status = after.status === "ok" ? "ok" : "failed";
  const issues = mergeIssues(before.issues, after.issues);
  if (after.status !== "ok") issues.push({ code: "post_commit_validation_failed", count: 1 });
  return {
    ...after,
    status,
    candidates: before.candidates,
    deleted,
    remainingCandidates: after.candidates.sessions + after.candidates.friendRequests,
    issues: mergeIssues([], issues),
  };
}

function resolveOptions(options: MaintenanceOptions): ResolvedOptions {
  const nowMs = parseTimestamp(options.now);
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxDeleteRows = options.maxDeleteRows ?? DEFAULT_MAX_DELETE_ROWS;
  if (nowMs === undefined) throw new Error("Maintenance now must be a valid timestamp");
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error("Maintenance retentionDays must be a non-negative integer");
  }
  if (!Number.isInteger(maxDeleteRows) || maxDeleteRows < 0) {
    throw new Error("Maintenance maxDeleteRows must be a non-negative integer");
  }
  return { nowMs, retentionDays, maxDeleteRows };
}

function analyzeDatabase(
  database: DatabaseSync,
  options: MaintenanceOptions,
  resolved: ResolvedOptions,
): Analysis {
  const issues = new IssueCollector();
  const pageStats = readPageStats(database);
  const schemaSupported = inspectSchema(database, issues);
  const integrity = readSqliteIntegrity(database);
  if (integrity.foreignKeyErrors.length > 0) issues.add("foreign_key_check", integrity.foreignKeyErrors.length);
  const integrityFailures = integrity.integrityResults.filter((result) => result !== "ok");
  if (integrityFailures.length > 0) issues.add("integrity_check", integrityFailures.length);

  if (!schemaSupported || integrity.foreignKeyErrors.length > 0 || integrityFailures.length > 0) {
    return {
      report: {
        status: "blocked",
        checkedAt: options.now,
        candidates: { sessions: 0, friendRequests: 0 },
        deleted: { sessions: 0, friendRequests: 0 },
        remainingCandidates: 0,
        ...pageStats,
        issues: issues.toArray(),
      },
      options: resolved,
      sessionCandidates: [],
      friendRequestCandidates: [],
    };
  }

  const sessionCandidates = findSessionCandidates(database, resolved, issues);
  const friendRequestCandidates = findFriendRequestCandidates(database, resolved, issues);
  return {
    report: {
      status: "ok",
      checkedAt: options.now,
      candidates: {
        sessions: sessionCandidates.length,
        friendRequests: friendRequestCandidates.length,
      },
      deleted: { sessions: 0, friendRequests: 0 },
      remainingCandidates: sessionCandidates.length + friendRequestCandidates.length,
      ...pageStats,
      issues: issues.toArray(),
    },
    options: resolved,
    sessionCandidates,
    friendRequestCandidates,
  };
}

function inspectSchema(database: DatabaseSync, issues: IssueCollector): boolean {
  const tables = new Set(
    (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<Record<string, unknown>>)
      .map((row) => String(row.name)),
  );
  const missingTables = REQUIRED_TABLES.filter((table) => !tables.has(table));
  if (missingTables.length > 0) issues.add("missing_required_table", missingTables.length);

  try {
    const version = readSchemaVersion(database);
    if (version !== LATEST_SCHEMA_VERSION) issues.add("unsupported_schema", 1);
  } catch {
    issues.add("invalid_migration_history", 1);
  }
  return missingTables.length === 0 && !issues.has("unsupported_schema") && !issues.has("invalid_migration_history");
}

function readPageStats(database: DatabaseSync): Pick<MaintenanceReport, "pageCount" | "freelistCount" | "pageSize"> {
  return {
    pageCount: readPragmaNumber(database, "page_count"),
    freelistCount: readPragmaNumber(database, "freelist_count"),
    pageSize: readPragmaNumber(database, "page_size"),
  };
}

function readPragmaNumber(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = Number(row ? Object.values(row)[0] : NaN);
  if (!Number.isFinite(value) || value < 0) throw new Error(`SQLite ${pragma} is invalid`);
  return value;
}

function findSessionCandidates(
  database: DatabaseSync,
  options: ResolvedOptions,
  issues: IssueCollector,
): SessionCandidate[] {
  const rows = database.prepare(`
    SELECT id, account_id, created_at, expires_at, revoked_at, last_seen_at
    FROM sessions
    ORDER BY id ASC
  `).all() as Array<Record<string, unknown>>;
  const latestLastSeen = new Map<string, number>();
  const invalidLastSeenAccounts = new Set<string>();
  for (const row of rows) {
    const accountId = String(row.account_id);
    const lastSeenAt = parseTimestamp(row.last_seen_at);
    if (lastSeenAt === undefined) {
      invalidLastSeenAccounts.add(accountId);
      issues.add("invalid_session_last_seen_at");
      continue;
    }
    const current = latestLastSeen.get(accountId);
    if (current === undefined || lastSeenAt > current) latestLastSeen.set(accountId, lastSeenAt);
  }

  const cutoffMs = options.nowMs - options.retentionDays * MILLISECONDS_PER_DAY;
  const candidates: SessionCandidate[] = [];
  for (const row of rows) {
    const accountId = String(row.account_id);
    const createdAt = parseTimestamp(row.created_at);
    const expiresAt = parseTimestamp(row.expires_at);
    const revokedAt = row.revoked_at === null ? undefined : parseTimestamp(row.revoked_at);
    const lastSeenAt = parseTimestamp(row.last_seen_at);
    if (createdAt === undefined || expiresAt === undefined || (row.revoked_at !== null && revokedAt === undefined)) {
      issues.add("invalid_session_timestamp");
      continue;
    }
    if (lastSeenAt === undefined) continue;
    const invalidatedAt = revokedAt ?? expiresAt;
    if (revokedAt !== undefined && revokedAt > options.nowMs) {
      issues.add("future_session_invalidation");
      continue;
    }
    if (invalidatedAt > options.nowMs) continue;
    if (invalidLastSeenAccounts.has(accountId)) continue;
    if (invalidatedAt < cutoffMs && lastSeenAt !== latestLastSeen.get(accountId)) {
      candidates.push({ id: String(row.id), accountId });
    }
  }
  return candidates;
}

function findFriendRequestCandidates(
  database: DatabaseSync,
  options: ResolvedOptions,
  issues: IssueCollector,
): FriendRequestCandidate[] {
  const rows = database.prepare(`
    SELECT id, status, created_at, resolved_at
    FROM friend_requests
    ORDER BY id ASC
  `).all() as Array<Record<string, unknown>>;
  const cutoffMs = options.nowMs - options.retentionDays * MILLISECONDS_PER_DAY;
  const candidates: FriendRequestCandidate[] = [];
  for (const row of rows) {
    const status = String(row.status);
    if (!RESOLVED_REQUEST_STATUSES.has(status)) {
      if (status !== "pending") issues.add("unsupported_friend_request_status");
      continue;
    }
    const createdAt = parseTimestamp(row.created_at);
    const resolvedAt = row.resolved_at === null ? undefined : parseTimestamp(row.resolved_at);
    if (createdAt === undefined || resolvedAt === undefined) {
      issues.add("invalid_friend_request_timestamp");
      continue;
    }
    if (createdAt > resolvedAt) {
      issues.add("friend_request_time_order");
      continue;
    }
    if (resolvedAt > options.nowMs) {
      issues.add("future_friend_request_resolution");
      continue;
    }
    if (resolvedAt < cutoffMs) candidates.push({ id: String(row.id) });
  }
  return candidates;
}

function readProtectedSnapshot(database: DatabaseSync): ProtectedSnapshot {
  // Maintenance only deletes sessions and resolved requests. Digest match metadata and
  // payload lengths instead of transferring large JSON payloads into JavaScript; the
  // write transaction also prevents concurrent writers while these snapshots are checked.
  const protectedTableQueries: Record<string, string> = {
    accounts: `SELECT id, username, display_name, steam64, role, enabled, dev, must_change_password, created_at, updated_at, last_login_at FROM accounts ORDER BY id`,
    friendships: "SELECT id, account_a_id, account_b_id, created_at FROM friendships ORDER BY id",
    matches: `SELECT id, map, created_at, completed_at,
      COALESCE(length(plan_json), -1) AS plan_json_length,
      COALESCE(length(result_json), -1) AS result_json_length,
      COALESCE(length(status_json), -1) AS status_json_length,
      COALESCE(length(server_json), -1) AS server_json_length,
      COALESCE(length(events_json), -1) AS events_json_length
      FROM matches ORDER BY id`,
    match_participants: "SELECT match_id, steam64, side FROM match_participants ORDER BY match_id, steam64",
  };
  const protectedTableDigests = Object.fromEntries(
    Object.entries(protectedTableQueries).map(([name, query]) => [
      name,
      digestStatement(database, query),
    ]),
  );
  const sessionIds = (database.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<Record<string, unknown>>)
    .map((row) => String(row.id));
  const pendingRequestIds = (database.prepare("SELECT id FROM friend_requests WHERE status = 'pending' ORDER BY id").all() as Array<Record<string, unknown>>)
    .map((row) => String(row.id));
  const latest = new Map<string, string | number>();
  const sessions = database.prepare("SELECT account_id, last_seen_at FROM sessions ORDER BY account_id, id").all() as Array<Record<string, unknown>>;
  for (const row of sessions) {
    const accountId = String(row.account_id);
    const timestamp = parseTimestamp(row.last_seen_at);
    if (timestamp === undefined) {
      latest.set(accountId, "invalid");
      continue;
    }
    const current = latest.get(accountId);
    if (current === "invalid") continue;
    if (current === undefined || timestamp > Number(current)) latest.set(accountId, timestamp);
  }
  const latestLastSeenByAccount = [...latest.entries()].sort(([left], [right]) => left.localeCompare(right));
  return { protectedTableDigests, sessionIds, pendingRequestIds, latestLastSeenByAccount };
}

function digestStatement(database: DatabaseSync, query: string): string {
  const hash = createHash("sha256");
  for (const row of database.prepare(query).iterate()) {
    hash.update(JSON.stringify(row));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function verifyProtectedSnapshot(
  database: DatabaseSync,
  before: ProtectedSnapshot,
  deletedSessionIds: Set<string>,
): void {
  const after = readProtectedSnapshot(database);
  for (const [name, digest] of Object.entries(before.protectedTableDigests)) {
    if (after.protectedTableDigests[name] !== digest) {
      throw new MaintenanceFailure("protected_table_changed", `Protected table changed: ${name}`);
    }
  }
  const expectedSessionIds = before.sessionIds.filter((id) => !deletedSessionIds.has(id));
  if (JSON.stringify(after.sessionIds) !== JSON.stringify(expectedSessionIds)) {
    throw new MaintenanceFailure("protected_session_changed", "Protected session set changed");
  }
  if (JSON.stringify(after.pendingRequestIds) !== JSON.stringify(before.pendingRequestIds)) {
    throw new MaintenanceFailure("pending_request_changed", "Pending friend request set changed");
  }
  if (JSON.stringify(after.latestLastSeenByAccount) !== JSON.stringify(before.latestLastSeenByAccount)) {
    throw new MaintenanceFailure("latest_last_seen_changed", "Latest last-seen state changed");
  }
}

function assertTransactionIntegrity(database: DatabaseSync): void {
  const integrity = readSqliteIntegrity(database);
  if (integrity.foreignKeyErrors.length > 0) {
    throw new MaintenanceFailure("foreign_key_check", "Foreign key check failed after maintenance");
  }
  if (integrity.integrityResults.some((result) => result !== "ok")) {
    throw new MaintenanceFailure("integrity_check", "Integrity check failed after maintenance");
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function failedReport(options: MaintenanceOptions, error: unknown): MaintenanceReport {
  return {
    status: "failed",
    checkedAt: options.now,
    candidates: { sessions: 0, friendRequests: 0 },
    deleted: { sessions: 0, friendRequests: 0 },
    remainingCandidates: 0,
    pageCount: 0,
    freelistCount: 0,
    pageSize: 0,
    issues: [issueForError(error)],
  };
}

function issueForError(error: unknown): MaintenanceIssue {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("busy") || message.includes("locked")) return { code: "database_busy", count: 1 };
  if (message.includes("malformed") || message.includes("corrupt") || message.includes("database disk image")) {
    return { code: "database_corruption", count: 1 };
  }
  if (message.includes("disk") || message.includes("ioerr") || message.includes("i/o")) return { code: "database_io_error", count: 1 };
  if (error instanceof MaintenanceFailure) return { code: error.code, count: 1 };
  return { code: "maintenance_failed", count: 1 };
}

function mergeIssues(first: MaintenanceIssue[], second: MaintenanceIssue[]): MaintenanceIssue[] {
  const counts = new Map<string, number>();
  for (const issue of [...first, ...second]) counts.set(issue.code, Math.max(counts.get(issue.code) ?? 0, issue.count));
  return [...counts.entries()].map(([code, count]) => ({ code, count }));
}
