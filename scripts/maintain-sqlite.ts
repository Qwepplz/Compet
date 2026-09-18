/// <reference types="node" />

import { access, stat, statfs } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
  createSqliteMaintenanceBackup,
  pruneSqliteMaintenanceBackups,
  runSqliteMaintenanceWithBackup,
  verifySqliteMaintenanceBackup,
} from "../src/storage/competDatabase.js";
import {
  acquireSqliteMaintenanceLease,
  inspectSqliteMaintenance,
  type MaintenanceMode,
  type MaintenanceIssue,
  type MaintenanceReport,
} from "../src/storage/sqliteMaintenance.js";
import { redactSensitiveText } from "../src/shared/redactSensitiveText.js";

export interface MaintenanceCommandArguments {
  databasePath: string;
  mode: MaintenanceMode;
}

export interface MaintenanceCommandResult {
  report: MaintenanceReport;
  compact?: CompactCommandResult;
}

export interface CompactCommandResult {
  status: "ok" | "blocked" | "failed";
  beforeBytes: number;
  afterBytes: number;
  requiredBytes: number;
  issues: MaintenanceIssue[];
}

export interface MaintenanceCommandOptions {
  now?: string;
}

export function maintenanceCommandSucceeded(
  result: Pick<MaintenanceCommandResult, "report" | "compact">,
): boolean {
  return result.report.status === "ok" && (result.compact === undefined || result.compact.status === "ok");
}

export function parseMaintenanceArguments(argv: string[]): MaintenanceCommandArguments {
  let databasePath: string | undefined;
  let mode: MaintenanceMode = "inspect";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--database") {
      databasePath = argv[++index];
      if (!databasePath) throw new Error("--database requires a file path");
      continue;
    }
    if (argument === "--mode") {
      const requestedMode = argv[++index];
      if (requestedMode !== "inspect" && requestedMode !== "clean" && requestedMode !== "compact") {
        throw new Error(`Unknown maintenance mode: ${String(requestedMode)}`);
      }
      mode = requestedMode;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!databasePath) throw new Error("--database is required");
  if (!path.isAbsolute(databasePath)) throw new Error("--database must be an absolute file path");
  return { databasePath: path.normalize(databasePath), mode };
}

export async function runMaintenanceCommand(
  argv: string[],
  options: MaintenanceCommandOptions = {},
): Promise<MaintenanceCommandResult> {
  const argumentsValue = parseMaintenanceArguments(argv);
  await access(argumentsValue.databasePath);
  const now = options.now ?? new Date().toISOString();
  if (argumentsValue.mode === "compact") {
    return runCompactCommand(argumentsValue.databasePath, now);
  }

  if (argumentsValue.mode === "inspect") {
    const database = new DatabaseSync(argumentsValue.databasePath, { readOnly: true });
    try {
      return { report: inspectSqliteMaintenance(database, { now, retentionDays: 30, maxDeleteRows: 5000 }) };
    } finally {
      if (database.isOpen) database.close();
    }
  }

  const lease = await acquireSqliteMaintenanceLease(argumentsValue.databasePath);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(argumentsValue.databasePath);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const report = await runSqliteMaintenanceWithBackup(
      database,
      path.join(path.dirname(argumentsValue.databasePath), "sqlite-backups"),
      { now, retentionDays: 30, maxDeleteRows: 5000 },
    );
    return { report };
  } finally {
    if (database?.isOpen) database.close();
    lease.release();
  }
}

