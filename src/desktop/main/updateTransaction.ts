import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import type { IntegrityReport } from "../updateTypes.js";
import path from "node:path";

export interface MaintenanceTransaction {
  protocol: 2;
  root: string;
  exe: string;
  targetVersion: string;
  state: "prepared" | "applying" | "applied" | "rolled_back" | "recovery_failed" | "verified";
  error?: string;
  recoveryPhase?: "prepared" | "applying" | "applied";
}

export interface MaintenancePlan {
  root: string;
  exe: string;
  targetVersion: string;
  helper: { size: number; sha256: string };
  files: Array<{ source: string; path: string; size: number; sha256: string }>;
}

const states = new Set<MaintenanceTransaction["state"]>([
  "prepared", "applying", "applied", "rolled_back", "recovery_failed", "verified",
]);
const hashPattern = /^[A-F0-9]{64}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function assertDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || ![".compet-maintenance", ".compet-maintenance-staging"].includes(path.basename(directory))) {
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
  if (lines.length < 5 || lines[0] !== "protocol=2" ||
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

function serializePlan(directory: string, plan: MaintenancePlan): string {
  const lines = [
    "protocol=2",
    "root=" + encode(plan.root),
    "exe=" + encode(plan.exe),
    "target=" + encode(plan.targetVersion),
    "helper=" + plan.helper.size + "\t" + plan.helper.sha256,
    ...plan.files.map(file => "file=" + encode(file.source) + "\t" + encode(file.path) +
      "\t" + file.size + "\t" + file.sha256),
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

export async function writeMaintenancePlan(directory: string, plan: MaintenancePlan, manifest: unknown): Promise<void> {
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
  if (value.protocol !== 2 || value.root !== plan.root || value.exe !== plan.exe ||
      value.targetVersion !== plan.targetVersion || !states.has(value.state) ||
      (value.error !== undefined && !/^[a-z0-9_]+$/.test(value.error)) ||
      (value.recoveryPhase !== undefined && (value.state !== "recovery_failed" ||
        value.error === undefined || !["prepared", "applying", "applied"].includes(value.recoveryPhase)))) {
    throw new Error("Invalid maintenance transaction state");
  }
  const lines = ["protocol=2", "state=" + value.state];
  if (value.error !== undefined) lines.push("error=" + value.error);
  if (value.recoveryPhase !== undefined) lines.push("phase=" + value.recoveryPhase);
  await atomicWrite(path.join(directory, "result.txt"), lines.join("\n") + "\n");
}

export async function readMaintenanceTransaction(directory: string): Promise<MaintenanceTransaction | null> {
  if (!(await ensureDirectory(directory))) return null;
  const plan = await readMaintenancePlan(directory);
  await readMaintenanceManifest(directory);
  let text: string;
  try {
    text = await readFile(path.join(directory, "result.txt"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Maintenance transaction incomplete: result");
    throw error;
  }
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length < 2 || lines.length > 4 || lines[0] !== "protocol=2" ||
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
  return { protocol: 2, root: plan.root, exe: plan.exe, targetVersion: plan.targetVersion, state,
    ...(error === undefined ? {} : { error }),
    ...(recoveryPhase === undefined ? {} : { recoveryPhase }) };
}

export interface MaintenanceJournalEntry {
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
  if (lines[0] !== "protocol=2" || lines.length > plan.files.length + 1 ||
      (requireComplete && lines.length !== plan.files.length + 1)) {
    throw new Error("Invalid maintenance journal");
  }
  const entries: MaintenanceJournalEntry[] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    if (!line.startsWith("entry=")) throw new Error("Invalid maintenance journal");
    const fields = line.slice(6).split("\t");
    if (fields.length !== 5 || !["0", "1"].includes(fields[1] ?? "")) {
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
  const content = new Set([...plan.files.map(file => file.sha256), plan.helper.sha256]);
  const backups = new Set(journal.filter(entry => entry.existed).map(entry => path.basename(entry.backup)));
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

async function validateTerminalContents(directory: string): Promise<void> {
  const known = new Set(["plan.txt", "manifest.json", "result.txt", "journal.txt",
    "summary.json", "Compet Updater.exe", "files", "backup"]);
  for (const name of await readdir(directory)) {
    if (!known.has(name)) throw new Error("Unknown maintenance transaction content");
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
  await rm(directory, { recursive: true });
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
    new Set([...plan.files.map(file => file.sha256), plan.helper.sha256]));
  await knownPayloadFiles(directory, "backup",
    new Set(journal.filter(entry => entry.existed).map(entry => path.basename(entry.backup))));
  const root = path.dirname(directory);
  await clearRetiredMaintenance(root);
  await rename(directory, path.join(root, ".compet-maintenance-retired"));
  await clearRetiredMaintenance(root);
}
