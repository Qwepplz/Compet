import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { assertPlainPath, fingerprintFile, sameFingerprint, pathsOverlap, validatePackageInventory, type PackageFile } from "../desktop/main/serverManagedFiles.js";
import { readMaintenanceJournal, readServerMaintenanceState,
  clearServerTerminalTransaction, type MaintenanceJournalEntry } from "../desktop/main/updateTransaction.js";
import { assertServicePortClosed } from "../manager/main/serviceProcess.js";
import { readLegacyServerPlan, captureUpdateProcess, probeUpdateProcess, syncDirectory,
  type LegacyServerPlan, type UpdateProcessIdentity } from "./serverTransaction.js";
import { applyFileMutation, rollbackFileMutation, durableCopy } from "./serverFileOperations.js";
import { assertWindowsInstallationQuiet } from "./windowsProcesses.js";
import { strictObject, assertFingerprint, updateFailure } from "./serverUpdateTypes.js";
import { assertServerRoots, type ServerLayout } from "../shared/serverPackageLayout.js";
import type { ServerConfig } from "../config/config.js";
import type { ServerLifecycle } from "./serverLifecycle.js";
import type { ServerUpdateResult } from "./serverUpdateTypes.js";

const nodeName = "runtime/node/node.exe", workerName = "runtime/updater/worker.cjs";
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
const codeOf = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[a-z][a-z0-9_]+$/.test(code) ? code : "maintenance_io_failed";
};
async function exists(file: string) { await assertPlainPath(file); try { await fs.lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
async function atomicText(file: string, text: string) {
  await assertPlainPath(file);
  const temporary = file + "." + randomUUID().replaceAll("-", "") + ".tmp";
  try {
    const handle = await fs.open(temporary, "wx");
    try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file); await syncDirectory(path.dirname(file));
  } finally { if (await exists(temporary)) await fs.unlink(temporary); }
}
async function state(plan: LegacyServerPlan, directory: string, value: "prepared" | "applying" | "applied" | "verified" | "rolled_back" | "recovery_failed", error?: string) {
  const actual = await readLegacyServerPlan(directory, "win32-x64");
  if (JSON.stringify(actual) !== JSON.stringify(plan) || error && !/^[a-z0-9_]+$/.test(error)) updateFailure("maintenance_plan_changed");
  await atomicText(path.join(directory, "result.txt"), "protocol=4\nstate=" + value + "\n" +
    (error ? "error=" + error + "\n" : "") + (value === "recovery_failed" ? "phase=applying\n" : ""));
}
async function readLegacyJournal(directory: string): Promise<MaintenanceJournalEntry[]> {
  try { return await readMaintenanceJournal(directory); }
  catch (error) {
    if (typeof (error as NodeJS.ErrnoException)?.code === "string") throw error;
    return updateFailure("maintenance_journal_invalid");
  }
}
async function journalWrite(directory: string, entries: MaintenanceJournalEntry[]) {
  await atomicText(path.join(directory, "journal.txt"), ["protocol=4", ...entries.map(e => "entry=" + encode(e.path) + "\t" +
    (e.existed ? "1" : "0") + "\t" + encode(e.backup) + "\t" + e.size + "\t" + e.sha256 + "\t" + encode(e.temporary!)), "count=" + entries.length, ""].join("\n"));
}
async function verifyTree(plan: LegacyServerPlan, directory: string, expected: PackageFile[]) {
  const actual: PackageFile[] = [], keys = new Set<string>();
  async function visit(current: string) {
    await assertPlainPath(current);
    for (const name of await fs.readdir(current)) {
      const absolute = path.join(current, name);
      if (absolute === directory || plan.protectedPaths.some(p => absolute.toLowerCase() === p.toLowerCase() || absolute.toLowerCase().startsWith(p.toLowerCase() + path.sep))) continue;
      await assertPlainPath(absolute);
      const relative = path.relative(plan.root, absolute).split(path.sep).join("/");
      if (keys.has(relative.toLowerCase())) updateFailure("maintenance_tree_changed");
      keys.add(relative.toLowerCase());
      const info = await fs.lstat(absolute);
      if (info.isDirectory()) await visit(absolute);
      else { const image = await fingerprintFile(absolute); if (!image) updateFailure("maintenance_tree_changed"); actual.push({ path: relative, ...image }); }
    }
  }
  await visit(plan.root);
  if (actual.length !== expected.length || actual.some(file => !expected.some(e => e.path === file.path && sameFingerprint(e, file)))) updateFailure("maintenance_tree_changed");
}
async function currentConfig(plan: LegacyServerPlan) {
  const appRoot = path.join(plan.root, "runtime/electron/resources/app"), file = path.join(appRoot, "user-data/manager-config.json");
  const raw = await exists(file) ? new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file)) : "{}";
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch { return updateFailure("maintenance_config_invalid"); }
  if (!value || Array.isArray(value) || typeof value !== "object") updateFailure("maintenance_config_invalid");
  const dataDir = value.dataDir ?? path.join(appRoot, "server-data"), serverRoot = value.serverRoot ?? "";
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir) || typeof serverRoot !== "string" || serverRoot && !path.isAbsolute(serverRoot)) updateFailure("maintenance_config_invalid");
  assertServerRoots({ platform: "win32-x64", installRoot: plan.root, dataDir, serverRoot });
  for (const boundary of [dataDir, serverRoot].filter(Boolean)) {
    await assertPlainPath(boundary);
    if ([...plan.expectedFiles, ...plan.baselineFiles].some(f => pathsOverlap(boundary, path.join(plan.root, f.path)))) updateFailure("maintenance_path_protected");
    if (pathsOverlap(plan.root, boundary) && !plan.protectedPaths.some(p => boundary.toLowerCase() === p.toLowerCase() || boundary.toLowerCase().startsWith(p.toLowerCase() + path.sep))) updateFailure("maintenance_path_protected");
  }
  const host = value.host ?? "0.0.0.0", port = value.port ?? 18443;
  if (typeof host !== "string" || !host || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) updateFailure("maintenance_config_invalid");
  return { dataDir, serverRoot, host, port: Number(port), fingerprint: await fingerprintFile(file) };
}
async function quiet(plan: LegacyServerPlan, configFingerprint: Awaited<ReturnType<typeof fingerprintFile>>) {
  const config = await currentConfig(plan);
  if (!sameFingerprint(config.fingerprint, configFingerprint)) updateFailure("maintenance_config_changed");
  const own = await captureUpdateProcess(process.pid); if (!own) updateFailure("maintenance_process_unknown");
  await assertWindowsInstallationQuiet([plan.root, ...(config.serverRoot ? [config.serverRoot] : [])], [own]);
  await assertServicePortClosed(config);
}
async function verifySources(plan: LegacyServerPlan, directory: string) {
  for (const op of plan.operations) if (op.kind === "replace" && !sameFingerprint(await fingerprintFile(path.join(directory, op.source)), op)) updateFailure("maintenance_source_invalid");
}
async function validateBackups(plan: LegacyServerPlan, directory: string, entries: MaintenanceJournalEntry[], allowMissing = false) {
  const folder = path.join(directory, "backup");
  for (const name of await exists(folder) ? await fs.readdir(folder) : []) {
    const index = Number(name.slice(0, -4)), op = plan.operations[index];
    if (!/^(0|[1-9][0-9]*)\.bin$/.test(name) || !op?.before || !sameFingerprint(await fingerprintFile(path.join(folder, name)), op.before)) updateFailure("maintenance_backup_invalid");
  }
  for (const entry of entries) if (entry.existed) {
    const actual = await fingerprintFile(path.join(directory, entry.backup));
    if (!(allowMissing && actual === null) && !sameFingerprint(actual, entry)) updateFailure("maintenance_backup_invalid");
  }
}
async function validateNamespace(plan: LegacyServerPlan, directory: string): Promise<void> {
  for (const name of await fs.readdir(directory)) {
    const atomicMetadata = /^(manifest\.json|plan\.txt|result\.txt|journal\.txt)\.[0-9a-f]{32}\.tmp$/.test(name);
    if (!["plan.txt", "manifest.json", "result.txt", "journal.txt", "Compet Updater.exe", "legacy-owner.json", "files", "backup"].includes(name) && !atomicMetadata) updateFailure("maintenance_cleanup_conflict");
    const file = path.join(directory, name); await assertPlainPath(file);
    const info = await fs.lstat(file);
    if (name === "files" || name === "backup") {
      if (!info.isDirectory()) updateFailure("maintenance_cleanup_conflict");
      if (name === "files") for (const hash of await fs.readdir(file)) {
        const expected = plan.expectedFiles.find(f => f.sha256 === hash);
        if (!expected || !sameFingerprint(await fingerprintFile(path.join(file, hash)), expected)) updateFailure("maintenance_source_invalid");
      }
    } else if (!info.isFile()) updateFailure("maintenance_cleanup_conflict");
    else if (name === "Compet Updater.exe" && !sameFingerprint(await fingerprintFile(file), plan.helper)) updateFailure("maintenance_helper_invalid");
  }
  const manifest = path.join(directory, "manifest.json");
  if (await exists(manifest)) {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(manifest)));
    const inventory = validatePackageInventory(value.inventory, true), expected = plan.expectedFiles.filter(f => f.path !== "compet-package-manifest.json");
    if (inventory.version !== plan.targetVersion || inventory.files.length !== expected.length ||
        inventory.files.some(f => !expected.some(e => e.path === f.path && sameFingerprint(e, f)))) updateFailure("maintenance_inventory_mismatch");
  } else if (path.basename(directory) !== ".compet-maintenance-retired") updateFailure("maintenance_manifest_missing");
}
interface LegacyOwner { protocol: 4; root: string; plan: { size: number; sha256: string }; process: UpdateProcessIdentity; runners: string[] }
function validateOwner(raw: unknown, plan: LegacyServerPlan, planFingerprint: { size: number; sha256: string }): LegacyOwner {
  const owner = strictObject(raw, ["protocol", "root", "plan", "process", "runners"]);
  assertFingerprint(strictObject(owner.plan, ["size", "sha256"]));
  const identity = strictObject(owner.process, ["pid", "startTime", "executable"]);
  if (owner.protocol !== 4 || owner.root !== plan.root || !sameFingerprint(owner.plan as PackageFile, planFingerprint) ||
      !Number.isSafeInteger(identity.pid) || Number(identity.pid) <= 0 || typeof identity.startTime !== "string" || !/^[0-9]+$/.test(identity.startTime) ||
      typeof identity.executable !== "string" || !path.isAbsolute(identity.executable) || !Array.isArray(owner.runners) ||
      new Set(owner.runners).size !== owner.runners.length || owner.runners.some(p => typeof p !== "string" ||
        path.dirname(p) !== path.resolve(process.env.TEMP ?? process.env.TMP ?? "") || !/^compet-server-bridge-[a-f0-9]{32}$/.test(path.basename(p)))) updateFailure("maintenance_owner_invalid");
  return owner as unknown as LegacyOwner;
}
async function waitForIdentity(identity: UpdateProcessIdentity) {
  const deadline = Date.now() + 120000;
  while (true) {
    const observed = await probeUpdateProcess(identity);
    if (observed === "gone") return;
    if (observed === "unknown") updateFailure("maintenance_process_unknown");
    if (Date.now() > deadline) updateFailure("maintenance_parent_running");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function cleanupRunners(plan: LegacyServerPlan, runners: string[]) {
  for (const directory of runners) {
    if (!await exists(directory)) continue;
    const allowed = new Map([["node.exe", plan.expectedFiles.find(f => f.path === nodeName)!], ["worker.cjs", plan.expectedFiles.find(f => f.path === workerName)!]]);
    for (const name of await fs.readdir(directory)) if (!allowed.has(name) || !sameFingerprint(await fingerprintFile(path.join(directory, name)), allowed.get(name)!)) updateFailure("maintenance_cleanup_conflict");
    if (path.dirname(process.execPath) === directory) updateFailure("maintenance_runner_still_active");
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  }
}
async function launchFinisher(plan: LegacyServerPlan, planPath: string) {
  const node = await installedFinisherNode(plan);
  const installedEntry = path.join(plan.root, workerName);
  const entry = sameFingerprint(await fingerprintFile(installedEntry), plan.expectedFiles.find(f => f.path === workerName)!) ? installedEntry : process.argv[1]!;
  if (!sameFingerprint(await fingerprintFile(entry), plan.expectedFiles.find(f => f.path === workerName)!)) updateFailure("maintenance_runner_invalid");
  const parent = await captureUpdateProcess(process.pid); if (!parent) updateFailure("maintenance_process_unknown");
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(node, [entry, "--plan", planPath, "--mode", "finish", "--wait", encode(JSON.stringify(parent))],
    { detached: true, windowsHide: true, stdio: "ignore", cwd: plan.root, env });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
}
async function installedFinisherNode(plan: LegacyServerPlan): Promise<string> {
  for (const name of [nodeName, "runtime/electron/resources/app/runtime/node/node.exe"]) {
    const absolute = path.join(plan.root, name);
    if (sameFingerprint(await fingerprintFile(absolute), plan.expectedFiles.find(f => f.path === nodeName)!)) return absolute;
  }
  return updateFailure("maintenance_recovery_runtime_required");
}

export async function legacyServerWorkerMain(argv: string[]): Promise<number> {
  let plan: LegacyServerPlan | undefined, directory: string | undefined, ownerPath: string | undefined;
  let ownsTransaction = false;
  try {
    if (process.platform !== "win32" || process.arch !== "x64" || process.versions.node.split(".")[0] !== "24") updateFailure("maintenance_runner_invalid");
    const args = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      plan: { type: "string" }, mode: { type: "string" }, "bridge-pid": { type: "string" }, "bridge-start": { type: "string" }, wait: { type: "string" },
    } }).values;
    if (!args.plan || !path.isAbsolute(args.plan) || path.basename(args.plan) !== "plan.txt" || !["validate", "apply", "recover", "finish"].includes(args.mode ?? "")) updateFailure("update_worker_arguments_invalid");
    directory = path.dirname(args.plan); plan = await readLegacyServerPlan(directory, "win32-x64");
    for (const [actual, name] of [[process.execPath, nodeName], [process.argv[1]!, workerName]]) {
      if (!actual || !sameFingerprint(await fingerprintFile(actual), plan.expectedFiles.find(f => f.path === name) ?? null)) updateFailure("maintenance_runner_invalid");
    }
    const config = await currentConfig(plan);
    const entries = await readLegacyJournal(directory);
    const resultState = await exists(path.join(directory, "result.txt")) ? await readServerMaintenanceState(directory) :
      args.mode === "validate" || path.basename(directory) === ".compet-maintenance-retired" ? null : updateFailure("maintenance_state_invalid");
    const result = resultState === null ? null : { state: resultState };
    const terminal = result?.state === "verified" || result?.state === "rolled_back";
    await validateBackups(plan, directory, entries, terminal && path.basename(directory) === ".compet-maintenance-retired");
    await validateNamespace(plan, directory);
    if (args.mode === "validate") {
      if (result && result.state !== "prepared") updateFailure("maintenance_state_invalid");
      await verifySources(plan, directory); await verifyTree(plan, directory, plan.baselineFiles);
      await state(plan, directory, "prepared"); return 0;
    }
    if (args.wait) {
      const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(args.wait, "base64")));
      const identity = strictObject(raw, ["pid", "startTime", "executable"]);
      if (!Number.isSafeInteger(identity.pid) || Number(identity.pid) <= 0 || typeof identity.startTime !== "string" || !/^[0-9]+$/.test(identity.startTime) ||
          typeof identity.executable !== "string" || !path.isAbsolute(identity.executable)) updateFailure("maintenance_process_unknown");
      await waitForIdentity(identity as unknown as UpdateProcessIdentity);
    } else if (args["bridge-pid"] || args["bridge-start"]) {
      const pid = Number(args["bridge-pid"]), startTime = args["bridge-start"];
      if (!Number.isSafeInteger(pid) || pid <= 0 || !startTime || !/^[0-9]+$/.test(startTime)) updateFailure("maintenance_process_unknown");
      const bridge = await captureUpdateProcess(pid);
      if (bridge && bridge.startTime === startTime) await waitForIdentity(bridge);
    } else updateFailure("maintenance_process_unknown");
    await quiet(plan, config.fingerprint);
    const planFingerprint = (await fingerprintFile(args.plan))!, own = await captureUpdateProcess(process.pid);
    if (!own) updateFailure("maintenance_process_unknown");
    ownerPath = path.join(directory, "legacy-owner.json");
    let previous: LegacyOwner | undefined;
    if (await exists(ownerPath)) {
      previous = validateOwner(JSON.parse(await fs.readFile(ownerPath, "utf8")), plan, planFingerprint);
      const status = await probeUpdateProcess(previous.process);
      if (status !== "gone") updateFailure(status === "alive" ? "update_busy" : "update_owner_unknown");
    }
    const runners = [...previous?.runners ?? []], privateRoot = path.dirname(process.execPath);
    const installedNode = await installedFinisherNode(plan).catch(() => null);
    const isInstalledFinisher = args.mode === "finish" && installedNode === process.execPath;
    if (!isInstalledFinisher && !runners.includes(privateRoot)) runners.push(privateRoot);
    const owner = validateOwner({ protocol: 4, root: plan.root, plan: planFingerprint, process: own, runners }, plan, planFingerprint);
    if (!previous) {
      const handle = await fs.open(ownerPath, "wx"); try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
    } else await atomicText(ownerPath, JSON.stringify(owner));
    ownsTransaction = true;
    if (!result && path.basename(directory) === ".compet-maintenance-retired") {
      let terminal: "verified" | "rolled_back" = "verified";
      try { await verifyTree(plan, directory, plan.expectedFiles); }
      catch (error) {
        if (codeOf(error) !== "maintenance_tree_changed") throw error;
        await verifyTree(plan, directory, plan.baselineFiles); terminal = "rolled_back";
      }
      await state(plan, directory, terminal); await launchFinisher(plan, args.plan); return 0;
    }
    if (args.mode === "finish" || args.mode === "recover" && terminal) {
      if (!["verified", "rolled_back"].includes(result?.state ?? "")) updateFailure("update_recovery_required");
      if (!isInstalledFinisher) { await launchFinisher(plan, args.plan); return 0; }
      await verifyTree(plan, directory, result!.state === "verified" ? plan.expectedFiles : plan.baselineFiles);
      await cleanupRunners(plan, owner.runners);
      await fs.unlink(ownerPath);
      await clearServerTerminalTransaction(directory);
      try {
        const child = spawn(path.join(plan.root, plan.exe), [], { detached: true, windowsHide: true, stdio: "ignore", cwd: plan.root });
        await new Promise<void>((resolve,reject)=>{child.once("spawn",resolve);child.once("error",reject);}); child.unref();
      } catch { updateFailure("maintenance_restart_failed"); }
      return 0;
    }
    if (args.mode === "recover") {
      let targetMatches = false;
      try { await verifyTree(plan, directory, plan.expectedFiles); targetMatches = true; } catch (e) { if (codeOf(e) !== "maintenance_tree_changed") throw e; }
      if (targetMatches) { if (entries.length !== plan.operations.length) updateFailure("update_journal_invalid"); await state(plan, directory, "verified"); await launchFinisher(plan, args.plan); return 0; }
      for (const [index, entry] of [...entries.entries()].reverse()) {
        await quiet(plan, config.fingerprint);
        const op = plan.operations[index]!;
        await rollbackFileMutation({ platform: "win32-x64", target: path.join(plan.root, op.path), temporary: path.join(plan.root, entry.temporary!),
          before: op.before ?? null, after: op.kind === "replace" ? op : null, backup: entry.existed ? path.join(directory, entry.backup) : undefined,
          assertCanWrite: () => quiet(plan!, config.fingerprint),
          source: op.kind === "replace" ? path.join(directory, op.source) : undefined });
      }
      await verifyTree(plan, directory, plan.baselineFiles); await state(plan, directory, "rolled_back");
      await launchFinisher(plan, args.plan);
      return 0;
    }
    if (!result || result.state !== "prepared" || entries.length) updateFailure("maintenance_state_invalid");
    await verifySources(plan, directory); await verifyTree(plan, directory, plan.baselineFiles);
    const space = await fs.statfs(plan.root), needed = plan.operations.reduce((n, op) => n + (op.before?.size ?? 0) + (op.kind === "replace" ? op.size : 0), 32 * 1024 * 1024);
    if (!Number.isSafeInteger(needed) || space.bavail * space.bsize < needed) updateFailure("maintenance_disk_space_insufficient");
    await state(plan, directory, "applying");
    for (const [index, op] of plan.operations.entries()) {
      await quiet(plan, config.fingerprint);
      if (!sameFingerprint(await fingerprintFile(path.join(plan.root, op.path)), op.before ?? null)) updateFailure("maintenance_before_changed");
      if (op.before) {
        await fs.mkdir(path.join(directory, "backup"), { recursive: true });
        await durableCopy(path.join(plan.root, op.path), path.join(directory, "backup", index + ".bin"));
        if (!sameFingerprint(await fingerprintFile(path.join(directory, "backup", index + ".bin")), op.before)) updateFailure("maintenance_backup_invalid");
      }
      const temporary = path.posix.join(path.posix.dirname(op.path), ".compet-" + randomUUID().replaceAll("-", "") + ".tmp");
      entries.push({ path: op.path, existed: !!op.before, backup: "backup/" + index + ".bin", size: op.before?.size ?? 0, sha256: op.before?.sha256 ?? "0".repeat(64), temporary });
      await journalWrite(directory, entries);
      await applyFileMutation({ platform: "win32-x64", target: path.join(plan.root, op.path), temporary: path.join(plan.root, temporary),
        assertCanWrite: () => quiet(plan!, config.fingerprint),
        before: op.before ?? null, after: op.kind === "replace" ? op : null, source: op.kind === "replace" ? path.join(directory, op.source) : undefined });
    }
    await state(plan, directory, "applied"); await verifyTree(plan, directory, plan.expectedFiles); await state(plan, directory, "verified");
    await launchFinisher(plan, args.plan); return 0;
  } catch (error) {
    if (plan && directory && ownsTransaction) {
      try {
        const current = await readServerMaintenanceState(directory);
        if (current && !["verified", "rolled_back"].includes(current)) await state(plan, directory, "recovery_failed", codeOf(error));
      } catch { /* Preserve the original validated evidence on I/O failure. */ }
    }
    process.stderr.write(codeOf(error) + "\n"); return 1;
  }
}

