import fs from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import { assertPlainPath, assertServerProgramRelativePath, fingerprintFile, sameFingerprint } from "../desktop/main/serverManagedFiles.js";
import { parseLinuxProcessStat } from "../game/linuxProcess.js";
import { readServerMaintenancePlan, type ServerMaintenancePlan } from "../desktop/main/updateTransaction.js";
import { resolveServerLayout, type ServerPlatform } from "../shared/serverPackageLayout.js";
import { isSemver } from "../shared/version.js";
import { createHash, randomUUID } from "node:crypto";
import { loadHeadlessConfig } from "../cli/config.js";
import { assertServerConfigPaths, type ServerConfig } from "../config/config.js";
import type { LifecycleSnapshot } from "./serverLifecycle.js";
import { validateServerFile, assertUniqueServerFiles } from "./serverRelease.js";
import { strictObject, assertFingerprint, updateFailure, type ServerPlanV5, type ServerBaselineFile,
  type ServerPackageFile, type ServerBeforeImage, type ServerOperation, type ServerJournalV5,
  type ServerResultV5, type ServerJournalEntry } from "./serverUpdateTypes.js";

const transactionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function apiFor(platform: ServerPlatform) { return platform === "win32-x64" ? path.win32 : path.posix; }
function absolute(value: unknown, platform: ServerPlatform): string {
  const api = apiFor(platform);
  if (typeof value !== "string" || !value || /[\x00-\x1f]/.test(value) || !api.isAbsolute(value) ||
      api.normalize(value) !== value || value === api.parse(value).root ||
      (platform === "win32-x64" ? !/^[A-Za-z]:[\\/]/.test(value) : value.includes("\\"))) updateFailure("update_root_invalid");
  return value;
}
export function serverPathsOverlap(a: string, b: string, platform: ServerPlatform): boolean {
  const api = apiFor(platform);
  const left = platform === "win32-x64" ? a.toLowerCase() : a;
  const right = platform === "win32-x64" ? b.toLowerCase() : b;
  const within = (from: string, to: string) => { const relative = api.relative(from, to);
    return relative === "" || !api.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + api.sep); };
  return within(left, right) || within(right, left);
}

function beforeImage(raw: unknown, platform: ServerPlatform): ServerBeforeImage {
  const value = strictObject(raw, ["size", "sha256", ...(platform === "linux-x64" ? ["mode", "uid", "gid"] : [])]);
  assertFingerprint(value);
  if (platform === "linux-x64" && (!Number.isSafeInteger(value.mode) || Number(value.mode) < 0 || Number(value.mode) > 0o7777 ||
      !Number.isSafeInteger(value.uid) || Number(value.uid) < 0 || !Number.isSafeInteger(value.gid) || Number(value.gid) < 0)) updateFailure("update_before_invalid");
  return { size: Number(value.size), sha256: String(value.sha256).toUpperCase(),
    ...(platform === "linux-x64" ? { mode: Number(value.mode), uid: Number(value.uid), gid: Number(value.gid) } : {}) };
}
function sameImage(a: ServerBeforeImage | null, b: ServerBeforeImage | null, ownership = true): boolean {
  return sameFingerprint(a, b) && (a === null || b === null || a.mode === b.mode && (!ownership || a.uid === b.uid && a.gid === b.gid));
}
function withoutPath(file: ServerBaselineFile): ServerBeforeImage { const { path: _path, ...image } = file; return image; }

export function validateLifecycleSnapshot(raw: unknown, platform: ServerPlatform): LifecycleSnapshot {
  const systemd = platform === "linux-x64";
  const value = strictObject(raw, systemd ? ["kind", "wasRunning", "wasEnabled", "serviceName", "unitFingerprint"] : ["kind", "wasRunning"], systemd ? ["controlGroup"] : []);
  if (value.kind !== (systemd ? "systemd" : "windows-manager") || typeof value.wasRunning !== "boolean") updateFailure("update_lifecycle_invalid");
  if (systemd) {
    if (typeof value.wasEnabled !== "boolean" || typeof value.serviceName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.service$/.test(value.serviceName)) updateFailure("update_lifecycle_invalid");
    assertFingerprint(strictObject(value.unitFingerprint, ["size", "sha256"]));
    if ("controlGroup" in value && (typeof value.controlGroup !== "string" || !value.controlGroup.startsWith("/") || value.controlGroup === "/" ||
        /[\\\x00-\x20]/.test(value.controlGroup) || path.posix.normalize(value.controlGroup) !== value.controlGroup) ||
        value.wasRunning && !value.controlGroup) updateFailure("update_lifecycle_invalid");
  }
  return structuredClone(value) as unknown as LifecycleSnapshot;
}