async function runCompactCommand(databasePath: string, now: string): Promise<MaintenanceCommandResult> {
  const lease = await acquireSqliteMaintenanceLease(databasePath);
  let database: DatabaseSync | undefined;
  const backupDir = path.join(path.dirname(databasePath), "sqlite-backups");
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const beforeReport = inspectSqliteMaintenance(database, {
      now,
      retentionDays: 30,
      maxDeleteRows: 5000,
    });
    if (beforeReport.status !== "ok") {
      return {
        report: beforeReport,
        compact: {
          status: beforeReport.status === "blocked" ? "blocked" : "failed",
          beforeBytes: 0,
          afterBytes: 0,
          requiredBytes: 0,
          issues: beforeReport.issues,
        },
      };
    }

    const protectedDigest = readCompactProtectedDigest(database);
    let backupPath: string;
    try {
      backupPath = await createSqliteMaintenanceBackup(database, backupDir);
    } catch (error) {
      return {
        report: beforeReport,
        compact: {
          status: "failed",
          beforeBytes: 0,
          afterBytes: 0,
          requiredBytes: 0,
          issues: [compactIssueForError(error)],
        },
      };
    }
    try {
      verifySqliteMaintenanceBackup(backupPath);
      const beforeBytes = await databaseFilesSize(databasePath);
      const backupBytes = await databaseFilesSize(backupPath);
      const requiredBytes = beforeBytes * 2 + backupBytes;
      let availableBytes: number;
      try {
        availableBytes = await readAvailableBytes(databasePath);
      } catch {
        return {
          report: beforeReport,
          compact: {
            status: "failed",
            beforeBytes,
            afterBytes: beforeBytes,
            requiredBytes,
            issues: [{ code: "space_unavailable", count: 1 }],
          },
        };
      }
      if (availableBytes < requiredBytes) {
        return {
          report: beforeReport,
          compact: {
            status: "failed",
            beforeBytes,
            afterBytes: beforeBytes,
            requiredBytes,
            issues: [{ code: "insufficient_space", count: 1 }],
          },
        };
      }

      const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all() as Array<Record<string, unknown>>;
      const busy = Number(checkpoint[0]?.busy ?? 0);
      if (busy !== 0) {
        return {
          report: beforeReport,
          compact: {
            status: "failed",
            beforeBytes,
            afterBytes: beforeBytes,
            requiredBytes,
            issues: [{ code: "database_busy", count: 1 }],
          },
        };
      }

      database.exec("VACUUM");
      const finalCheckpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all() as Array<Record<string, unknown>>;
      if (Number(finalCheckpoint[0]?.busy ?? 0) !== 0) {
        throw new Error("SQLite WAL checkpoint is busy after VACUUM");
      }
      const afterReport = inspectSqliteMaintenance(database, {
        now,
        retentionDays: 30,
        maxDeleteRows: 5000,
      });
      if (afterReport.status !== "ok") {
        return {
          report: afterReport,
          compact: {
            status: "failed",
            beforeBytes,
            afterBytes: await databaseFilesSize(databasePath),
            requiredBytes,
            issues: afterReport.issues,
          },
        };
      }
      if (readCompactProtectedDigest(database) !== protectedDigest) {
        return {
          report: afterReport,
          compact: {
            status: "failed",
            beforeBytes,
            afterBytes: await databaseFilesSize(databasePath),
            requiredBytes,
            issues: [{ code: "protected_table_changed", count: 1 }],
          },
        };
      }

      const afterBytes = await databaseFilesSize(databasePath);
      await pruneSqliteMaintenanceBackups(backupDir);
      return {
        report: afterReport,
        compact: { status: "ok", beforeBytes, afterBytes, requiredBytes, issues: [] },
      };
    } catch (error) {
      const beforeBytes = await databaseFilesSize(databasePath).catch(() => 0);
      return {
        report: beforeReport,
        compact: {
          status: "failed",
          beforeBytes,
          afterBytes: beforeBytes,
          requiredBytes: 0,
          issues: [compactIssueForError(error)],
        },
      };
    }
  } finally {
    if (database?.isOpen) database.close();
    lease.release();
  }
}

async function databaseFilesSize(databasePath: string): Promise<number> {
  let total = 0;
  for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      total += Number((await stat(filePath)).size);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return total;
}

async function readAvailableBytes(databasePath: string): Promise<number> {
  const filesystem = await statfs(databasePath);
  return Number(filesystem.bavail) * Number(filesystem.bsize);
}

function readCompactProtectedDigest(database: DatabaseSync): string {
  const queries = [
    "SELECT id, username, display_name, steam64, role, enabled, dev, password_hash, must_change_password, created_at, updated_at, last_login_at FROM accounts ORDER BY id",
    "SELECT id, account_id, token_hash, created_at, expires_at, revoked_at, last_seen_at FROM sessions ORDER BY id",
    "SELECT id, account_a_id, account_b_id, created_at FROM friendships ORDER BY id",
    "SELECT id, from_account_id, to_account_id, status, created_at, resolved_at FROM friend_requests ORDER BY id",
    `SELECT id, map, created_at, completed_at,
      COALESCE(length(plan_json), -1) AS plan_json_length,
      COALESCE(length(result_json), -1) AS result_json_length,
      COALESCE(length(status_json), -1) AS status_json_length,
      COALESCE(length(server_json), -1) AS server_json_length,
      COALESCE(length(events_json), -1) AS events_json_length
      FROM matches ORDER BY id`,
    "SELECT match_id, steam64, side FROM match_participants ORDER BY match_id, steam64",
    "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
  ];
  const hash = createHash("sha256");
  for (const query of queries) {
    for (const row of database.prepare(query).iterate()) {
      hash.update(JSON.stringify(row));
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}

function compactIssueForError(error: unknown): MaintenanceIssue {
  const message = redactError(error).toLowerCase();
  if (message.includes("busy") || message.includes("locked")) return { code: "database_busy", count: 1 };
  if (message.includes("space") || message.includes("full") || message.includes("disk") || message.includes("enospc")) {
    return { code: "insufficient_space", count: 1 };
  }
  return { code: "sqlite_error", count: 1 };
}

function redactError(error: unknown): string {
  return redactSensitiveText(String(error instanceof Error ? error.message : error));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const argumentsValue = parseMaintenanceArguments(argv);
    if (argumentsValue.mode !== "inspect") {
      console.info("SQLite clean/compact requires the service and Manager database connections to be closed.");
    }
    const result = await runMaintenanceCommand(argv);
    console.log(JSON.stringify(result));
    if (!maintenanceCommandSucceeded(result)) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith("maintain-sqlite.")) {
  void main();
}