export async function handoffLegacyServerUpdate(input: {
  directory: string; layout: ServerLayout; config: ServerConfig; lifecycle: ServerLifecycle; authorizeOnline: () => Promise<void>;
}): Promise<ServerUpdateResult> {
  if (!await exists(path.join(input.directory, "plan.txt"))) {
    if (input.directory !== path.join(input.layout.installRoot, ".compet-maintenance-retired") || (await fs.readdir(input.directory)).length) updateFailure("maintenance_cleanup_conflict");
    const configPath = path.join(input.layout.appRoot, "user-data/manager-config.json"), helper = path.join(input.layout.installRoot, "runtime/updater/Compet Updater.exe");
    const configFingerprint = await fingerprintFile(configPath), helperFingerprint = await fingerprintFile(helper);
    if (!helperFingerprint) updateFailure("maintenance_helper_invalid");
    const snapshot = await input.lifecycle.capture();
    if (snapshot.wasRunning) await input.authorizeOnline();
    await input.lifecycle.quiesce(snapshot); await input.lifecycle.assertStopped();
    if (!sameFingerprint(await fingerprintFile(configPath), configFingerprint) || !sameFingerprint(await fingerprintFile(helper), helperFingerprint) ||
        (await fs.readdir(input.directory)).length || await exists(path.join(input.layout.installRoot, ".compet-maintenance"))) updateFailure("maintenance_plan_changed");
    await fs.rmdir(input.directory); await syncDirectory(input.layout.installRoot);
    return { status: "completed", code: "maintenance_cleanup_completed" };
  }
  const plan = await readLegacyServerPlan(input.directory, input.layout.platform);
  if (plan.root !== input.layout.installRoot) updateFailure("maintenance_layout_invalid");
  const configuration = await currentConfig(plan);
  if (path.resolve(configuration.dataDir) !== path.resolve(input.config.dataDir) || configuration.serverRoot !== input.config.gameServer.serverRoot ||
      configuration.port !== input.config.port || configuration.host !== input.config.host) updateFailure("maintenance_config_changed");
  const planFingerprint = (await fingerprintFile(path.join(input.directory, "plan.txt")))!;
  const ownerPath = path.join(input.directory, "legacy-owner.json");
  let owner: LegacyOwner | undefined;
  if (await exists(ownerPath)) {
    owner = validateOwner(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(ownerPath))), plan, planFingerprint);
    const status = await probeUpdateProcess(owner.process);
    if (status !== "gone") updateFailure(status === "alive" ? "update_busy" : "update_owner_unknown");
  }
  const resultState = await readServerMaintenanceState(input.directory);
  const result = resultState === null ? null : { state: resultState };
  const journal = await readLegacyJournal(input.directory);
  await validateBackups(plan, input.directory, journal,
    path.basename(input.directory) === ".compet-maintenance-retired" && (result?.state === "verified" || result?.state === "rolled_back"));
  await validateNamespace(plan, input.directory);
  const staged = path.basename(input.directory) === ".compet-maintenance-staging";
  if (staged && (result?.state !== "prepared" || journal.length)) updateFailure("update_transaction_pending");
  const snapshot = await input.lifecycle.capture();
  if (snapshot.wasRunning) await input.authorizeOnline();
  await input.lifecycle.quiesce(snapshot); await input.lifecycle.assertStopped();
  if (!sameFingerprint(await fingerprintFile(path.join(input.directory, "plan.txt")), planFingerprint) ||
      !sameFingerprint((await currentConfig(plan)).fingerprint, configuration.fingerprint)) updateFailure("maintenance_config_changed");
  let baselineCleanup = result?.state === "rolled_back";
  if (!result && path.basename(input.directory) === ".compet-maintenance-retired") {
    try { await verifyTree(plan, input.directory, plan.baselineFiles); baselineCleanup = true; }
    catch (error) { if (codeOf(error) !== "maintenance_tree_changed") throw error; }
  }
  if (baselineCleanup) {
    await verifyTree(plan, input.directory, plan.baselineFiles);
    if (owner) {
      if (await probeUpdateProcess(owner.process) !== "gone") updateFailure("update_busy");
      await cleanupRunners(plan, owner.runners);
      await fs.unlink(ownerPath); await syncDirectory(input.directory);
    }
    await clearServerTerminalTransaction(input.directory);
    return { status: "completed", code: "maintenance_rolled_back" };
  }
  const helper = path.join(input.directory, "Compet Updater.exe");
  const installedHelper = path.join(plan.root, "runtime/updater/Compet Updater.exe");
  const executable = await exists(helper) ? helper : installedHelper;
  if (!sameFingerprint(await fingerprintFile(executable), plan.helper)) updateFailure("maintenance_recovery_runtime_required");
  let directory = input.directory;
  if (staged) {
    const active = path.join(plan.root, ".compet-maintenance");
    if (await exists(active) || await exists(path.join(plan.root, ".compet-maintenance-retired"))) updateFailure("update_transaction_pending");
    await fs.rename(directory, active); await syncDirectory(plan.root); directory = active;
  }
  const target = executable === helper ? path.join(directory, "Compet Updater.exe") : executable;
  if (!sameFingerprint(await fingerprintFile(target), plan.helper)) updateFailure("maintenance_runner_invalid");
  const child = spawn(target, [result?.state === "verified" ? "--finish-server" : "--recover", "--plan", path.join(directory, "plan.txt"), "--pid", String(process.pid)],
    { detached: true, windowsHide: true, stdio: "ignore", cwd: plan.root });
  await new Promise<void>((resolve,reject)=>{child.once("spawn",resolve);child.once("error",reject);}); child.unref();
  return { status: "handed_off" };
}