export function validateServerPlan(raw: unknown): ServerPlanV5 {
  const value = strictObject(raw, ["protocol", "transactionId", "platform", "root", "exe", "targetVersion", "configurationFingerprint",
    "protectedPaths", "expectedFiles", "baselineFiles", "operations", "runner", "lifecycle"]);
  if (value.protocol !== 5 || typeof value.transactionId !== "string" || !transactionPattern.test(value.transactionId) ||
      value.platform !== "win32-x64" && value.platform !== "linux-x64" || typeof value.targetVersion !== "string" || !isSemver(value.targetVersion)) updateFailure("update_plan_invalid");
  const platform = value.platform;
  const root = absolute(value.root, platform), api = apiFor(platform);
  const layout = resolveServerLayout({ platform, installRoot: root });
  const config = strictObject(value.configurationFingerprint, ["path", "size", "sha256", "effectiveSha256"], ["kind", "requiredClientVersion"]);
  absolute(config.path, platform); assertFingerprint(config);
  const manager = "kind" in config || "requiredClientVersion" in config;
  if (manager && (platform !== "win32-x64" || config.kind !== "windows-manager" || typeof config.requiredClientVersion !== "string" ||
      !isSemver(config.requiredClientVersion) || config.path !== api.join(layout.appRoot, "user-data/manager-config.json"))) updateFailure("update_configuration_invalid");
  if (typeof config.effectiveSha256 !== "string" || !/^[A-Fa-f0-9]{64}$/.test(config.effectiveSha256)) updateFailure("update_configuration_invalid");
  if (!Array.isArray(value.protectedPaths) || value.protectedPaths.length < 2) updateFailure("update_protection_invalid");
  const protectedPaths = value.protectedPaths.map(p => absolute(p, platform));
  const protectedKeys = protectedPaths.map(p => platform === "win32-x64" ? p.toLowerCase() : p);
  if (new Set(protectedKeys).size !== protectedKeys.length || protectedPaths.some(p =>
      serverPathsOverlap(root, p, platform) && (api.relative(root, p) === "" || api.relative(root, p).startsWith("..")))) updateFailure("update_protection_invalid");
  const collection = (rawFiles: unknown, baseline: boolean): ServerBaselineFile[] => {
    if (!Array.isArray(rawFiles)) updateFailure("update_plan_invalid");
    const result = rawFiles.map(rawFile => {
      if (!baseline) return validateServerFile(rawFile, platform);
      const entry = strictObject(rawFile, ["path", "size", "sha256", ...(platform === "linux-x64" ? ["mode", "uid", "gid"] : [])]);
      if (typeof entry.path !== "string") updateFailure("update_plan_invalid");
      assertServerProgramRelativePath(entry.path);
      const { path: relative, ...fingerprint } = entry;
      return { path: relative, ...beforeImage(fingerprint, platform) };
    });
    assertUniqueServerFiles(result);
    for (const file of result) {
      if (protectedPaths.some(p => serverPathsOverlap(api.join(root, file.path), p, platform)) ||
          serverPathsOverlap(api.join(root, file.path), String(config.path), platform)) updateFailure("update_path_protected");
    }
    return result;
  };
  const expectedFiles = collection(value.expectedFiles, false);
  const baselineFiles = collection(value.baselineFiles, true);
  const expected = new Map(expectedFiles.map(file => [file.path.toLowerCase(), file]));
  const baseline = new Map(baselineFiles.map(file => [file.path.toLowerCase(), file]));
  const fixed = [platform === "linux-x64" ? "bin/compet" : "Compet Server Manager.exe", "compet-package-manifest.json",
    api.relative(root, layout.nodePath).split(api.sep).join("/"), api.relative(root, layout.workerEntry).split(api.sep).join("/"),
    api.relative(root, layout.cliEntry).split(api.sep).join("/"), api.relative(root, layout.serviceEntry).split(api.sep).join("/"),
    api.relative(root, api.join(layout.appRoot, "package.json")).split(api.sep).join("/"),
    ...(platform === "win32-x64" ? ["compet.cmd", "runtime/updater/Compet Updater.exe"] : [])];
  if (value.exe !== fixed[0] || fixed.some(p => !expected.has(p.toLowerCase()))) updateFailure("update_target_incomplete");
  if (platform === "win32-x64") {
    for (const name of ["server-data", "user-data"]) if (!protectedKeys.includes(api.join(layout.appRoot, name).toLowerCase())) updateFailure("update_protection_invalid");
  }
  if (!Array.isArray(value.operations)) updateFailure("update_operations_invalid");
  const operationKeys = new Set<string>();
  const operations = value.operations.map((rawOperation): ServerOperation => {
    const base = strictObject(rawOperation, ["kind", "path", "beforeExists"], ["before", "source", "size", "sha256", "mode"]);
    if (typeof base.path !== "string" || typeof base.beforeExists !== "boolean") updateFailure("update_operations_invalid");
    const key = base.path.toLowerCase(), previous = baseline.get(key), target = expected.get(key);
    if (operationKeys.has(key) || base.beforeExists !== !!previous || base.path !== (target?.path ?? previous?.path)) updateFailure("update_operations_invalid");
    operationKeys.add(key);
    let before: ServerBeforeImage | undefined;
    if (base.beforeExists) before = beforeImage(base.before, platform);
    else if ("before" in base) updateFailure("update_operations_invalid");
    if (!sameImage(before ?? null, previous ? withoutPath(previous) : null)) updateFailure("update_operations_invalid");
    if (base.kind === "delete") {
      strictObject(rawOperation, ["kind", "path", "beforeExists", "before"]);
      if (target || !before) updateFailure("update_operations_invalid");
      return { kind: "delete", path: base.path, beforeExists: true, before };
    }
    strictObject(rawOperation, ["kind", "path", "beforeExists", "source", "size", "sha256", ...(platform === "linux-x64" ? ["mode"] : [])], ["before"]);
    if (base.kind !== "replace" || !target || base.source !== "files/" + target.sha256) updateFailure("update_operations_invalid");
    const after = validateServerFile({ path: base.path, size: base.size, sha256: base.sha256, ...(platform === "linux-x64" ? { mode: base.mode } : {}) }, platform);
    if (!sameImage(after, target, false)) updateFailure("update_operations_invalid");
    return { kind: "replace", ...after, source: String(base.source), beforeExists: base.beforeExists, ...(before ? { before } : {}) };
  });
  for (const key of new Set([...expected.keys(), ...baseline.keys()])) {
    const target = expected.get(key), previous = baseline.get(key);
    if (target && previous && target.path !== previous.path) updateFailure("update_manifest_path_conflict");
    const changed = !sameImage(target ?? null, previous ?? null, false);
    if (changed !== operationKeys.has(key)) updateFailure("update_operations_incomplete");
  }
  const runner = strictObject(value.runner, ["directory", "node", "entry", "files"]);
  const runnerDirectory = absolute(runner.directory, platform);
  if ([root, ...protectedPaths, String(config.path)].some(p => serverPathsOverlap(p, runnerDirectory, platform)) ||
      runner.node !== (platform === "linux-x64" ? "node" : "node.exe") || runner.entry !== "worker.cjs" ||
      !Array.isArray(runner.files) || runner.files.length !== 2) updateFailure("update_runner_invalid");
  const runnerFiles = runner.files.map(file => validateServerFile(file, platform));
  assertUniqueServerFiles(runnerFiles);
  for (const [name, targetPath] of [[runner.node, fixed[2]], [runner.entry, fixed[3]]]) {
    const file = runnerFiles.find(candidate => candidate.path === name);
    if (!file || !sameImage(file, expected.get(String(targetPath).toLowerCase()) ?? null, false) || platform === "linux-x64" && name === "node" && file.mode !== 0o755) updateFailure("update_runner_invalid");
  }
  return { protocol: 5, transactionId: value.transactionId, platform, root, exe: String(value.exe), targetVersion: value.targetVersion,
    configurationFingerprint: { path: String(config.path), size: Number(config.size), sha256: String(config.sha256), effectiveSha256: config.effectiveSha256,
      ...(manager ? { kind: "windows-manager", requiredClientVersion: String(config.requiredClientVersion) } : {}) },
    protectedPaths, expectedFiles, baselineFiles, operations,
    runner: { directory: runnerDirectory, node: String(runner.node), entry: String(runner.entry), files: runnerFiles },
    lifecycle: validateLifecycleSnapshot(value.lifecycle, platform) };
}

