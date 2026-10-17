import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { assertPlainPath, fingerprintFile, sameFingerprint } from "../desktop/main/serverManagedFiles.js";
import { resolveServerLayout } from "../shared/serverPackageLayout.js";
import { createServerWorkerLifecycle, type ServerLifecycle } from "./serverLifecycle.js";
import { verifyServerFile } from "./serverRelease.js";
import { readServerImage, durableCopy, applyFileMutation, rollbackFileMutation } from "./serverFileOperations.js";
import { readServerPlan, readServerJournal, readServerResult, writeServerJournal, writeServerResult,
  readServerProgramFiles, sameServerImage, syncDirectory, readUpdateOwner, probeUpdateProcess,
  captureUpdateProcess, assertServerConfiguration, readDurableJson, writeDurableJson, validateServerPlan,
  validateUpdateOwner, discardServerMetadataTemps, type UpdateOwner } from "./serverTransaction.js";
import { strictObject, updateFailure, assertFingerprint, type ServerPlanV5, type ServerBaselineFile,
  type ServerBeforeImage, type ServerPackageFile, type ServerJournalV5, type ServerResultV5,
  type ServerUpdateResult } from "./serverUpdateTypes.js";

function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[a-z][a-z0-9_]+$/.test(code) ? code : "maintenance_io_failed";
}
async function exists(file: string): Promise<boolean> {
  await assertPlainPath(file);
  try { await fs.lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function image(file: string, plan: ServerPlanV5): Promise<ServerBeforeImage | null> {
  return readServerImage(file, plan.platform);
}
function transactionResult(plan: ServerPlanV5, state: ServerResultV5["state"], code?: string, recoveryPhase?: ServerResultV5["recoveryPhase"]): ServerResultV5 {
  return { protocol: 5, transactionId: plan.transactionId, platform: plan.platform, root: plan.root, exe: plan.exe,
    targetVersion: plan.targetVersion, state, ...(code ? { code } : {}), ...(recoveryPhase ? { recoveryPhase } : {}) };
}
async function verifyTree(plan: ServerPlanV5, directory: string, files: ServerPackageFile[], baseline = false): Promise<void> {
  const directories = [directory];
  const staging = path.join(plan.root, ".compet-maintenance-staging");
  if (directory !== staging && await exists(staging)) {
    const owner = await readUpdateOwner(staging);
    if (owner.transactionId !== plan.transactionId) updateFailure("update_busy");
    directories.push(staging);
  }
  const actual = await readServerProgramFiles({ root: plan.root, platform: plan.platform, protectedPaths: plan.protectedPaths,
    transactionDirectories: (await Promise.all(directories.map(async value => await exists(value) ? value : null))).filter((value): value is string => value !== null), transactionPlan: plan });
  if (actual.length !== files.length) updateFailure("maintenance_tree_changed");
  const expected = new Map(files.map(file => [file.path, file]));
  for (const file of actual) if (!sameServerImage(file, expected.get(file.path) ?? null, baseline)) updateFailure("maintenance_tree_changed");
  if (!baseline) for (const file of files) await verifyServerFile(path.join(plan.root, file.path), file, plan.platform);
}
async function verifySources(plan: ServerPlanV5, directory: string): Promise<void> {
  for (const operation of plan.operations) if (operation.kind === "replace" &&
      !sameFingerprint(await fingerprintFile(path.join(directory, operation.source)), operation)) updateFailure("maintenance_source_invalid");
}
async function validateBackups(plan: ServerPlanV5, directory: string, journal: ServerJournalV5): Promise<void> {
  const backupDirectory = path.join(directory, "backup");
  const names = await exists(backupDirectory) ? await fs.readdir(backupDirectory) : [];
  for (const name of names) {
    if (!/^(0|[1-9][0-9]*)\.bin$/.test(name)) updateFailure("maintenance_backup_invalid");
    const index = Number(name.slice(0, -4)), operation = plan.operations[index];
    if (!operation?.beforeExists || !sameFingerprint(await fingerprintFile(path.join(backupDirectory, name)), operation.before!)) updateFailure("maintenance_backup_invalid");
  }
  for (const entry of journal.entries) if (entry.beforeExists && !names.includes(entry.index + ".bin")) updateFailure("maintenance_backup_invalid");
}
async function validateNamespace(plan: ServerPlanV5, directory: string, journal: ServerJournalV5): Promise<void> {
  for (const name of await fs.readdir(directory)) {
    if (!["plan.json", "result.json", "journal.json", "owner.json", "files", "backup"].includes(name)) updateFailure("maintenance_cleanup_conflict");
    const absolute = path.join(directory, name); await assertPlainPath(absolute);
    const stat = await fs.lstat(absolute);
    if (name === "files") {
      if (!stat.isDirectory()) updateFailure("maintenance_source_invalid");
      for (const hash of await fs.readdir(absolute)) {
        const expected = plan.expectedFiles.find(file => file.sha256 === hash);
        if (!expected || !sameFingerprint(await fingerprintFile(path.join(absolute, hash)), expected)) updateFailure("maintenance_source_invalid");
      }
    } else if (name !== "backup" && !stat.isFile()) updateFailure("maintenance_cleanup_conflict");
  }
  await validateBackups(plan, directory, journal);
}
async function assertWorkerIdentity(plan: ServerPlanV5, mode: string): Promise<void> {
  if (plan.platform !== process.platform + "-" + process.arch) updateFailure("update_manifest_platform_mismatch");
  const node = plan.runner.files.find(file => file.path === plan.runner.node)!;
  const entry = plan.runner.files.find(file => file.path === plan.runner.entry)!;
  if (!sameFingerprint(await fingerprintFile(process.execPath), node) || !process.argv[1] ||
      !sameFingerprint(await fingerprintFile(path.resolve(process.argv[1])), entry)) updateFailure("maintenance_runner_invalid");
  if (mode !== "finish" && (path.resolve(process.execPath) !== path.resolve(plan.runner.directory, plan.runner.node) ||
      path.resolve(process.argv[1]) !== path.resolve(plan.runner.directory, plan.runner.entry))) updateFailure("maintenance_runner_invalid");
  if (mode === "finish" && path.resolve(process.execPath) === path.resolve(plan.runner.directory, plan.runner.node)) updateFailure("maintenance_runner_still_active");
}
async function awaitOwnership(plan: ServerPlanV5, directory: string): Promise<UpdateOwner> {
  const own = await captureUpdateProcess(process.pid);
  if (!own) updateFailure("update_process_unknown");
  const deadline = Date.now() + 15_000;
  while (true) {
    let owner: UpdateOwner | undefined;
    try { owner = await readUpdateOwner(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (owner?.transactionId !== undefined && owner.transactionId !== plan.transactionId) updateFailure("update_busy");
    if (owner?.process.pid === own.pid && owner.process.startTime === own.startTime && owner.process.executable.toLowerCase() === own.executable.toLowerCase()) {
      if (owner.parent) {
        const parent = await probeUpdateProcess(owner.parent);
        if (parent === "unknown") updateFailure("update_owner_unknown");
        if (parent === "alive") {
          if (Date.now() >= deadline) updateFailure("maintenance_parent_running");
          await new Promise(resolve => setTimeout(resolve, 50)); continue;
        }
      }
      return owner;
    }
    if (Date.now() >= deadline) updateFailure("update_owner_unknown");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function requireSpace(plan: ServerPlanV5): Promise<void> {
  const space = await fs.statfs(plan.root);
  const needed = plan.operations.reduce((sum, operation) => sum + (operation.before?.size ?? 0) + (operation.kind === "replace" ? operation.size : 0), 32 * 1024 * 1024);
  if (!Number.isSafeInteger(needed) || space.bavail * space.bsize < needed) updateFailure("maintenance_disk_space_insufficient");
}
async function rollback(plan: ServerPlanV5, directory: string, journal: ServerJournalV5, lifecycle: ServerLifecycle): Promise<void> {
  await validateBackups(plan, directory, journal);
  for (const entry of [...journal.entries].reverse()) {
    await lifecycle.assertStopped(); await assertServerConfiguration(plan);
    const operation = plan.operations[entry.index]!;
    await rollbackFileMutation({
      platform: plan.platform, target: path.join(plan.root, operation.path), temporary: path.join(plan.root, entry.temporary),
      before: entry.before ?? null, after: entry.after ?? null,
      assertCanWrite: async () => { await lifecycle.assertStopped(); await assertServerConfiguration(plan); },
      ...(operation.kind === "replace" ? { source: path.join(directory, operation.source) } : {}),
      ...(entry.backup ? { backup: path.join(directory, entry.backup) } : {}),
    });
  }
  await verifyTree(plan, directory, plan.baselineFiles, true);
}

interface CleanupFile { path: string; size: number; sha256: string }
interface ServerReceipt {
  protocol: 5;
  transactionId: string;
  root: string;
  configurationFingerprint: ServerPlanV5["configurationFingerprint"];
  targetInventoryFingerprint: ServerPackageFile;
  fileResult: "verified" | "rolled_back";
  lifecycle: ServerPlanV5["lifecycle"];
  serviceRestorePending: boolean;
  serviceRestoreResult: { status: "pending" | "restored" | "failed"; code?: string };
  plan: ServerPlanV5;
  owner: UpdateOwner;
  cleanup: { directory: string; files: CleanupFile[]; directories: string[] };
}
function validateReceipt(raw: unknown, root: string): ServerReceipt {
  const value = strictObject(raw, ["protocol", "transactionId", "root", "configurationFingerprint", "targetInventoryFingerprint", "fileResult", "lifecycle",
    "serviceRestorePending", "serviceRestoreResult", "plan", "owner", "cleanup"]);
  const plan = validateServerPlan(value.plan);
  const directory = strictObject(value.cleanup, ["directory", "files", "directories"]);
  if (value.protocol !== 5 || value.transactionId !== plan.transactionId || value.root !== root || root !== plan.root ||
      !["verified", "rolled_back"].includes(String(value.fileResult)) || typeof value.serviceRestorePending !== "boolean" ||
      JSON.stringify(value.configurationFingerprint) !== JSON.stringify(plan.configurationFingerprint) || JSON.stringify(value.lifecycle) !== JSON.stringify(plan.lifecycle) ||
      JSON.stringify(value.targetInventoryFingerprint) !== JSON.stringify(plan.expectedFiles.find(file => file.path === "compet-package-manifest.json")) ||
      typeof directory.directory !== "string" || ![".compet-maintenance", ".compet-maintenance-staging", ".compet-maintenance-retired"].some(name => directory.directory === path.join(root, name)) ||
      !Array.isArray(directory.files) || !Array.isArray(directory.directories)) updateFailure("maintenance_receipt_invalid");
  const owner = validateUpdateOwner(value.owner, String(directory.directory));
  if (owner.transactionId !== plan.transactionId || owner.phase !== "finisher") updateFailure("maintenance_receipt_invalid");
  const restore = strictObject(value.serviceRestoreResult, ["status"], ["code"]);
  if (!["pending", "restored", "failed"].includes(String(restore.status)) || (restore.status === "restored") === value.serviceRestorePending ||
      (restore.status === "failed") !== ("code" in restore) || "code" in restore && (typeof restore.code !== "string" || !/^[a-z][a-z0-9_]+$/.test(restore.code))) updateFailure("maintenance_receipt_invalid");
  const allowed = cleanupAllowlist(plan, String(directory.directory));
  const seen = new Set<string>();
  for (const rawFile of directory.files) {
    const file = strictObject(rawFile, ["path", "size", "sha256"]); assertFingerprint(file);
    if (typeof file.path !== "string" || !allowed.files.has(file.path) || seen.has(file.path)) updateFailure("maintenance_receipt_invalid");
    seen.add(file.path);
  }
  const directorySet = new Set(directory.directories);
  if (directorySet.size !== directory.directories.length || directory.directories.some(p => typeof p !== "string" || !allowed.directories.has(p))) updateFailure("maintenance_receipt_invalid");
  return { ...value, plan, owner } as unknown as ServerReceipt;
}
function cleanupAllowlist(plan: ServerPlanV5, directory: string) {
  const files = new Set(["plan.json", "result.json", "journal.json", "owner.json"].map(name => path.join(directory, name)));
  const directories = new Set([directory, path.join(directory, "files"), path.join(directory, "backup"), plan.runner.directory]);
  for (const file of plan.expectedFiles) files.add(path.join(directory, "files", file.sha256));
  for (const [index, operation] of plan.operations.entries()) if (operation.beforeExists) files.add(path.join(directory, "backup", index + ".bin"));
  for (const file of plan.runner.files) files.add(path.join(plan.runner.directory, file.path));
  return { files, directories };
}
async function cleanupSnapshot(plan: ServerPlanV5, directory: string) {
  const allowed = cleanupAllowlist(plan, directory), files: CleanupFile[] = [], directories: string[] = [];
  async function visit(current: string) {
    if (!await exists(current)) return;
    const stat = await fs.lstat(current);
    if (stat.isDirectory()) {
      if (!allowed.directories.has(current)) updateFailure("maintenance_cleanup_conflict");
      directories.push(current);
      for (const entry of await fs.readdir(current)) await visit(path.join(current, entry));
    } else {
      if (!allowed.files.has(current)) updateFailure("maintenance_cleanup_conflict");
      const fingerprint = await fingerprintFile(current);
      if (!fingerprint) updateFailure("maintenance_cleanup_conflict");
      files.push({ path: current, ...fingerprint });
    }
  }
  await visit(directory); await visit(plan.runner.directory);
  return { directory, files, directories };
}
async function writeReceipt(receiptPath: string, receipt: ServerReceipt, dataDir: string) {
  await assertPlainPath(dataDir);
  const data = await fs.stat(dataDir);
  if (!data.isDirectory()) updateFailure("maintenance_receipt_invalid");
  const logs = path.dirname(receiptPath); await assertPlainPath(logs);
  let created = false;
  try { await fs.mkdir(logs, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (created && process.platform === "linux") {
    const stat = await fs.stat(logs);
    if (stat.uid !== data.uid || stat.gid !== data.gid) await fs.chown(logs, data.uid, data.gid);
  }
  await discardServerMetadataTemps(logs, receipt.owner, receipt.plan, raw => validateReceipt(raw, receipt.root));
  await writeDurableJson(receiptPath, receipt, { uid: data.uid, gid: data.gid });
}
async function cleanupFromReceipt(receipt: ServerReceipt, lifecycle: ServerLifecycle): Promise<void> {
  if (path.resolve(process.execPath) === path.resolve(receipt.plan.runner.directory, receipt.plan.runner.node)) updateFailure("maintenance_runner_still_active");
  const recorded = new Map(receipt.cleanup.files.map(file => [file.path, file]));
  const actual = await cleanupSnapshot(receipt.plan, receipt.cleanup.directory);
  for (const file of actual.files) if (!sameFingerprint(file, recorded.get(file.path) ?? null)) updateFailure("maintenance_cleanup_conflict");
  for (const directory of actual.directories) if (!receipt.cleanup.directories.includes(directory)) updateFailure("maintenance_cleanup_conflict");
  if (actual.files.length === 0 && actual.directories.length === 0) {
    await verifyTree(receipt.plan, receipt.cleanup.directory, receipt.fileResult === "verified" ? receipt.plan.expectedFiles : receipt.plan.baselineFiles, receipt.fileResult === "rolled_back");
    return;
  }
  await lifecycle.assertStopped();
  await verifyTree(receipt.plan, receipt.cleanup.directory, receipt.fileResult === "verified" ? receipt.plan.expectedFiles : receipt.plan.baselineFiles, receipt.fileResult === "rolled_back");
  const last = [path.join(receipt.cleanup.directory, "result.json"), path.join(receipt.cleanup.directory, "plan.json")];
  const files = [...actual.files.filter(file => !last.includes(file.path)), ...last.map(file => recorded.get(file)).filter((file): file is CleanupFile => file !== undefined)];
  for (const file of files) {
    const fingerprint = await fingerprintFile(file.path);
    if (!fingerprint) continue;
    if (!sameFingerprint(fingerprint, file)) updateFailure("maintenance_cleanup_conflict");
    await fs.unlink(file.path); await syncDirectory(path.dirname(file.path));
  }
  for (const directory of [...actual.directories].sort((a, b) => b.length - a.length)) {
    await assertPlainPath(directory); await fs.rmdir(directory); await syncDirectory(path.dirname(directory));
  }
}

export async function readServerUpdateReceipt(input: { root: string; dataDir: string }): Promise<ServerReceipt | null> {
  const file = path.join(input.dataDir, "logs/server-update-receipt.json");
  if (!await exists(file)) return null;
  return validateReceipt(await readDurableJson(file), input.root);
}
export async function recoverServerReceipt(input: {
  layout: ReturnType<typeof resolveServerLayout>; config: import("../config/config.js").ServerConfig;
  lifecycle: ServerLifecycle; receipt: ServerReceipt;
}): Promise<ServerUpdateResult> {
  const receipt = validateReceipt(input.receipt, input.layout.installRoot);
  const receiptPath = path.join(input.config.dataDir, "logs/server-update-receipt.json");
  await assertServerConfiguration(receipt.plan, input.config);
  if (!receipt.serviceRestorePending) return { status: "completed", transactionId: receipt.transactionId, receiptPath };
  const ownerState = await probeUpdateProcess(receipt.owner.process);
  if (receipt.owner.process.pid !== process.pid && ownerState !== "gone") updateFailure(ownerState === "alive" ? "update_busy" : "update_owner_unknown");
  const own = await captureUpdateProcess(process.pid); if (!own) updateFailure("update_process_unknown");
  receipt.owner = { protocol: 5, transactionId: receipt.transactionId, root: receipt.root, phase: "finisher", process: own };
  await writeReceipt(receiptPath, receipt, input.config.dataDir);
  await cleanupFromReceipt(receipt, input.lifecycle);
  try {
    await input.lifecycle.resume(receipt.lifecycle);
    receipt.serviceRestorePending = false; receipt.serviceRestoreResult = { status: "restored" };
    await writeReceipt(receiptPath, receipt, input.config.dataDir);
    return { status: "completed", transactionId: receipt.transactionId, receiptPath };
  } catch (error) {
    receipt.serviceRestoreResult = { status: "failed", code: codeOf(error) };
    await writeReceipt(receiptPath, receipt, input.config.dataDir);
    return { status: "failed", transactionId: receipt.transactionId, receiptPath, code: codeOf(error) };
  }
}

export async function runServerWorker(input: { planPath: string; mode: "validate" | "apply" | "recover" | "finish" }): Promise<ServerUpdateResult> {
  let plan: ServerPlanV5 | undefined;
  const directory = path.dirname(input.planPath);
  try {
    if (!path.isAbsolute(input.planPath) || path.basename(input.planPath) !== "plan.json" || !["validate", "apply", "recover", "finish"].includes(input.mode)) updateFailure("update_worker_arguments_invalid");
    plan = await readServerPlan(directory);
    const config = await assertServerConfiguration(plan);
    await assertWorkerIdentity(plan, input.mode);
    const state = await readServerResult(directory, plan), journal = await readServerJournal(directory, plan);
    if (state.state === "prepared" && journal.count !== 0 || ["applied", "verified"].includes(state.state) && journal.count !== plan.operations.length) updateFailure("update_journal_invalid");
    if (input.mode === "validate") {
      await validateNamespace(plan, directory, journal);
      if (state.state !== "prepared") updateFailure("update_recovery_required");
      await verifySources(plan, directory); await verifyTree(plan, directory, plan.baselineFiles, true);
      return { status: "no_changes", transactionId: plan.transactionId };
    }
    const owner = await awaitOwnership(plan, directory);
    await discardServerMetadataTemps(directory, owner, plan);
    await validateNamespace(plan, directory, journal);
    const layout = resolveServerLayout({ platform: plan.platform, installRoot: plan.root });
    const lifecycle = await createServerWorkerLifecycle({ layout, config, configPath: plan.configurationFingerprint.path, snapshot: plan.lifecycle });
    await lifecycle.assertStopped();
    if (input.mode === "finish") {
      if (!["verified", "rolled_back"].includes(state.state)) updateFailure("update_recovery_required");
      await verifyTree(plan, directory, state.state === "verified" ? plan.expectedFiles : plan.baselineFiles, state.state === "rolled_back");
      const receiptPath = path.join(config.dataDir, "logs/server-update-receipt.json");
      const existing = await readServerUpdateReceipt({ root: plan.root, dataDir: config.dataDir });
      const receipt: ServerReceipt = existing?.transactionId === plan.transactionId ? existing : {
        protocol: 5, transactionId: plan.transactionId, root: plan.root, configurationFingerprint: plan.configurationFingerprint,
        targetInventoryFingerprint: plan.expectedFiles.find(file => file.path === "compet-package-manifest.json")!,
        fileResult: state.state as "verified" | "rolled_back", lifecycle: plan.lifecycle, serviceRestorePending: true,
        serviceRestoreResult: { status: "pending" }, plan, owner: { ...owner, phase: "finisher" }, cleanup: await cleanupSnapshot(plan, directory),
      };
      await writeReceipt(receiptPath, receipt, config.dataDir);
      return await recoverServerReceipt({ layout, config, lifecycle, receipt });
    }
    if (input.mode === "recover") {
      if (state.state === "rolled_back") {
        await verifyTree(plan, directory, plan.baselineFiles, true);
        return { status: "completed", transactionId: plan.transactionId, code: "maintenance_rolled_back" };
      }
      let targetMatches = false;
      try { await verifyTree(plan, directory, plan.expectedFiles); targetMatches = true; }
      catch (error) { if (!["maintenance_tree_changed", "update_file_hash_mismatch", "update_manifest_mode_invalid"].includes(codeOf(error))) throw error; }
      if (targetMatches) {
        if (journal.count !== plan.operations.length) updateFailure("update_journal_invalid");
        await writeServerResult(directory, transactionResult(plan, "verified"), plan);
        return { status: "handed_off", transactionId: plan.transactionId };
      }
      try {
        await rollback(plan, directory, journal, lifecycle);
        await writeServerResult(directory, transactionResult(plan, "rolled_back", "maintenance_interrupted"), plan);
        return { status: "completed", transactionId: plan.transactionId, code: "maintenance_rolled_back" };
      } catch (error) {
        await writeServerResult(directory, transactionResult(plan, "recovery_failed", codeOf(error), state.recoveryPhase ?? (state.state === "prepared" ? "prepared" : state.state === "applying" ? "applying" : "applied")), plan);
        throw error;
      }
    }
    if (state.state !== "prepared") updateFailure("update_recovery_required");
    await verifySources(plan, directory); await verifyTree(plan, directory, plan.baselineFiles, true); await requireSpace(plan);
    await writeServerResult(directory, transactionResult(plan, "applying"), plan);
    try {
      for (const [index, operation] of plan.operations.entries()) {
        await lifecycle.assertStopped(); await assertServerConfiguration(plan);
        const target = path.join(plan.root, operation.path), before = await image(target, plan);
        if (!sameServerImage(before, operation.before ?? null)) updateFailure("maintenance_before_changed");
        if (operation.beforeExists) {
          const backup = path.join(directory, "backup", index + ".bin");
          await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 }); await syncDirectory(directory);
          await durableCopy(target, backup, plan.platform === "linux-x64" ? 0o600 : undefined);
          if (!sameFingerprint(await fingerprintFile(backup), operation.before!)) updateFailure("maintenance_backup_invalid");
        }
        const temporary = ".compet-" + plan.transactionId + "-" + index + ".tmp";
        journal.entries.push({ index, target: operation.path, beforeExists: operation.beforeExists, temporary,
          ...(operation.beforeExists ? { before: operation.before!, backup: "backup/" + index + ".bin" } : {}),
          ...(operation.kind === "replace" ? { after: { size: operation.size, sha256: operation.sha256, ...(operation.mode === undefined ? {} : { mode: operation.mode }) } } : {}) });
        journal.count = journal.entries.length; await writeServerJournal(directory, journal, plan);
        const rootOwner = await fs.stat(plan.root);
        const ownership = plan.platform === "linux-x64" ? { uid: operation.before?.uid ?? rootOwner.uid, gid: operation.before?.gid ?? rootOwner.gid } : undefined;
        await applyFileMutation({
          platform: plan.platform, target, temporary: path.join(plan.root, temporary), before: operation.before ?? null,
          after: operation.kind === "replace" ? operation : null,
          assertCanWrite: async () => { await lifecycle.assertStopped(); await assertServerConfiguration(plan!); },
          ...(operation.kind === "replace" ? { source: path.join(directory, operation.source) } : {}),
        }, ownership);
      }
      await writeServerResult(directory, transactionResult(plan, "applied"), plan);
      await verifyTree(plan, directory, plan.expectedFiles);
      await writeServerResult(directory, transactionResult(plan, "verified"), plan);
      return { status: "handed_off", transactionId: plan.transactionId };
    } catch (error) {
      try {
        await rollback(plan, directory, journal, lifecycle);
        await writeServerResult(directory, transactionResult(plan, "rolled_back", codeOf(error)), plan);
      } catch (recoveryError) {
        await writeServerResult(directory, transactionResult(plan, "recovery_failed", codeOf(recoveryError), "applying"), plan);
      }
      throw error;
    }
  } catch (error) {
    return { status: "failed", ...(plan ? { transactionId: plan.transactionId } : {}), code: codeOf(error) };
  }
}

export async function serverWorkerMain(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs({ args: argv, strict: true, allowPositionals: false,
      options: { plan: { type: "string" }, mode: { type: "string" } } });
    const planPath = parsed.values.plan, mode = parsed.values.mode;
    if (!planPath || !mode || !["validate", "apply", "recover", "finish"].includes(mode)) updateFailure("update_worker_arguments_invalid");
    const result = await runServerWorker({ planPath, mode: mode as "validate" | "apply" | "recover" | "finish" });
    if (result.status === "failed" || result.status === "blocked") { process.stderr.write((result.code ?? "update_failed") + "\n"); return 1; }
    if (mode !== "validate" && mode !== "finish") {
      const directory = path.dirname(planPath), plan = await readServerPlan(directory);
      const state = await readServerResult(directory, plan);
      if (["verified", "rolled_back"].includes(state.state)) {
        const { launchServerWorker } = await import("./serverUpdate.js");
        await launchServerWorker(plan, directory, "finish");
      }
    }
    return 0;
  } catch (error) { process.stderr.write(codeOf(error) + "\n"); return 1; }
}
