import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { assertManagedRelativePath, assertPlainPath, buildServerUpdatePlan, fingerprintFile, sameFingerprint,
  validatePackageInventory, type PackageFile, type PackageInventory, type FileFingerprint } from "../desktop/main/serverManagedFiles.js";
import { compareSemver } from "../shared/version.js";

const stateName = ".compet-run-csgo-state.json";
const transactionName = ".compet-run-csgo-transaction";
const stagingName = ".compet-run-csgo-staging";
const retiredName = ".compet-run-csgo-retired";
const active = new Set<string>();
const templatePaths = new Set(["csgo/cfg/1.cfg", "csgo/cfg/sourcemod/sourcemod.cfg"]);
const fingerprintText = (value: string): FileFingerprint => ({ size: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex").toUpperCase() });
interface AssetState { schemaVersion: 1; root: string; version: string; files: PackageFile[]; transactionId: string }
interface AssetEntry { path: string; before: FileFingerprint | null; backup: string; template?: FileFingerprint }
interface AssetJournal { schemaVersion: 2; intentCount: number; root: string; id: string; previous: AssetState | null; owned: PackageInventory | null; target: PackageInventory; entries: AssetEntry[] }
export interface RunCsgoAssetTransaction {
  writeTemplate(relative: string, current: string, next: string): Promise<boolean>;
  commit(): Promise<void>; rollback(): Promise<void>;
}
export interface AssetInstallInput {
  sourceRoot: string; serverRoot: string; version: string; files: PackageFile[];
  legacyFiles: ReadonlyArray<{ path: string; sha256: string; version: string }>;
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const asInventory = (version: string, files: PackageFile[]): PackageInventory =>
  validatePackageInventory({ schemaVersion: 1, appId: "compet-server-manager", version, files });

async function writeDurable(file: string, value: unknown): Promise<void> {
  await assertPlainPath(file);
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
function validateState(raw: unknown, root: string): AssetState {
  if (!raw || typeof raw !== "object") fail("asset_state_invalid");
  const value = raw as AssetState;
  if (value.schemaVersion !== 1 || value.root !== root || typeof value.transactionId !== "string") fail("asset_state_invalid");
  const inventory = asInventory(value.version, value.files);
  return { schemaVersion: 1, root, version: inventory.version, files: inventory.files, transactionId: value.transactionId };
}
async function readState(root: string): Promise<AssetState | null> {
  const file = path.join(root, stateName);
  await assertPlainPath(file);
  try { return validateState(JSON.parse(await readFile(file, "utf8")), root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function exists(directory: string): Promise<boolean> {
  await assertPlainPath(directory);
  try { return (await lstat(directory)).isDirectory() || fail("asset_transaction_invalid"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function cleanDirectory(directory: string, journal: AssetJournal | null): Promise<void> {
  const known = new Set(["journal.json", ...(journal?.entries ?? []).filter(entry => entry.before).map(entry => entry.backup)]);
  for (const entry of journal?.entries ?? []) if (entry.template) known.add(entry.backup + ".template");
  const names = await readdir(directory);
  for (const name of names) {
    const temporary = /^journal\.json\.[0-9a-f-]{36}\.tmp$/.test(name);
    if ((!known.has(name) && !temporary) || (!journal && name === "journal.json")) fail("asset_transaction_unknown");
    await assertPlainPath(path.join(directory, name));
    if (!(await lstat(path.join(directory, name))).isFile()) fail("asset_transaction_unknown");
  }
  for (const name of names.filter(name => name !== "journal.json")) await rm(path.join(directory, name));
  if (journal) await rm(path.join(directory, "journal.json"));
  await rmdir(directory);
}
async function cleanTransaction(root: string, journal: AssetJournal): Promise<void> {
  const retired = path.join(root, retiredName);
  await assertPlainPath(retired);
  await rename(path.join(root, transactionName), retired);
  await cleanDirectory(retired, journal);
}
async function readJournal(root: string, directory: string): Promise<AssetJournal> {
  await assertPlainPath(path.join(directory, "journal.json"));
  const raw: unknown = JSON.parse(await readFile(path.join(directory, "journal.json"), "utf8"));
  if (!raw || typeof raw !== "object") fail("asset_journal_invalid");
  const journal = raw as AssetJournal;
  if (journal.schemaVersion !== 2 || journal.root !== root || typeof journal.id !== "string" || !Array.isArray(journal.entries) ||
      !Number.isSafeInteger(journal.intentCount) || journal.intentCount < 0 || journal.intentCount > journal.entries.length) fail("asset_journal_invalid");
  if (journal.previous) validateState(journal.previous, root);
  const target = validatePackageInventory(journal.target);
  const owned = journal.owned ? validatePackageInventory(journal.owned) : null;
  const expectedPaths = [...new Set([...(owned?.files ?? []).map(file => file.path), ...target.files.map(file => file.path)])];
  if (expectedPaths.length !== journal.entries.length ||
      expectedPaths.some((relative, index) => relative !== journal.entries[index]?.path) ||
      journal.previous?.files.some(file => !owned?.files.some(old => old.path === file.path && sameFingerprint(old, file)))) fail("asset_journal_invalid");
  const seen = new Set<string>();
  for (const [index, entry] of journal.entries.entries()) {
    assertManagedRelativePath(entry.path);
    if (entry.path.toLowerCase().startsWith(".compet-") || seen.has(entry.path.toLowerCase()) || entry.backup !== index + ".bin") fail("asset_journal_invalid");
    seen.add(entry.path.toLowerCase());
    if (entry.template !== undefined && (!entry.template || !templatePaths.has(entry.path) ||
        journal.intentCount !== journal.entries.length || !target.files.some(file => file.path === entry.path) ||
        !Number.isSafeInteger(entry.template.size) || entry.template.size < 0 ||
        !/^[0-9A-F]{64}$/.test(entry.template.sha256))) fail("asset_journal_invalid");
    if (entry.before && (!Number.isSafeInteger(entry.before.size) || entry.before.size < 0 ||
        !/^[0-9A-F]{64}$/.test(entry.before.sha256))) fail("asset_journal_invalid");
  }
  return journal;
}
async function committed(root: string, journal: AssetJournal): Promise<boolean> {
  const current = await readState(root);
  if (current?.transactionId !== journal.id) return false;
  if (current.version !== journal.target.version || current.files.length !== journal.target.files.length ||
      current.files.some((file, index) => file.path !== journal.target.files[index]?.path)) fail("asset_state_invalid");
  for (const file of current.files) if (!sameFingerprint(await fingerprintFile(path.join(root, file.path)), file)) fail("asset_committed_file_invalid");
  for (const entry of journal.entries) {
    if (!current.files.some(file => file.path === entry.path) && await fingerprintFile(path.join(root, entry.path))) fail("asset_committed_file_invalid");
  }
  return true;
}
async function discardPhase(root: string, name: string): Promise<void> {
  const directory = path.join(root, name);
  if (!await exists(directory)) return;
  let journal: AssetJournal | null = null;
  // Missing journal is safe only in staging before backups or in an empty retired directory.
  if (await fingerprintFile(path.join(directory, "journal.json"))) journal = await readJournal(root, directory);
  if (journal && name === retiredName && !await committed(root, journal)) {
    const current = await readState(root);
    if (JSON.stringify(current) !== JSON.stringify(journal.previous)) fail("asset_state_invalid");
    for (const entry of journal.entries.slice(0, journal.intentCount)) if (!sameFingerprint(await fingerprintFile(path.join(root, entry.path)), entry.before)) fail("asset_recovery_failed");
  }
  await cleanDirectory(directory, journal);
}
async function restore(root: string): Promise<void> {
  await discardPhase(root, stagingName);
  await discardPhase(root, retiredName);
  const directory = path.join(root, transactionName);
  if (!await exists(directory)) return;
  const journal = await readJournal(root, directory);
  if (await committed(root, journal)) { await cleanTransaction(root, journal); return; }
  const written = journal.entries.slice(0, journal.intentCount);
  for (const entry of written) {
    if (entry.before && !sameFingerprint(await fingerprintFile(path.join(directory, entry.backup)), entry.before)) fail("asset_backup_invalid");
  }
  const conflicts: string[] = [];
  for (const entry of [...written].reverse()) {
    const target = path.join(root, entry.path);
    await assertPlainPath(target);
    const actual = await fingerprintFile(target);
    if (sameFingerprint(actual, entry.before)) continue;
    const intended = journal.target.files.find(file => file.path === entry.path) ?? null;
    if (!sameFingerprint(actual, intended) && !(entry.template && sameFingerprint(actual, entry.template))) {
      conflicts.push(entry.path);
      continue;
    }
    if (entry.before) {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(directory, entry.backup), target);
      const handle = await open(target, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      if (!sameFingerprint(await fingerprintFile(target), entry.before)) fail("asset_recovery_failed");
    } else await rm(target, { force: true });
  }
  if (conflicts.length) throw Object.assign(new Error("asset_recovery_conflict"), { code: "asset_recovery_conflict", paths: conflicts });
  if (journal.previous) await writeDurable(path.join(root, stateName), journal.previous);
  else await rm(path.join(root, stateName), { force: true });
  await cleanTransaction(root, journal);
}
export async function recoverRunCsgoAssets(serverRoot: string): Promise<void> {
  const root = path.resolve(serverRoot), key = root.toLowerCase();
  if (active.has(key)) fail("asset_transaction_busy");
  active.add(key);
  try { await restore(root); } finally { active.delete(key); }
}
export async function beginRunCsgoAssets(input: AssetInstallInput): Promise<RunCsgoAssetTransaction> {
  const root = path.resolve(input.serverRoot), key = root.toLowerCase();
  if (active.has(key)) fail("asset_transaction_busy");
  active.add(key);
  let journalCreated = false;
  try {
    await assertPlainPath(root);
    await mkdir(root, { recursive: true });
    await restore(root);
    const target = asInventory(input.version, input.files);
    if (target.files.some(file => file.path.toLowerCase().startsWith(".compet-"))) fail("asset_path_invalid");
    for (const file of target.files) {
      if (!sameFingerprint(await fingerprintFile(path.join(input.sourceRoot, file.path)), file)) fail("asset_source_invalid");
    }
    const previous = await readState(root);
    if (previous && compareSemver(target.version, previous.version) < 0) fail("asset_version_downgrade");
    const owned = [...(previous?.files ?? [])];
    for (const legacy of input.legacyFiles) {
      assertManagedRelativePath(legacy.path);
      if (owned.some(file => file.path.toLowerCase() === legacy.path.toLowerCase())) continue;
      const isTarget = target.files.some(file => file.path.toLowerCase() === legacy.path.toLowerCase());
      if (isTarget && previous) continue;
      const actual = await fingerprintFile(path.join(root, legacy.path));
      if (!actual) continue;
      if (actual.sha256 !== legacy.sha256.toUpperCase()) {
        if (isTarget) continue;
        fail("asset_legacy_conflict");
      }
      owned.push({ path: legacy.path, ...actual });
    }
    const current = owned.length ? asInventory(previous?.version ?? target.version, owned) : null;
    const difference = await buildServerUpdatePlan({ root, current, target, protectedPaths: [] });
    if (difference.conflicts.length) fail(difference.conflicts[0]!.code);
    const allPaths = [...new Set([...owned.map(file => file.path), ...target.files.map(file => file.path)])];
    const journal: AssetJournal = { schemaVersion: 2, intentCount: 0, root, id: randomUUID(), previous, owned: current, target, entries: [] };
    const directory = path.join(root, stagingName);
    for (const [index, relative] of allPaths.entries()) {
      journal.entries.push({ path: relative, before: await fingerprintFile(path.join(root, relative)), backup: index + ".bin" });
    }
    await mkdir(directory);
    await writeDurable(path.join(directory, "journal.json"), journal);
    for (const entry of journal.entries) {
      if (entry.before) {
        await copyFile(path.join(root, entry.path), path.join(directory, entry.backup));
        const handle = await open(path.join(directory, entry.backup), "r+");
        try { await handle.sync(); } finally { await handle.close(); }
        if (!sameFingerprint(await fingerprintFile(path.join(directory, entry.backup)), entry.before)) fail("asset_backup_invalid");
      }
    }
    for (const entry of journal.entries) if (!sameFingerprint(await fingerprintFile(path.join(root, entry.path)), entry.before)) fail("asset_target_changed");
    await rename(directory, path.join(root, transactionName));
    journalCreated = true;
    for (const entry of journal.entries) {
      const destination = path.join(root, entry.path);
      if (!sameFingerprint(await fingerprintFile(destination), entry.before)) fail("asset_target_changed");
      // Persist intent before mutation so a crash during copy/delete remains recoverable.
      const nextJournal = { ...journal, intentCount: journal.intentCount + 1 };
      await writeDurable(path.join(root, transactionName, "journal.json"), nextJournal);
      journal.intentCount = nextJournal.intentCount;
      if (!sameFingerprint(await fingerprintFile(destination), entry.before)) fail("asset_target_changed");
      const file = target.files.find(file => file.path === entry.path);
      if (file) {
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(input.sourceRoot, file.path), destination);
        if (!sameFingerprint(await fingerprintFile(destination), file)) fail("asset_source_invalid");
      } else await rm(destination, { force: true });
    }
    let finished = false;
    const release = () => { finished = true; active.delete(key); };
    return {
      writeTemplate: async (relative, current, next) => {
        if (finished) fail("asset_transaction_closed");
        if (!templatePaths.has(relative)) fail("asset_template_invalid");
        const published = target.files.find(file => file.path === relative);
        if (!published) return false;
        const entry = journal.entries.find(entry => entry.path === relative)!;
        if (entry.template) fail("asset_template_already_written");
        const destination = path.join(root, relative);
        if (!sameFingerprint(fingerprintText(current), published) ||
            !sameFingerprint(await fingerprintFile(destination), published)) fail("asset_target_changed");
        const template = fingerprintText(next);
        const entries = journal.entries.map(item => item === entry ? { ...item, template } : item);
        await writeDurable(path.join(root, transactionName, "journal.json"), { ...journal, entries });
        journal.entries = entries;
        const temporary = path.join(root, transactionName, entry.backup + ".template");
        const handle = await open(temporary, "wx");
        try { await handle.writeFile(next); await handle.sync(); } finally { await handle.close(); }
        if (!sameFingerprint(await fingerprintFile(temporary), template)) fail("asset_template_invalid");
        if (!sameFingerprint(await fingerprintFile(destination), published)) fail("asset_target_changed");
        await rename(temporary, destination);
        if (!sameFingerprint(await fingerprintFile(destination), template)) fail("asset_target_changed");
        return true;
      },
      commit: async () => {
        if (finished) fail("asset_transaction_closed");
        try {
          const files: PackageFile[] = [];
          for (const file of target.files) {
            const actual = await fingerprintFile(path.join(root, file.path));
            if (!actual) fail("asset_target_missing");
            const expected = journal.entries.find(entry => entry.path === file.path)?.template ?? file;
            if (!sameFingerprint(actual, expected)) fail("asset_target_changed");
            const handle = await open(path.join(root, file.path), "r+");
            try { await handle.sync(); } finally { await handle.close(); }
            files.push({ path: file.path, ...actual });
          }
          await writeDurable(path.join(root, stateName), { schemaVersion: 1, root, version: target.version, files, transactionId: journal.id });
          await cleanTransaction(root, journal);
          release();
        } catch (error) { try { await restore(root); } finally { release(); } throw error; }
      },
      rollback: async () => { if (finished) return; try { await restore(root); } finally { release(); } },
    };
  } catch (error) {
    try { if (journalCreated) await restore(root); else await discardPhase(root, stagingName); } finally { active.delete(key); }
    throw error;
  }
}