export function validateServerJournal(raw: unknown, plan: ServerPlanV5): ServerJournalV5 {
  const value = strictObject(raw, ["protocol", "transactionId", "count", "entries"]);
  if (value.protocol !== 5 || value.transactionId !== plan.transactionId || !Array.isArray(value.entries) ||
      value.count !== value.entries.length || value.entries.length > plan.operations.length) updateFailure("update_journal_invalid");
  const entries = value.entries.map((rawEntry, index): ServerJournalEntry => {
    const entry = strictObject(rawEntry, ["index", "target", "beforeExists", "temporary"], ["before", "after", "backup"]);
    const operation = plan.operations[index]!;
    if (entry.index !== index || entry.target !== operation.path || entry.beforeExists !== operation.beforeExists) updateFailure("update_journal_invalid");
    const before = operation.beforeExists ? beforeImage(entry.before, plan.platform) : undefined;
    if (!sameImage(before ?? null, operation.before ?? null) || operation.beforeExists !== ("backup" in entry) ||
        operation.beforeExists && entry.backup !== "backup/" + index + ".bin" || !operation.beforeExists && "before" in entry) updateFailure("update_journal_invalid");
    if (entry.temporary !== ".compet-" + plan.transactionId + "-" + index + ".tmp") updateFailure("update_journal_invalid");
    let after: ServerPackageFile | undefined;
    if (operation.kind === "replace") {
      const image = strictObject(entry.after, ["size", "sha256", ...(plan.platform === "linux-x64" ? ["mode"] : [])]);
      after = validateServerFile({ path: operation.path, ...image }, plan.platform);
      if (!sameImage(after, operation, false)) updateFailure("update_journal_invalid");
    } else if ("after" in entry) updateFailure("update_journal_invalid");
    return { index, target: operation.path, beforeExists: operation.beforeExists, temporary: String(entry.temporary),
      ...(before ? { before, backup: String(entry.backup) } : {}),
      ...(after ? { after: { size: after.size, sha256: after.sha256, ...(after.mode === undefined ? {} : { mode: after.mode }) } } : {}) };
  });
  return { protocol: 5, transactionId: plan.transactionId, count: entries.length, entries };
}

