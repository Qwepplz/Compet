import { backup, DatabaseSync } from "node:sqlite";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathExists } from "./jsonFile.js";
import { assertSqliteIntegrity, applySqliteMigrations, readSchemaVersion, SQLITE_MIGRATIONS } from "./sqliteMigrations.js";

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

export async function openCompetDatabase(recordsDir: string): Promise<DatabaseSync> {
  await mkdir(recordsDir, { recursive: true });
  const databasePath = path.join(recordsDir, "compet.sqlite3");
  const exists = await pathExists(databasePath);
  if (!exists) {
    const { hasLegacyPersistence, importLegacyJsonData } = await import("./legacyJsonImporter.js");
    if (await hasLegacyPersistence(recordsDir)) {
      await importLegacyJsonData(recordsDir, databasePath);
    }
  }

  const database = new DatabaseSync(databasePath);
  try {
    configureCompetDatabase(database);
    const backupDir = path.join(recordsDir, "sqlite-backups");
    const currentVersion = readSchemaVersion(database);
    const pending = SQLITE_MIGRATIONS.some((migration) => migration.version > currentVersion);
    if (exists && pending) {
      await backupBeforeMigration(database, backupDir, currentVersion);
    }
    applySqliteMigrations(database);
    assertSqliteIntegrity(database);
    if (exists) {
      const { cleanupLegacyPersistence, hasLegacyPersistence } = await import("./legacyJsonImporter.js");
      if (await hasLegacyPersistence(recordsDir)) await cleanupLegacyPersistence(recordsDir);
    }
    return database;
  } catch (error) {
    if (database.isOpen) database.close();
    throw error;
  }
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
    await rm(backupPath, { force: true });
    throw error;
  }
}
