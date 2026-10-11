import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import type { IntegrityReport } from "../updateTypes.js";
import path from "node:path";
import { assertPlainPath, assertServerProgramRelativePath, fingerprintFile, sameFingerprint, pathsOverlap, validatePackageInventory, type ManagedFileOperation, type PackageFile } from "./serverManagedFiles.js";

export interface MaintenanceTransaction {
  protocol: 2 | 4;
  root: string;
  exe: string;
  targetVersion: string;
  state: "prepared" | "applying" | "applied" | "rolled_back" | "recovery_failed" | "verified";
  error?: string;
  recoveryPhase?: "prepared" | "applying" | "applied";
}

export interface MaintenancePlan {
  protocol?: 2 | 4;
  protectedPaths?: string[];
  operations?: ManagedFileOperation[];
  expectedFiles?: PackageFile[];
  baselineFiles?: PackageFile[];
  root: string;
  exe: string;
  targetVersion: string;
  helper: { size: number; sha256: string };
  files: Array<{ source: string; path: string; size: number; sha256: string }>;
}

export interface ServerMaintenancePlan extends Omit<MaintenancePlan, "files"> {
  protocol: 4;
  protectedPaths: string[];
  operations: ManagedFileOperation[];
  expectedFiles: PackageFile[];
  baselineFiles: PackageFile[];
}

const states = new Set<MaintenanceTransaction["state"]>([
  "prepared", "applying", "applied", "rolled_back", "recovery_failed", "verified",
]);
const hashPattern = /^[A-F0-9]{64}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function assertDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || ![".compet-maintenance", ".compet-maintenance-staging", ".compet-maintenance-retired"].includes(path.basename(directory))) {
    throw new Error("Invalid maintenance directory");
  }
}

async function ensureDirectory(directory: string): Promise<boolean> {
  assertDirectory(directory);
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid maintenance directory");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function decode(value: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid maintenance path encoding");
  }
  const bytes = Buffer.from(value, "base64");
  const decoded = bytes.toString("utf8");
  if (!decoded || !Buffer.from(decoded, "utf8").equals(bytes)) throw new Error("Invalid maintenance path encoding");
  return decoded;
}