export function validateServerResult(raw: unknown, plan: ServerPlanV5): ServerResultV5 {
  const value = strictObject(raw, ["protocol", "transactionId", "platform", "root", "exe", "targetVersion", "state"], ["code", "recoveryPhase"]);
  for (const key of ["protocol", "transactionId", "platform", "root", "exe", "targetVersion"] as const) if (value[key] !== plan[key]) updateFailure("update_result_identity_invalid");
  if (!["prepared", "applying", "applied", "verified", "rolled_back", "recovery_failed"].includes(String(value.state)) ||
      "code" in value && (typeof value.code !== "string" || !/^[a-z0-9_]+$/.test(value.code)) ||
      ["rolled_back", "recovery_failed"].includes(String(value.state)) !== ("code" in value) ||
      (value.state === "recovery_failed") !== ("recoveryPhase" in value) ||
      "recoveryPhase" in value && !["prepared", "applying", "applied"].includes(String(value.recoveryPhase))) updateFailure("update_result_invalid");
  return structuredClone(value) as unknown as ServerResultV5;
}

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function discardServerMetadataTemps(directory: string, owner: UpdateOwner, plan?: ServerPlanV5,
  receiptValidator?: (raw: unknown) => unknown): Promise<void> {
  await assertPlainPath(directory);
  const allowed = receiptValidator ? ["server-update-receipt.json"] : ["plan.json", "journal.json", "result.json", "owner.json", "release.json"];
  const names = (await fs.readdir(directory)).filter(name => allowed.some(base => name.startsWith(base + ".") && name.endsWith(".tmp")));
  if (names.length === 0) return;
  const ownerState = await probeUpdateProcess(owner.process);
  if (ownerState !== "gone" && !(ownerState === "alive" && owner.process.pid === process.pid)) {
    updateFailure(ownerState === "alive" ? "update_busy" : "update_owner_unknown");
  }
  const parent = await fs.stat(directory);
  const files = [];
  for (const name of names) {
    const base = allowed.find(base => name.startsWith(base + ".") && name.endsWith(".tmp"));
    if (!base) continue;
    const id = name.slice(base.length + 1, -4);
    if (!transactionPattern.test(id)) updateFailure("maintenance_cleanup_conflict");
    const file = path.join(directory, name);
    await assertPlainPath(file);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.nlink !== 1 || process.platform === "linux" &&
        ((info.mode & 0o777) !== 0o600 || info.uid !== parent.uid && info.uid !== process.getuid?.())) updateFailure("maintenance_cleanup_conflict");
    const before = await fingerprintFile(file);
    if (!before) updateFailure("maintenance_cleanup_conflict");
    if (id !== owner.transactionId) {
      let raw: unknown;
      try {
        raw = await readJson(file);
        const header = raw as { protocol?: unknown; transactionId?: unknown; root?: unknown };
        if (header.protocol !== 5 || header.transactionId !== owner.transactionId ||
            base !== "journal.json" && header.root !== owner.root) updateFailure("maintenance_cleanup_conflict");
        if (base === "plan.json") {
          const candidate = validateServerPlan(raw);
          if (!plan || JSON.stringify(candidate) !== JSON.stringify(plan)) updateFailure("maintenance_cleanup_conflict");
        } else if (base === "journal.json") {
          if (!plan) updateFailure("maintenance_cleanup_conflict");
          validateServerJournal(raw, plan);
        } else if (base === "result.json") {
          if (!plan) updateFailure("maintenance_cleanup_conflict");
          validateServerResult(raw, plan);
        } else if (base === "owner.json") {
          const candidate = validateUpdateOwner(raw, directory), state = await probeUpdateProcess(candidate.process);
          if (state !== "gone" && !(state === "alive" && candidate.process.pid === process.pid)) updateFailure("update_owner_unknown");
        } else if (receiptValidator) receiptValidator(raw);
        else if (JSON.stringify(raw) !== JSON.stringify(await readJson(path.join(directory, base)))) updateFailure("maintenance_cleanup_conflict");
      } catch { updateFailure("maintenance_cleanup_conflict"); }
    }
    if (!sameFingerprint(await fingerprintFile(file), before)) updateFailure("maintenance_cleanup_conflict");
    files.push({ file, fingerprint: before });
  }
  for (const { file, fingerprint } of files) {
    if (!sameFingerprint(await fingerprintFile(file), fingerprint)) updateFailure("maintenance_cleanup_conflict");
    await fs.unlink(file); await syncDirectory(directory);
  }
}

