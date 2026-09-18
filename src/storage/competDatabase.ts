import { backup, DatabaseSync } from "node:sqlite";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathExists } from "./jsonFile.js";
import {
  assertSqliteIntegrity,
  applySqliteMigrations,
  LATEST_SCHEMA_VERSION,
  readSchemaVersion,
  SQLITE_MIGRATIONS,
} from "./sqliteMigrations.js";
import {
  cleanSqliteMaintenance,
  acquireSqliteConnectionLease,
  acquireSqliteMaintenanceLease,
  attachSqliteConnectionLease,
  inspectSqliteMaintenance,
  readSqliteDataVersion,
  type MaintenanceOptions,
  type MaintenanceReport,
} from "./sqliteMaintenance.js";

export interface OpenCompetDatabaseOptions {
  maintenance?: MaintenanceOptions;
}

export function configureCompetDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA busy_timeout = 5000");
}

export function withDatabaseTransaction<T>(database: DatabaseSync, run: (database: DatabaseSync) => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export async function openCompetDatabase(
  recordsDir: string,
  options: OpenCompetDatabaseOptions = {},
): Promise<DatabaseSync> {
  await mkdir(recordsDir, { recursive: true });
  const databasePath = path.join(recordsDir, "compet.sqlite3");
  const lease = options.maintenance
    ? await acquireSqliteMaintenanceLease(databasePath)
    : await acquireSqliteConnectionLease(databasePath);
  let pendingLease: typeof lease | undefined = lease;
  let database: DatabaseSync | undefined;
  try {
    const exists = await pathExists(databasePath);
    if (!exists) {
      const { hasLegacyPersistence, importLegacyJsonData } = await import("./legacyJsonImporter.js");
      if (await hasLegacyPersistence(recordsDir)) {
        const report = await importLegacyJsonData(recordsDir, databasePath);
        console.info(`Legacy data migration completed: ${JSON.stringify(report)}`);
      }
    }

    database = new DatabaseSync(databasePath);
    configureCompetDatabase(database);
    const backupDir = path.join(recordsDir, "sqlite-backups");
    const currentVersion = readSchemaVersion(database);
    const pending = SQLITE_MIGRATIONS.some((migration) => migration.version > currentVersion);
    if (exists && pending) {
      await backupBeforeMigration(database, backupDir, currentVersion);
    }
    applySqliteMigrations(database);
    if (!options.maintenance) assertSqliteIntegrity(database);
    if (options.maintenance) {
      await runSqliteMaintenanceWithBackup(database, backupDir, options.maintenance);
    }
    if (exists) {
      const { cleanupLegacyPersistence, hasLegacyPersistence } = await import("./legacyJsonImporter.js");
      if (await hasLegacyPersistence(recordsDir)) await cleanupLegacyPersistence(recordsDir);
    }

    if (options.maintenance) {
      const connectionLease = await acquireSqliteConnectionLease(databasePath, true);
      pendingLease?.release();
      pendingLease = undefined;
      attachSqliteConnectionLease(database, connectionLease);
    } else {
      attachSqliteConnectionLease(database, lease);
      pendingLease = undefined;
    }
    return database;
  } catch (error) {
    if (database?.isOpen) database.close();
    pendingLease?.release();
    throw error;
  }
}

export async function runSqliteMaintenanceWithBackup(
  database: DatabaseSync,
  backupDir: string,
  options: MaintenanceOptions,
): Promise<MaintenanceReport> {
  const preview = inspectSqliteMaintenance(database, options);
  if (preview.status !== "ok") {
    if (isFatalMaintenanceReport(preview)) {
      throw new Error(`SQLite maintenance preflight ${preview.status}: ${preview.issues.map((issue) => issue.code).join(",")}`);
    }
    return skipMaintenance(preview, "maintenance_preflight_failed");
  }
  if (preview.candidates.sessions + preview.candidates.friendRequests === 0) return preview;

  let dataVersionBeforeBackup: number;
  try {
    dataVersionBeforeBackup = readSqliteDataVersion(database);
    const backupPath = await createSqliteMaintenanceBackup(database, backupDir);
    verifySqliteMaintenanceBackup(backupPath);
    if (readSqliteDataVersion(database) !== dataVersionBeforeBackup) {
      throw new Error("SQLite data changed while maintenance backup was created");
    }
  } catch (error) {
    const skipped = skipMaintenance(preview, "maintenance_backup_failed");
    console.warn(`SQLite maintenance skipped: ${JSON.stringify({ issues: skipped.issues, error: String(error) })}`);
    return skipped;
  }
  const report = cleanSqliteMaintenance(database, options, {
    expectedDataVersion: dataVersionBeforeBackup,
    preflight: preview,
  });
  if (report.status !== "ok") {
    if (isFatalMaintenanceReport(report)) {
      throw new Error(`SQLite maintenance ${report.status}: ${report.issues.map((issue) => issue.code).join(",")}`);
    }
    const skipped = skipMaintenance(report, "maintenance_clean_failed");
    console.warn(`SQLite maintenance skipped: ${JSON.stringify({ issues: skipped.issues })}`);
    return skipped;
  }
  try {
    await pruneSqliteMaintenanceBackups(backupDir);
  } catch (error) {
    console.warn(`SQLite maintenance backup pruning skipped: ${String(error)}`);
    return addMaintenanceIssue(report, "maintenance_backup_prune_failed");
  }
  console.info(`SQLite maintenance completed: ${JSON.stringify(report)}`);
  return report;
}

function skipMaintenance(report: MaintenanceReport, code: string): MaintenanceReport {
  return {
    ...addMaintenanceIssue(report, code),
    status: "skipped",
    deleted: { sessions: 0, friendRequests: 0 },
    remainingCandidates: report.candidates.sessions + report.candidates.friendRequests,
  };
}

function addMaintenanceIssue(report: MaintenanceReport, code: string): MaintenanceReport {
  const issues = new Map<string, number>();
  for (const issue of report.issues) issues.set(issue.code, Math.max(issues.get(issue.code) ?? 0, issue.count));
  issues.set(code, Math.max(issues.get(code) ?? 0, 1));
  return { ...report, issues: [...issues.entries()].map(([issueCode, count]) => ({ code: issueCode, count })) };
}

function isFatalMaintenanceReport(report: MaintenanceReport): boolean {
  if (report.status === "blocked") return true;
  const fatalCodes = new Set([
    "foreign_key_check",
    "integrity_check",
    "invalid_migration_history",
    "database_corruption",
    "post_commit_validation_failed",
  ]);
  return report.issues.some((issue) => fatalCodes.has(issue.code));
}

export async function createSqliteMaintenanceBackup(database: DatabaseSync, backupDir: string): Promise<string> {
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(
    backupDir,
    `compet-maintenance-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.sqlite3`,
  );
  try {
    await backup(database, backupPath);
    return backupPath;
  } catch (error) {
    await removeDatabaseFiles(backupPath);
    throw error;
  }
}

export function verifySqliteMaintenanceBackup(backupPath: string): void {
  const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (readSchemaVersion(backupDatabase) !== LATEST_SCHEMA_VERSION) {
      throw new Error("SQLite maintenance backup schema is unsupported");
    }
    assertSqliteIntegrity(backupDatabase);
  } finally {
    if (backupDatabase.isOpen) backupDatabase.close();
  }
}

export async function pruneSqliteMaintenanceBackups(backupDir: string): Promise<void> {
  const entries = await readdir(backupDir, { withFileTypes: true });
  const backups: Array<{ filePath: string; modifiedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("compet-maintenance-") || !entry.name.endsWith(".sqlite3")) continue;
    const filePath = path.join(backupDir, entry.name);
    backups.push({ filePath, modifiedAt: (await stat(filePath)).mtimeMs });
  }
  backups.sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const backupFile of backups.slice(2)) await removeDatabaseFiles(backupFile.filePath);
}

async function removeDatabaseFiles(filePath: string): Promise<void> {
  await Promise.all([
    rm(filePath, { force: true }),
    rm(`${filePath}-wal`, { force: true }),
    rm(`${filePath}-shm`, { force: true }),
  ]);
}

async function backupBeforeMigration(database: DatabaseSync, backupDir: string, currentVersion: number): Promise<void> {
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(
    backupDir,
    `compet-v${currentVersion}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.sqlite3`,
  );
  try {
    await backup(database, backupPath);
  } catch (error) {
    await removeDatabaseFiles(backupPath);
    throw error;
  }
}