function assertRelative(value: string): void {
  if (!value || value.includes("\\") || path.isAbsolute(value) ||
      value.split("/")[0]?.toLowerCase().startsWith(".compet-maintenance") ||
      value.split("/").some(part => !part || part === "." || part === ".." ||
        /[<>:"|?*]/.test(part) || [...part].some(char => char.charCodeAt(0) < 32))) {
    throw new Error("Invalid maintenance relative path");
  }
}

function assertSizeAndHash(size: number, sha256: string): void {
  if (!Number.isSafeInteger(size) || size < 0 || !hashPattern.test(sha256)) {
    throw new Error("Invalid maintenance size or hash");
  }
}

function parseSizeAndHash(fields: string[]): { size: number; sha256: string } {
  if (fields.length !== 2 || !/^(0|[1-9]\d*)$/.test(fields[0] ?? "")) {
    throw new Error("Invalid maintenance size or hash");
  }
  const size = Number(fields[0]);
  const sha256 = fields[1] ?? "";
  assertSizeAndHash(size, sha256);
  return { size, sha256 };
}

function parsePlan(directory: string, text: string): MaintenancePlan {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length < 5 || !["protocol=2", "protocol=4"].includes(lines[0] ?? "") ||
      !lines[1]?.startsWith("root=") || !lines[2]?.startsWith("exe=") ||
      !lines[3]?.startsWith("target=") || !lines[4]?.startsWith("helper=")) {
    throw new Error("Invalid maintenance plan");
  }
  const root = decode(lines[1].slice(5));
  const exe = decode(lines[2].slice(4));
  const targetVersion = decode(lines[3].slice(7));
  if (!path.isAbsolute(root) || path.relative(root, path.dirname(directory)) ||
      !versionPattern.test(targetVersion)) {
    throw new Error("Invalid maintenance plan identity");
  }
  assertRelative(exe);
  const helper = parseSizeAndHash(lines[4].slice(7).split("\t"));
  if (lines[0] === "protocol=4") return parseServerEntries({ root, exe, targetVersion, helper }, lines.slice(5));
  const files: MaintenancePlan["files"] = [];
  const targets = new Set<string>();
  for (const line of lines.slice(5)) {
    if (!line.startsWith("file=")) throw new Error("Invalid maintenance plan entry");
    const fields = line.slice(5).split("\t");
    if (fields.length !== 4) throw new Error("Invalid maintenance plan entry");
    const source = decode(fields[0]!);
    const target = decode(fields[1]!);
    const { size, sha256 } = parseSizeAndHash(fields.slice(2));
    assertRelative(source);
    assertRelative(target);
    if (source !== "files/" + sha256 || targets.has(target.toLowerCase())) {
      throw new Error("Invalid maintenance plan entry");
    }
    targets.add(target.toLowerCase());
    files.push({ source, path: target, size, sha256 });
  }
  return { root, exe, targetVersion, helper, files };
}

function serializePlan(directory: string, plan: MaintenancePlan | ServerMaintenancePlan): string {
  const lines = [
    "protocol=" + (plan.protocol ?? 2),
    "root=" + encode(plan.root),
    "exe=" + encode(plan.exe),
    "target=" + encode(plan.targetVersion),
    "helper=" + plan.helper.size + "\t" + plan.helper.sha256,
    ...(plan.protocol === 4 ? serializeServerEntries(plan) : (plan as MaintenancePlan).files.map(file => "file=" + encode(file.source) + "\t" + encode(file.path) +
      "\t" + file.size + "\t" + file.sha256)),
  ];
  const text = lines.join("\n") + "\n";
  parsePlan(directory, text);
  return text;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporary = filePath + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readMaintenancePlan(directory: string): Promise<MaintenancePlan> {
  try {
    return parsePlan(directory, await readFile(path.join(directory, "plan.txt"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Maintenance transaction incomplete: plan");
    throw error;
  }
}

export async function writeMaintenancePlan(directory: string, plan: MaintenancePlan | ServerMaintenancePlan, manifest: unknown): Promise<void> {
  if (!(await ensureDirectory(directory))) throw new Error("Maintenance transaction directory missing");
  const text = serializePlan(directory, plan);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Invalid maintenance manifest");
  }
  await atomicWrite(path.join(directory, "manifest.json"), JSON.stringify(manifest) + "\n");
  await atomicWrite(path.join(directory, "plan.txt"), text);
}

export async function readMaintenanceManifest(directory: string): Promise<unknown> {
  if (!(await ensureDirectory(directory))) throw new Error("Maintenance transaction directory missing");
  try {
    const value: unknown = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid maintenance manifest");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Maintenance transaction incomplete: manifest");
    throw error;
  }
}

export async function writeMaintenanceTransaction(directory: string, value: MaintenanceTransaction): Promise<void> {
  if (!(await ensureDirectory(directory))) throw new Error("Maintenance transaction directory missing");
  const plan = await readMaintenancePlan(directory);
  if (value.protocol !== (plan.protocol ?? 2) || value.root !== plan.root || value.exe !== plan.exe ||
      value.targetVersion !== plan.targetVersion || !states.has(value.state) ||
      (value.error !== undefined && !/^[a-z0-9_]+$/.test(value.error)) ||
      (value.recoveryPhase !== undefined && (value.state !== "recovery_failed" ||
        value.error === undefined || !["prepared", "applying", "applied"].includes(value.recoveryPhase)))) {
    throw new Error("Invalid maintenance transaction state");
  }
  const lines = ["protocol=" + value.protocol, "state=" + value.state];
  if (value.error !== undefined) lines.push("error=" + value.error);
  if (value.recoveryPhase !== undefined) lines.push("phase=" + value.recoveryPhase);
  await atomicWrite(path.join(directory, "result.txt"), lines.join("\n") + "\n");
}

export async function readMaintenanceTransaction(directory: string): Promise<MaintenanceTransaction | null> {
  if (!(await ensureDirectory(directory))) return null;
  const plan = await readMaintenancePlan(directory);
  await readMaintenanceManifest(directory);
  if (path.basename(directory) === ".compet-maintenance-retired" && plan.protocol !== 4) throw new Error("Invalid maintenance directory");
  return readMaintenanceResult(directory, plan);
}

async function readMaintenanceResult(directory: string, plan: MaintenancePlan): Promise<MaintenanceTransaction> {
  let text: string;
  try {
    text = await readFile(path.join(directory, "result.txt"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Maintenance transaction incomplete: result");
    throw error;
  }
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length < 2 || lines.length > 4 || lines[0] !== "protocol=" + (plan.protocol ?? 2) ||
      !lines[1]?.startsWith("state=") ||
      (lines.length >= 3 && !lines[2]?.startsWith("error=")) ||
      (lines.length === 4 && !lines[3]?.startsWith("phase="))) {
    throw new Error("Invalid maintenance transaction result");
  }
  const state = lines[1].slice(6) as MaintenanceTransaction["state"];
  const error = lines[2]?.slice(6);
  const recoveryPhase = lines[3]?.slice(6) as MaintenanceTransaction["recoveryPhase"];
  if (!states.has(state) || (error !== undefined && !/^[a-z0-9_]+$/.test(error)) ||
      (recoveryPhase !== undefined && (state !== "recovery_failed" ||
        !["prepared", "applying", "applied"].includes(recoveryPhase)))) {
    throw new Error("Invalid maintenance transaction state");
  }
  return { protocol: plan.protocol ?? 2, root: plan.root, exe: plan.exe, targetVersion: plan.targetVersion, state,
    ...(error === undefined ? {} : { error }),
    ...(recoveryPhase === undefined ? {} : { recoveryPhase }) };
}

export interface MaintenanceJournalEntry {
  temporary?: string;
  path: string;
  existed: boolean;
  backup: string;
  size: number;
  sha256: string;
}

export async function readMaintenanceJournal(
  directory: string,
  requireComplete = false,
): Promise<MaintenanceJournalEntry[]> {
  const plan = await readMaintenancePlan(directory);
  let text: string;
  try {
    text = await readFile(path.join(directory, "journal.txt"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (requireComplete) throw new Error("Invalid maintenance journal");
      return [];
    }
    throw error;
  }
  const lines = text.trimEnd().split(/\r?\n/);
  if (plan.protocol === 4) {
    const expectedCount = lines.length - 2;
    if (expectedCount < 0 || lines.pop() !== "count=" + expectedCount) throw new Error("Invalid maintenance journal");
  }
  if (lines[0] !== "protocol=" + (plan.protocol ?? 2) || lines.length > plan.files.length + 1 ||
      (requireComplete && lines.length !== plan.files.length + 1)) {
    throw new Error("Invalid maintenance journal");
  }
  const entries: MaintenanceJournalEntry[] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    if (!line.startsWith("entry=")) throw new Error("Invalid maintenance journal");
    const fields = line.slice(6).split("\t");
    if (fields.length !== (plan.protocol === 4 ? 6 : 5) || !["0", "1"].includes(fields[1] ?? "")) {
      throw new Error("Invalid maintenance journal");
    }
    const entry = {
      path: decode(fields[0]!),
      existed: fields[1] === "1",
      backup: decode(fields[2]!),
      ...parseSizeAndHash([fields[3]!, fields[4]!]),
    };
    if (entry.path.toLowerCase() !== plan.files[index]?.path.toLowerCase() ||
        entry.backup !== "backup/" + index + ".bin") {
      throw new Error("Invalid maintenance journal");
    }
    const operation = plan.operations?.[index];
    if (plan.protocol === 4 && (!operation || entry.existed !== !!operation.before ||
        (operation.before && (entry.size !== operation.before.size || entry.sha256 !== operation.before.sha256)))) {
      throw new Error("Invalid maintenance journal before image");
    }
    if (plan.protocol === 4) {
      const temporary = decode(fields[5]!);
      assertServerProgramRelativePath(temporary);
      if (!operation || path.posix.dirname(temporary).toLowerCase() !== path.posix.dirname(operation.path).toLowerCase() ||
          !/^\.compet-[0-9a-f]{32}\.tmp$/.test(path.posix.basename(temporary)) ||
          [...plan.expectedFiles ?? [], ...plan.baselineFiles ?? []].some(f => f.path.toLowerCase() === temporary.toLowerCase()) ||
          (!operation?.before && (entry.size !== 0 || entry.sha256 !== "0".repeat(64)))) throw new Error("Invalid maintenance temporary");
      Object.assign(entry, { temporary });
    }
    entries.push(entry);
  }
  return entries;
}

function validSummary(report: IntegrityReport): boolean {
  return report.stage === "verifying" && ["passed", "unavailable"].includes(report.status) &&
    typeof report.version === "string" && typeof report.currentVersion === "string" &&
    Array.isArray(report.issues) && Number.isSafeInteger(report.totalFiles) &&
    Number.isSafeInteger(report.checkedFiles);
}

function parseSummary(raw: string): IntegrityReport {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !validSummary(value as IntegrityReport)) throw new Error("Invalid maintenance summary");
  return value as IntegrityReport;
}

export async function writeMaintenanceSummary(directory: string, report: IntegrityReport): Promise<void> {
  if (!(await ensureDirectory(directory)) || !validSummary(report)) {
    throw new Error("Invalid maintenance summary");
  }
  await atomicWrite(path.join(directory, "summary.json"), JSON.stringify(report) + "\n");
}

export async function readMaintenanceSummary(directory: string): Promise<IntegrityReport | null> {
  if (!(await ensureDirectory(directory))) return null;
  try { return parseSummary(await readFile(path.join(directory, "summary.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function receiptPath(root: string): string {
  if (!path.isAbsolute(root)) throw new Error("Invalid maintenance receipt root");
  return path.join(root, ".compet-maintenance-result.json");
}

async function checkReceiptFile(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid maintenance receipt");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function writeMaintenanceReceipt(root: string, report: IntegrityReport): Promise<void> {
  const file = receiptPath(root);
  if (!validSummary(report) || report.status !== "passed") throw new Error("Invalid maintenance receipt");
  await checkReceiptFile(file);
  await atomicWrite(file, JSON.stringify(report) + "\n");
}

export async function readMaintenanceReceipt(root: string): Promise<IntegrityReport | null> {
  const file = receiptPath(root);
  if (!(await checkReceiptFile(file))) return null;
  const report = parseSummary(await readFile(file, "utf8"));
  if (report.status !== "passed") throw new Error("Invalid maintenance receipt");
  return report;
}

export async function clearMaintenanceReceipt(root: string): Promise<void> {
  const file = receiptPath(root);
  if (await checkReceiptFile(file)) await rm(file);
}

async function knownPayloadFiles(
  directory: string,
  folder: "files" | "backup",
  allowed: Set<string>,
): Promise<string[]> {
  const target = path.join(directory, folder);
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unknown maintenance payload");
  const names = await readdir(target);
  if (names.some(name => !allowed.has(name))) throw new Error("Unknown maintenance payload");
  for (const name of names) {
    const file = await lstat(path.join(target, name));
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("Unknown maintenance payload");
  }
  return names.map(name => path.join(target, name));
}

export async function cleanupMaintenancePayload(directory: string): Promise<void> {
  const plan = await readMaintenancePlan(directory);
  const journal = await readMaintenanceJournal(directory);
  const content = new Set([...(plan.protocol === 4 ? plan.expectedFiles! : plan.files).map(file => file.sha256), plan.helper.sha256]);
  const backups = await allowedMaintenanceBackups(directory, plan, journal);
  const files = await knownPayloadFiles(directory, "files", content);
  const backupFiles = await knownPayloadFiles(directory, "backup", backups);
  for (const file of [...files, ...backupFiles]) await rm(file);
  for (const folder of ["files", "backup"]) {
    try { await rmdir(path.join(directory, folder)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function clearMaintenanceStaging(directory: string): Promise<void> {
  if (path.basename(directory) !== ".compet-maintenance-staging") {
    throw new Error("Invalid maintenance staging directory");
  }
  if (!(await ensureDirectory(directory))) return;
  const names = await readdir(directory);
  const known = new Set(["files", "manifest.json", "plan.txt", "result.txt", "Compet Updater.exe"]);
  const atomicTemporary = /^(?:manifest\.json|plan\.txt|result\.txt)\.(?:[0-9a-f-]{36}|[0-9a-f]{32})\.tmp$/i;
  if (names.some(name => !known.has(name) && !atomicTemporary.test(name))) {
    throw new Error("Unknown maintenance staging content");
  }
  for (const name of names) {
    const target = path.join(directory, name);
    const info = await lstat(target);
    if (info.isSymbolicLink() || (name === "files" ? !info.isDirectory() : !info.isFile())) {
      throw new Error("Unknown maintenance staging content");
    }
    if (name === "files") {
      const files = await readdir(target);
      const content = /^[A-F0-9]{64}(?:\.[0-9a-f-]{36}\.tmp)?$/i;
      for (const file of files) {
        if (!content.test(file) || !(await lstat(path.join(target, file))).isFile()) {
          throw new Error("Unknown maintenance staging content");
        }
      }
    }
  }
  await rm(directory, { recursive: true });
}

async function validateTerminalContents(directory: string, server = false): Promise<void> {
  const known = new Set(["plan.txt", "manifest.json", "result.txt", "journal.txt",
    "summary.json", "Compet Updater.exe", "files", "backup"]);
  if (server) known.delete("summary.json");
  for (const name of await readdir(directory)) {
    if (!known.has(name) && !(server && /^(manifest\.json|plan\.txt|result\.txt|journal\.txt)\.[0-9a-f]{32}\.tmp$/.test(name))) {
      throw new Error("Unknown maintenance transaction content");
    }
    const target = path.join(directory, name);
    const info = await lstat(target);
    if (info.isSymbolicLink() || (name === "files" || name === "backup" ? !info.isDirectory() : !info.isFile())) {
      throw new Error("Unknown maintenance transaction content");
    }
    if (name === "files" || name === "backup") {
      const validName = name === "files" ? hashPattern : /^(0|[1-9]\d*)\.bin$/;
      for (const child of await readdir(target)) {
        if (!validName.test(child)) throw new Error("Unknown maintenance transaction content");
        const childInfo = await lstat(path.join(target, child));
        if (!childInfo.isFile() || childInfo.isSymbolicLink()) {
          throw new Error("Unknown maintenance transaction content");
        }
      }
    }
  }
}

export async function readServerMaintenanceState(directory: string): Promise<MaintenanceTransaction["state"] | null> {
  const plan = await readMaintenancePlan(directory);
  if (plan.protocol !== 4) throw new Error("Invalid server maintenance plan");
  if (!(await fingerprintFile(path.join(directory, "result.txt"))) && path.basename(directory) === ".compet-maintenance-retired") return null;
  return (await readMaintenanceResult(directory, plan)).state;
}

export async function validateServerTerminalTransaction(directory: string): Promise<void> {
  const plan = await readServerMaintenancePlan(directory);
  if (![".compet-maintenance", ".compet-maintenance-retired"].some(name => directory === path.join(plan.root, name))) {
    throw new Error("Invalid maintenance transaction directory");
  }
  const state = await readServerMaintenanceState(directory);
  if (state !== null && state !== "verified" && state !== "rolled_back") throw new Error("Maintenance transaction is not terminal");
  await validateTerminalContents(directory, true);
  const journal = await readMaintenanceJournal(directory);
  const payload = await knownPayloadFiles(directory, "files", new Set(plan.expectedFiles.map(file => file.sha256)));
  await knownPayloadFiles(directory, "backup", await allowedMaintenanceBackups(directory, { ...plan, files: [] }, journal));
  for (const file of payload) {
    const actual = await fingerprintFile(file);
    if (!plan.expectedFiles.some(expected => expected.sha256 === path.basename(file) && sameFingerprint(expected, actual))) {
      throw new Error("Invalid maintenance payload");
    }
  }
  const helper = await fingerprintFile(path.join(directory, "Compet Updater.exe"));
  if (helper && !sameFingerprint(helper, plan.helper)) throw new Error("Invalid maintenance helper");
  if (await fingerprintFile(path.join(directory, "manifest.json"))) {
    const manifest = await readMaintenanceManifest(directory) as { inventory?: unknown };
    const inventory = validatePackageInventory(manifest.inventory, true);
    const expected = plan.expectedFiles.filter(file => file.path !== "compet-package-manifest.json");
    if (inventory.version !== plan.targetVersion || inventory.files.length !== expected.length ||
        inventory.files.some(file => !expected.some(candidate => candidate.path === file.path && sameFingerprint(candidate, file)))) {
      throw new Error("Invalid maintenance manifest");
    }
  } else if (path.basename(directory) !== ".compet-maintenance-retired") throw new Error("Maintenance transaction incomplete: manifest");
}

export async function clearServerTerminalTransaction(directory: string): Promise<void> {
  await validateServerTerminalTransaction(directory);
  const plan = await readServerMaintenancePlan(directory);
  const root = path.dirname(directory), active = path.join(root, ".compet-maintenance"), retired = path.join(root, ".compet-maintenance-retired");
  if (directory === active) {
    if (await ensureDirectory(retired)) throw new Error("Maintenance transaction conflict");
    await rename(directory, retired);
  } else if (await ensureDirectory(active)) throw new Error("Maintenance transaction conflict");
  async function removeEmptyProgramDirectories(parent: string): Promise<void> {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const child = path.join(parent, entry.name);
      if (child === retired || plan.protectedPaths.some(p => child.toLowerCase() === p.toLowerCase() || child.toLowerCase().startsWith(p.toLowerCase() + path.sep))) continue;
      await assertPlainPath(child);
      if (!entry.isDirectory()) continue;
      await removeEmptyProgramDirectories(child);
      if (!plan.protectedPaths.some(p => p.toLowerCase().startsWith(child.toLowerCase() + path.sep)) && (await readdir(child)).length === 0) await rmdir(child);
    }
  }
  await removeEmptyProgramDirectories(root);
  await cleanupMaintenancePayload(retired);
  for (const name of await readdir(retired)) {
    if (name !== "plan.txt" && name !== "result.txt") await rm(path.join(retired, name));
  }
  await rm(path.join(retired, "result.txt"), { force: true });
  await rm(path.join(retired, "plan.txt"));
  await rmdir(retired);
}

export async function clearRetiredMaintenance(root: string): Promise<void> {
  if (!path.isAbsolute(root)) throw new Error("Invalid maintenance root");
  const directory = path.join(root, ".compet-maintenance-retired");
  let info;
  try { info = await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unknown maintenance transaction content");
  await validateTerminalContents(directory);
  await rm(directory, { recursive: true, maxRetries: 10, retryDelay: 100 });
}

export async function clearMaintenanceTransaction(directory: string): Promise<void> {
  if (path.basename(directory) !== ".compet-maintenance") throw new Error("Invalid maintenance transaction directory");
  const transaction = await readMaintenanceTransaction(directory);
  if (!transaction) return;
  if (transaction.state !== "verified" && transaction.state !== "rolled_back") {
    throw new Error("Maintenance transaction is not terminal");
  }
  await validateTerminalContents(directory);
  const plan = await readMaintenancePlan(directory);
  const journal = await readMaintenanceJournal(directory);
  await knownPayloadFiles(directory, "files",
    new Set([...(plan.protocol === 4 ? plan.expectedFiles! : plan.files).map(file => file.sha256), plan.helper.sha256]));
  await knownPayloadFiles(directory, "backup", await allowedMaintenanceBackups(directory, plan, journal));
  const root = path.dirname(directory);
  await clearRetiredMaintenance(root);
  await rename(directory, path.join(root, ".compet-maintenance-retired"));
  await clearRetiredMaintenance(root);
}

function serializeServerEntries(plan: MaintenancePlan | ServerMaintenancePlan): string[] {
  if (!plan.protectedPaths || !plan.operations) throw new Error("Invalid server maintenance plan");
  return [
    ...plan.protectedPaths.map(value => "protect=" + encode(value)),
    ...(plan.expectedFiles ?? []).map(f => "expect=" + encode(f.path) + "\t" + f.size + "\t" + f.sha256),
    ...(plan.baselineFiles ?? []).map(f => "baseline=" + encode(f.path) + "\t" + f.size + "\t" + f.sha256),
    ...plan.operations.map(op => {
      const before = op.before ? op.before.size + "\t" + op.before.sha256 : "-\t-";
      return op.kind === "delete" ? "delete=" + encode(op.path) + "\t" + before
        : "replace=" + encode(op.source) + "\t" + encode(op.path) + "\t" + op.size + "\t" + op.sha256 + "\t" + before;
    }),
  ];
}

function parseServerEntries(base: Omit<MaintenancePlan, "files">, lines: string[]): MaintenancePlan {
  const protectedPaths: string[] = [], expectedFiles: PackageFile[] = [], baselineFiles: PackageFile[] = [];
  const operations: ManagedFileOperation[] = [];
  let stage = 0;
  for (const line of lines) {
    if (line.startsWith("protect=")) {
      const value = decode(line.slice(8));
      if (stage !== 0 || !path.isAbsolute(value) || path.resolve(value) !== value ||
          protectedPaths.some(p => p.toLowerCase() === value.toLowerCase()) ||
          pathsOverlap(base.root, value) && !value.toLowerCase().startsWith(base.root.toLowerCase() + path.sep)) throw new Error("Invalid protected path");
      protectedPaths.push(value);
      continue;
    }
    const expected = line.startsWith("expect="), baseline = line.startsWith("baseline=");
    if (expected || baseline) {
      const nextStage = expected ? 1 : 2;
      if (stage > nextStage) throw new Error("Invalid server entry order");
      stage = nextStage;
      const fields = line.slice(expected ? 7 : 9).split("\t");
      if (fields.length !== 3) throw new Error("Invalid server fingerprint");
      const relative = decode(fields[0]!);
      assertServerProgramRelativePath(relative);
      const file = { path: relative, ...parseSizeAndHash(fields.slice(1)) };
      (expected ? expectedFiles : baselineFiles).push(file);
      continue;
    }
    stage = 3;
    const deletion = line.startsWith("delete=");
    if (!deletion && !line.startsWith("replace=")) throw new Error("Invalid server operation");
    const fields = line.slice(deletion ? 7 : 8).split("\t");
    if (fields.length !== (deletion ? 3 : 6)) throw new Error("Invalid server operation");
    const relative = decode(fields[deletion ? 0 : 1]!);
    assertServerProgramRelativePath(relative);
    const beforeFields = fields.slice(deletion ? 1 : 4);
    const before = beforeFields[0] === "-" && beforeFields[1] === "-" ? undefined : parseSizeAndHash(beforeFields);
    if (deletion) {
      if (!before) throw new Error("Delete requires a before image");
      operations.push({ kind: "delete", path: relative, before });
    } else {
      const source = decode(fields[0]!);
      const fingerprint = parseSizeAndHash(fields.slice(2, 4));
      if (source !== "files/" + fingerprint.sha256) throw new Error("Invalid server source");
      operations.push({ kind: "replace", path: relative, source, ...fingerprint, ...(before ? { before } : {}) });
    }
  }
  const collection = (files: PackageFile[]) => {
    const result = new Map<string, PackageFile>();
    for (const file of files) {
      const key = file.path.toLowerCase();
      if (result.has(key) || protectedPaths.some(p => pathsOverlap(path.join(base.root, file.path), p))) throw new Error("Invalid server target");
      result.set(key, file);
    }
    for (const key of result.keys()) {
      for (const other of result.keys()) if (key !== other && key.startsWith(other + "/")) throw new Error("Overlapping server targets");
    }
    return result;
  };
  const expected = collection(expectedFiles), baseline = collection(baselineFiles);
  const fixed = ["Compet Server Manager.exe", "runtime/updater/Compet Updater.exe", "runtime/electron/resources/app/package.json", "compet-package-manifest.json"];
  if (base.exe !== fixed[0] || fixed.some(p => !expected.has(p.toLowerCase())) ||
      !sameFingerprint(expected.get(fixed[1]!.toLowerCase()) ?? null, base.helper)) throw new Error("Incomplete server target");
  for (const name of ["server-data", "user-data"]) {
    const fixedPath = path.join(base.root, "runtime/electron/resources/app", name);
    if (!protectedPaths.some(p => p.toLowerCase() === fixedPath.toLowerCase())) throw new Error("Missing server data protection");
  }
  const ops = new Map<string, ManagedFileOperation>();
  for (const op of operations) {
    const key = op.path.toLowerCase();
    if (ops.has(key) || !sameFingerprint(op.before ?? null, baseline.get(key) ?? null) ||
        (op.kind === "delete" ? expected.has(key) : !sameFingerprint(op, expected.get(key) ?? null))) throw new Error("Inconsistent server operation");
    ops.set(key, op);
  }
  for (const key of new Set([...expected.keys(), ...baseline.keys()])) {
    const changed = !sameFingerprint(expected.get(key) ?? null, baseline.get(key) ?? null);
    if (changed !== ops.has(key)) throw new Error("Incomplete server operations");
  }
  return { ...base, protocol: 4, protectedPaths, expectedFiles, baselineFiles, operations,
    files: operations.map(op => op.kind === "replace" ? op : { path: op.path, source: "", size: 0, sha256: "0".repeat(64) }) };
}

export async function readServerMaintenancePlan(directory: string): Promise<ServerMaintenancePlan> {
  const plan = await readMaintenancePlan(directory);
  if (plan.protocol !== 4 || !plan.expectedFiles || !plan.baselineFiles || !plan.protectedPaths || !plan.operations) throw new Error("Invalid server maintenance plan");
  const { files: _files, ...server } = plan;
  return server as ServerMaintenancePlan;
}

async function allowedMaintenanceBackups(directory: string, plan: MaintenancePlan, journal: MaintenanceJournalEntry[]): Promise<Set<string>> {
  const allowed = new Set(journal.filter(entry => entry.existed).map(entry => path.basename(entry.backup)));
  if (plan.protocol === 4) {
    for (const [index, operation] of (plan.operations ?? []).entries()) {
      if (!operation.before) continue;
      const name = index + ".bin";
      const actual = await fingerprintFile(path.join(directory, "backup", name));
      if (actual && !sameFingerprint(actual, operation.before)) throw new Error("Invalid maintenance backup");
      allowed.add(name);
    }
  }
  return allowed;
}