export async function writeDurableJson(file: string, value: unknown, ownership?: { uid: number; gid: number }): Promise<void> {
  await assertPlainPath(file);
  const transactionId = (value as { transactionId?: unknown } | null)?.transactionId;
  if (transactionId !== undefined && (typeof transactionId !== "string" || !transactionPattern.test(transactionId))) updateFailure("update_transaction_invalid");
  const temporary = file + "." + (transactionId ?? randomUUID()) + ".tmp";
  let created = false;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(JSON.stringify(value) + "\n");
      if (ownership && process.platform === "linux") {
        const info = await handle.stat();
        if (info.uid !== ownership.uid || info.gid !== ownership.gid) await handle.chown(ownership.uid, ownership.gid);
      }
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { if (created) await fs.rm(temporary, { force: true }); }
}

async function transactionDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory) || ![".compet-maintenance", ".compet-maintenance-staging", ".compet-maintenance-retired"].includes(path.basename(directory))) updateFailure("update_transaction_directory_invalid");
  await assertPlainPath(directory);
  if (!(await fs.lstat(directory)).isDirectory()) updateFailure("update_transaction_directory_invalid");
  const names = await fs.readdir(directory);
  if (names.includes("plan.txt") && names.includes("plan.json")) updateFailure("update_transaction_format_conflict");
}
async function readJson(file: string): Promise<unknown> {
  await assertPlainPath(file);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) updateFailure("update_transaction_invalid");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file))); }
  catch { updateFailure("update_transaction_invalid"); }
}

export { readJson as readDurableJson, sameImage as sameServerImage, beforeImage as validateServerBeforeImage };
export async function writeServerPlan(directory: string, plan: ServerPlanV5): Promise<void> {
  await transactionDirectory(directory);
  const valid = validateServerPlan(plan);
  if (path.resolve(valid.root) !== path.dirname(directory) || (await fs.readdir(directory)).includes("plan.txt")) updateFailure("update_transaction_format_conflict");
  await writeDurableJson(path.join(directory, "plan.json"), valid);
}
export async function readServerPlan(directory: string): Promise<ServerPlanV5> {
  await transactionDirectory(directory);
  const valid = validateServerPlan(await readJson(path.join(directory, "plan.json")));
  if (path.resolve(valid.root) !== path.dirname(directory)) updateFailure("update_plan_root_mismatch");
  return valid;
}
export async function writeServerJournal(directory: string, journal: ServerJournalV5, plan: ServerPlanV5): Promise<void> {
  await transactionDirectory(directory);
  await writeDurableJson(path.join(directory, "journal.json"), validateServerJournal(journal, plan));
}
export async function readServerJournal(directory: string, plan: ServerPlanV5): Promise<ServerJournalV5> {
  await transactionDirectory(directory);
  return validateServerJournal(await readJson(path.join(directory, "journal.json")), plan);
}
export async function writeServerResult(directory: string, result: ServerResultV5, plan: ServerPlanV5): Promise<void> {
  await transactionDirectory(directory);
  await writeDurableJson(path.join(directory, "result.json"), validateServerResult(result, plan));
}
export async function readServerResult(directory: string, plan: ServerPlanV5): Promise<ServerResultV5> {
  await transactionDirectory(directory);
  return validateServerResult(await readJson(path.join(directory, "result.json")), plan);
}
export interface LegacyServerPlan extends ServerMaintenancePlan { platform: "win32-x64" }
export async function readLegacyServerPlan(directory: string, platform: ServerPlatform): Promise<LegacyServerPlan> {
  if (platform !== "win32-x64") updateFailure("update_legacy_platform_invalid");
  await transactionDirectory(directory);
  if ((await fs.readdir(directory)).includes("plan.json")) updateFailure("update_transaction_format_conflict");
  // Validate UTF-8 before the existing strict Base64/protocol-4 reader.
  new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(path.join(directory, "plan.txt")));
  const plan = await readServerMaintenancePlan(directory);
  return { ...plan, platform: "win32-x64" };
}

export interface UpdateProcessIdentity { pid: number; startTime: string; executable: string }
export interface UpdateOwner {
  protocol: 5;
  transactionId: string;
  root: string;
  phase: "preparing" | "worker" | "finisher";
  cleanup?: true;
  process: UpdateProcessIdentity;
  parent?: UpdateProcessIdentity;
}
function processIdentity(raw: unknown): UpdateProcessIdentity {
  const value = strictObject(raw, ["pid", "startTime", "executable"]);
  if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.startTime !== "string" || !/^[0-9]+$/.test(value.startTime) ||
      typeof value.executable !== "string" || !path.isAbsolute(value.executable) || /[\x00-\x1f]/.test(value.executable)) updateFailure("update_owner_invalid");
  return { pid: Number(value.pid), startTime: value.startTime, executable: value.executable };
}
export async function captureUpdateProcess(pid: number): Promise<UpdateProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) updateFailure("update_owner_invalid");
  if (process.platform === "linux") {
    try {
      const before = parseLinuxProcessStat(await fs.readFile("/proc/" + pid + "/stat", "utf8"));
      if (["Z", "X"].includes(before.state!)) return null;
      const executable = await fs.readlink("/proc/" + pid + "/exe");
      const after = parseLinuxProcessStat(await fs.readFile("/proc/" + pid + "/stat", "utf8"));
      if (before.startTimeTicks !== after.startTimeTicks) updateFailure("update_process_unknown");
      return { pid, startTime: after.startTimeTicks, executable };
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    }
  }
  if (process.platform !== "win32") updateFailure("server_platform_unsupported");
  const script = "$ErrorActionPreference='Stop';try{$p=Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "';if($null -eq $p){'null';exit};if(!$p.ExecutablePath -or !$p.CreationDate){throw 'identity unavailable'};[pscustomobject]@{pid=[int]$p.ProcessId;startTime=$p.CreationDate.ToUniversalTime().Ticks.ToString();executable=$p.ExecutablePath}|ConvertTo-Json -Compress}catch{exit 2}";
  const command = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  await assertPlainPath(command);
  const output = await new Promise<string>((resolve, reject) => childProcess.execFile(command,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024, encoding: "utf8" },
    (error, stdout) => error ? reject(Object.assign(Error("update_process_unknown"), { code: "update_process_unknown" })) : resolve(stdout)));
  try { const value: unknown = JSON.parse(output.replace(/^\uFEFF/, "")); return value === null ? null : processIdentity(value); }
  catch { updateFailure("update_process_unknown"); }
}
export async function probeUpdateProcess(identity: UpdateProcessIdentity): Promise<"alive" | "gone" | "unknown"> {
  try {
    processIdentity(identity);
    const current = await captureUpdateProcess(identity.pid);
    if (!current || current.startTime !== identity.startTime) return "gone";
    const compare = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    return compare(current.executable) === compare(identity.executable) ? "alive" : "unknown";
  } catch { return "unknown"; }
}
export function validateUpdateOwner(raw: unknown, directory: string): UpdateOwner {
  const value = strictObject(raw, ["protocol", "transactionId", "root", "phase", "process"], ["parent", "cleanup"]);
  if (value.protocol !== 5 || typeof value.transactionId !== "string" || !transactionPattern.test(value.transactionId) ||
      value.root !== path.dirname(directory) || !["preparing", "worker", "finisher"].includes(String(value.phase)) ||
      "cleanup" in value && (value.cleanup !== true || value.phase !== "preparing")) updateFailure("update_owner_invalid");
  return { protocol: 5, transactionId: value.transactionId, root: String(value.root), phase: value.phase as UpdateOwner["phase"],
    process: processIdentity(value.process), ...("parent" in value ? { parent: processIdentity(value.parent) } : {}),
    ...("cleanup" in value ? { cleanup: true as const } : {}) };
}
export async function writeUpdateOwner(directory: string, owner: UpdateOwner): Promise<void> {
  await transactionDirectory(directory);
  await writeDurableJson(path.join(directory, "owner.json"), validateUpdateOwner(owner, directory));
}
export async function readUpdateOwner(directory: string): Promise<UpdateOwner> {
  await transactionDirectory(directory);
  return validateUpdateOwner(await readJson(path.join(directory, "owner.json")), directory);
}

export async function readServerProgramFiles(input: {
  root: string; platform: ServerPlatform; protectedPaths: string[]; transactionDirectories?: string[]; transactionPlan?: ServerPlanV5;
}): Promise<ServerBaselineFile[]> {
  await assertPlainPath(input.root);
  const directories = input.transactionDirectories ?? [];
  for (const directory of directories) {
    await transactionDirectory(directory);
    try {
      const owner = await readUpdateOwner(directory);
      if (owner.root !== input.root) updateFailure("update_owner_invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if ((await readServerPlan(directory)).root !== input.root) updateFailure("update_plan_root_mismatch");
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== "ENOENT" || !input.transactionPlan ||
            validateServerPlan(input.transactionPlan).root !== input.root) throw readError;
      }
    }
  }
  const files: ServerBaselineFile[] = [];
  const within = (value: string, boundary: string) => {
    const api = apiFor(input.platform);
    const relative = api.relative(input.platform === "win32-x64" ? boundary.toLowerCase() : boundary,
      input.platform === "win32-x64" ? value.toLowerCase() : value);
    return relative === "" || !api.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + api.sep);
  };
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (input.protectedPaths.some(boundary => within(absolute, boundary)) || directories.includes(absolute)) continue;
      await assertPlainPath(absolute);
      const relative = path.relative(input.root, absolute).split(path.sep).join("/");
      assertServerProgramRelativePath(relative);
      if (entry.isDirectory()) await visit(absolute);
      else {
        const before = await fs.lstat(absolute);
        const fingerprint = await fingerprintFile(absolute);
        const after = await fs.lstat(absolute);
        if (!fingerprint || before.size !== after.size || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs ||
            before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid) updateFailure("managed_file_changed");
        files.push({ path: relative, ...fingerprint, ...(input.platform === "linux-x64" ? { mode: after.mode & 0o7777, uid: after.uid, gid: after.gid } : {}) });
      }
    }
  }
  await visit(input.root);
  assertUniqueServerFiles(files);
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
export async function fingerprintServerConfiguration(input: { config: ServerConfig; configPath: string; layout?: ReturnType<typeof resolveServerLayout> }): Promise<ServerPlanV5["configurationFingerprint"]> {
  const fingerprint = await fingerprintFile(input.configPath);
  if (!fingerprint) updateFailure("maintenance_config_changed");
  const manager = input.layout?.platform === "win32-x64" && input.configPath === path.join(input.layout.appRoot, "user-data/manager-config.json");
  return { path: input.configPath, ...fingerprint, effectiveSha256: createHash("sha256").update(canonical(input.config)).digest("hex").toUpperCase(),
    ...(manager ? { kind: "windows-manager", requiredClientVersion: input.config.requiredClientVersion } : {}) };
}
export function serverProtectedPaths(layout: ReturnType<typeof resolveServerLayout>, config: ServerConfig): string[] {
  assertServerConfigPaths(config, layout);
  return [...new Set([config.dataDir, ...(config.gameServer.serverRoot ? [config.gameServer.serverRoot] : []),
    ...(layout.platform === "win32-x64" ? [path.join(layout.appRoot, "server-data"), path.join(layout.appRoot, "user-data")] : [])].map(p => apiFor(layout.platform).normalize(p)))];
}
export async function assertServerConfiguration(plan: ServerPlanV5, supplied?: ServerConfig): Promise<ServerConfig> {
  const before = await fingerprintFile(plan.configurationFingerprint.path);
  const layout = resolveServerLayout({ platform: plan.platform, installRoot: plan.root });
  const config = plan.configurationFingerprint.kind === "windows-manager"
    ? await (await import("./windowsManagerConfig.js")).loadManagerServerConfig({ layout, configPath: plan.configurationFingerprint.path,
      requiredClientVersion: plan.configurationFingerprint.requiredClientVersion })
    : await loadHeadlessConfig({ configPath: plan.configurationFingerprint.path, env: process.env });
  const actual = await fingerprintServerConfiguration({ config, configPath: plan.configurationFingerprint.path, ...(plan.configurationFingerprint.kind ? { layout } : {}) });
  const expected = plan.configurationFingerprint;
  if (!sameFingerprint(before, actual) || !sameFingerprint(actual, expected) || actual.effectiveSha256 !== expected.effectiveSha256.toUpperCase() ||
      supplied && createHash("sha256").update(canonical(supplied)).digest("hex").toUpperCase() !== actual.effectiveSha256) updateFailure("maintenance_config_changed");
  const paths = serverProtectedPaths(layout, config);
  const key = (value: string) => plan.platform === "win32-x64" ? value.toLowerCase() : value;
  if (paths.length !== plan.protectedPaths.length || paths.some(p => !plan.protectedPaths.map(key).includes(key(p)))) updateFailure("maintenance_config_changed");
  return config;
}
