import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import type { ServerConfig } from "../config/config.js";
import { assertServerConfigPaths } from "../config/config.js";
import type { ServerLayout } from "../shared/serverPackageLayout.js";
import { compareSemver, isSemver } from "../shared/version.js";
import { assertPlainPath, fingerprintFile, sameFingerprint } from "../desktop/main/serverManagedFiles.js";
import type { ServerLifecycle } from "./serverLifecycle.js";
import { loadServerRelease, validateServerInventory, verifyServerFile, validateServerFile, assertUniqueServerFiles } from "./serverRelease.js";
import { captureUpdateProcess, probeUpdateProcess, writeUpdateOwner, readUpdateOwner, readServerPlan,
  readServerResult, readServerJournal, writeServerPlan, writeServerJournal, writeServerResult,
  readServerProgramFiles, fingerprintServerConfiguration, serverProtectedPaths, assertServerConfiguration,
  serverPathsOverlap, syncDirectory, sameServerImage, readDurableJson, writeDurableJson, discardServerMetadataTemps, type UpdateOwner } from "./serverTransaction.js";
import { readServerUpdateReceipt, recoverServerReceipt } from "./serverWorker.js";
import { strictObject, updateFailure, type ServerPlanV5, type ServerUpdateAction, type ServerUpdateResult,
  type ServerPackageFile, type ServerOperation } from "./serverUpdateTypes.js";

export { captureUpdateProcess, probeUpdateProcess, writeUpdateOwner, fingerprintServerConfiguration } from "./serverTransaction.js";
function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[a-z][a-z0-9_]+$/.test(code) ? code : "maintenance_io_failed";
}
async function exists(file: string): Promise<boolean> {
  await assertPlainPath(file);
  try { await fs.lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function pendingDirectories(layout: Pick<ServerLayout, "installRoot">): Promise<string[]> {
  const result: string[] = [];
  for (const name of [".compet-maintenance-staging", ".compet-maintenance", ".compet-maintenance-retired"]) {
    const directory = path.join(layout.installRoot, name);
    if (await exists(directory)) {
      if (!(await fs.lstat(directory)).isDirectory()) updateFailure("update_transaction_conflict");
      result.push(directory);
    }
  }
  return result;
}
export async function isServerUpdateBlocked(layout: ServerLayout, config: ServerConfig): Promise<boolean> {
  try {
    if ((await pendingDirectories(layout)).length) return true;
    return (await readServerUpdateReceipt({ root: layout.installRoot, dataDir: config.dataDir }))?.serviceRestorePending ?? false;
  } catch { return true; }
}
export async function readServerUpdateStatus(input: { layout: ServerLayout; config: ServerConfig; configPath: string }): Promise<unknown> {
  const directories = await pendingDirectories(input.layout);
  const transactions = [];
  for (const directory of directories) {
    try {
      const owner = await readUpdateOwner(directory);
      transactions.push({ transactionId: owner.transactionId, directory, owner: await probeUpdateProcess(owner.process), phase: owner.phase });
    } catch { transactions.push({ directory, owner: "unknown", phase: "unknown" }); }
  }
  const receipt = await readServerUpdateReceipt({ root: input.layout.installRoot, dataDir: input.config.dataDir });
  return { blocked: transactions.length > 0 || receipt?.serviceRestorePending === true, transactions,
    receipt: receipt ? { transactionId: receipt.transactionId, fileResult: receipt.fileResult,
      serviceRestorePending: receipt.serviceRestorePending, serviceRestoreResult: receipt.serviceRestoreResult } : null };
}
async function currentVersion(layout: ServerLayout): Promise<string> {
  const file = path.join(layout.appRoot, "package.json"); await assertPlainPath(file);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file))); }
  catch { updateFailure("package_identity_invalid"); }
  const identity = value as { name?: unknown; version?: unknown } | null;
  if (!identity || identity.name !== "compet-server-manager" || typeof identity.version !== "string" || !isSemver(identity.version)) updateFailure("package_identity_invalid");
  return identity.version;
}
async function readPreparingFiles(directory: string, owner: UpdateOwner, expected?: ServerPackageFile[]): Promise<ServerPackageFile[]> {
  const value = strictObject(await readDurableJson(path.join(directory, "release.json")),
    ["protocol", "transactionId", "root", "platform", "version", "files"]);
  const platform = process.platform + "-" + process.arch;
  if (value.protocol !== 5 || value.transactionId !== owner.transactionId || value.root !== owner.root ||
      value.platform !== platform || !["linux-x64", "win32-x64"].includes(platform) ||
      typeof value.version !== "string" || !isSemver(value.version) || !Array.isArray(value.files) || !value.files.length) updateFailure("update_release_invalid");
  const files = value.files.map(file => validateServerFile(file, platform as ServerLayout["platform"]));
  assertUniqueServerFiles(files);
  if (expected && (files.length !== expected.length ||
      files.some(file => !expected.some(target => target.path === file.path && sameServerImage(file, target, false))))) updateFailure("update_release_invalid");
  return files;
}
async function clearOwnedStaging(directory: string, owner: UpdateOwner): Promise<void> {
  if (!await exists(directory)) return;
  const actual = await readUpdateOwner(directory);
  if (JSON.stringify(actual) !== JSON.stringify(owner)) updateFailure("update_owner_unknown");
  const plan = await readServerPlan(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  await discardServerMetadataTemps(directory, actual, plan ?? undefined);
  let incomplete = false;
  let runnerNames: string[] = [];
  if (plan) {
    const optional = <T>(read: Promise<T>) => read.catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    const result = await optional(readServerResult(directory, plan)), journal = await optional(readServerJournal(directory, plan));
    if (result && result.state !== "prepared" || journal && journal.count !== 0) updateFailure("update_recovery_required");
    incomplete = !result || !journal;
    if (actual.phase !== "preparing") updateFailure("update_recovery_required");
    const actualFiles = await readServerProgramFiles({ root: plan.root, platform: plan.platform, protectedPaths: plan.protectedPaths,
      transactionDirectories: await pendingDirectories({ installRoot: plan.root }) });
    if (actualFiles.length !== plan.baselineFiles.length || actualFiles.some(file =>
        !sameServerImage(file, plan.baselineFiles.find(before => before.path === file.path) ?? null))) updateFailure("maintenance_before_changed");
    if (await exists(plan.runner.directory)) runnerNames = await assertRunnerContents(plan.runner.directory, plan.runner.files, plan.platform);
  }
  const allowed = new Set(["owner.json", "release.json", "plan.json", "journal.json", "result.json", "files"]);
  const entries = await fs.readdir(directory);
  if (entries.some(name => !allowed.has(name)) || !plan && (actual.phase !== "preparing" ||
      entries.some(name => !["owner.json", "release.json", "files"].includes(name)))) updateFailure("maintenance_cleanup_conflict");
  const releaseFiles = entries.includes("release.json") ? await readPreparingFiles(directory, actual, plan?.expectedFiles) : [];
  const payload = path.join(directory, "files");
  if (await exists(payload)) {
    if (incomplete && releaseFiles.length === 0 && (await fs.readdir(payload)).length !== 0) updateFailure("maintenance_cleanup_conflict");
    const known = new Map((plan?.expectedFiles ?? releaseFiles).map(file => [file.sha256, file]));
    for (const hash of await fs.readdir(payload)) {
      const file = known.get(hash);
      if (!file || !sameFingerprint(await fingerprintFile(path.join(payload, hash)), file)) updateFailure("maintenance_cleanup_conflict");
    }
  }
  if (actual.phase !== "preparing") updateFailure("update_recovery_required");
  const cleaningOwner: UpdateOwner = { ...actual, cleanup: true };
  if (!actual.cleanup) await writeUpdateOwner(directory, cleaningOwner);
  // Keep the plan and owner until every bound runner file is gone.
  if (plan && await exists(plan.runner.directory)) {
    for (const name of runnerNames) { await fs.unlink(path.join(plan.runner.directory, name)); await syncDirectory(plan.runner.directory); }
    await fs.rmdir(plan.runner.directory); await syncDirectory(path.dirname(plan.runner.directory));
  }
  if (await exists(payload)) {
    for (const hash of await fs.readdir(payload)) { await fs.unlink(path.join(payload, hash)); await syncDirectory(payload); }
    await fs.rmdir(payload); await syncDirectory(directory);
  }
  const metadata = entries.filter(name => !["files", "owner.json", "plan.json", "release.json"].includes(name));
  for (const name of [...metadata, ...["release.json", "plan.json"].filter(name => entries.includes(name))]) {
    const file = path.join(directory, name); await assertPlainPath(file);
    if (!(await fs.lstat(file)).isFile()) updateFailure("maintenance_cleanup_conflict");
    await fs.unlink(file); await syncDirectory(directory);
  }
  // Only the retirement name may legitimately be empty after removing its owner.
  const retired = path.join(owner.root, ".compet-maintenance-retired");
  if (directory !== retired) {
    if (await exists(retired)) updateFailure("maintenance_cleanup_conflict");
    await fs.rename(directory, retired); await syncDirectory(owner.root);
  }
  if (JSON.stringify(await readUpdateOwner(retired)) !== JSON.stringify(cleaningOwner) ||
      (await fs.readdir(retired)).some(name => name !== "owner.json")) updateFailure("maintenance_cleanup_conflict");
  await fs.unlink(path.join(retired, "owner.json")); await syncDirectory(retired);
  await fs.rmdir(retired); await syncDirectory(owner.root);
}
async function claimStaging(layout: ServerLayout, transactionId: string): Promise<{ directory: string; owner: UpdateOwner }> {
  const directory = path.join(layout.installRoot, ".compet-maintenance-staging");
  const processIdentity = await captureUpdateProcess(process.pid); if (!processIdentity) updateFailure("update_process_unknown");
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") updateFailure("update_busy"); throw error; }
  await syncDirectory(layout.installRoot);
  const owner: UpdateOwner = { protocol: 5, transactionId, root: layout.installRoot, phase: "preparing", process: processIdentity };
  await writeUpdateOwner(directory, owner);
  return { directory, owner };
}
async function verifyRunner(plan: ServerPlanV5): Promise<void> {
  for (const file of plan.runner.files) await verifyServerFile(path.join(plan.runner.directory, file.path), file, plan.platform);
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.ELECTRON_RUN_AS_NODE;
  const version = await new Promise<string>((resolve, reject) => execFile(path.join(plan.runner.directory, plan.runner.node), ["--version"],
    { env, shell: false, windowsHide: true, timeout: 10_000, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  if (!/^v24\./.test(version)) updateFailure("maintenance_runner_invalid");
}
async function assertRunnerContents(directory: string, files: ServerPackageFile[], platform: ServerLayout["platform"]): Promise<string[]> {
  await assertPlainPath(directory);
  const names = await fs.readdir(directory);
  for (const name of names) {
    const file = files.find(file => file.path === name);
    if (!file) updateFailure("maintenance_cleanup_conflict");
    await verifyServerFile(path.join(directory, name), file, platform);
  }
  return names;
}
async function rebuildMissingRunner(plan: ServerPlanV5, directory: string): Promise<void> {
  const runner = plan.runner.directory;
  const names = await exists(runner) ? await fs.readdir(runner) : [];
  const temporaryFor = (file: ServerPackageFile) => file.path + "." + plan.transactionId + ".tmp";
  if (names.some(name => !plan.runner.files.some(file => name === file.path || name === temporaryFor(file)))) updateFailure("maintenance_cleanup_conflict");
  const layout = (await import("../shared/serverPackageLayout.js")).resolveServerLayout({ platform: plan.platform, installRoot: plan.root });
  const sources = [];
  for (const file of plan.runner.files) {
    const target = path.join(runner, file.path), temporary = path.join(runner, temporaryFor(file));
    const present = names.includes(file.path);
    let repairMode = false;
    if (present) {
      try { await verifyServerFile(target, file, plan.platform); }
      catch (error) {
        if (plan.platform !== "linux-x64" || (error as NodeJS.ErrnoException).code !== "update_manifest_mode_invalid") throw error;
        repairMode = true;
      }
    }
    let source = target;
    if (!present || repairMode) {
      source = path.join(directory, "files", file.sha256);
      if (!await exists(source)) source = file.path === plan.runner.node ? layout.nodePath : layout.workerEntry;
      if (!sameFingerprint(await fingerprintFile(source), file)) updateFailure("maintenance_source_invalid");
    }
    const intermediates = [...(names.includes(temporaryFor(file)) ? [temporary] : []), ...(repairMode ? [target] : [])];
    for (const intermediate of intermediates) {
      await assertPlainPath(intermediate);
      const info = await fs.lstat(intermediate), parent = await fs.stat(runner);
      const sourceInfo = await fs.stat(source), sourceMode = sourceInfo.mode & 0o7777, mode = info.mode & 0o7777;
      // copyFile may preserve a safe source mode or reduce it through the current umask.
      const copiedMode = (sourceMode & 0o7022) === 0 && (mode & 0o400) !== 0 && (mode & ~sourceMode) === 0;
      if (!info.isFile() || info.nlink !== 1 || info.size > file.size ||
          process.platform === "linux" && (!(mode === 0o600 || mode === file.mode || copiedMode) ||
            info.uid !== parent.uid && info.uid !== process.getuid?.() &&
            !(info.uid === sourceInfo.uid && info.gid === sourceInfo.gid))) updateFailure("maintenance_cleanup_conflict");
      const bytes = await fs.readFile(intermediate), expected = await fs.readFile(source);
      if (!bytes.equals(expected.subarray(0, bytes.length))) updateFailure("maintenance_cleanup_conflict");
    }
    sources.push({ file, source, target, temporary, present, repairMode });
  }
  if (!await exists(runner)) { await fs.mkdir(runner, { mode: 0o700 }); await syncDirectory(path.dirname(runner)); }
  for (const { file, source, target, temporary, present, repairMode } of sources) {
    if (await exists(temporary)) { await fs.unlink(temporary); await syncDirectory(runner); }
    if (repairMode) {
      await fs.chmod(target, file.mode!); await verifyServerFile(target, file, plan.platform);
      const handle = await fs.open(target, "r+"); try { await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(runner);
    }
    if (present) continue;
    await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    if (file.mode !== undefined) await fs.chmod(temporary, file.mode);
    await verifyServerFile(temporary, file, plan.platform);
    const handle = await fs.open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
    if (await exists(target)) updateFailure("maintenance_cleanup_conflict");
    await fs.rename(temporary, target); await syncDirectory(runner);
  }
  await assertRunnerContents(runner, plan.runner.files, plan.platform);
}

export async function launchServerWorker(plan: ServerPlanV5, directory: string, mode: "apply" | "recover" | "finish"): Promise<void> {
  if (mode !== "apply") await rebuildMissingRunner(plan, directory);
  await verifyRunner(plan);
  let command = path.join(plan.runner.directory, plan.runner.node), entry = path.join(plan.runner.directory, plan.runner.entry);
  if (mode === "finish") {
    const layout = (await import("../shared/serverPackageLayout.js")).resolveServerLayout({ platform: plan.platform, installRoot: plan.root });
    const node = plan.runner.files.find(file => file.path === plan.runner.node)!;
    if (!sameFingerprint(await fingerprintFile(layout.nodePath), node)) updateFailure("maintenance_finish_runtime_unavailable");
    command = layout.nodePath;
    if (sameFingerprint(await fingerprintFile(layout.workerEntry), plan.runner.files.find(file => file.path === plan.runner.entry)!)) entry = layout.workerEntry;
  }
  const parent = await captureUpdateProcess(process.pid); if (!parent) updateFailure("update_process_unknown");
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, [entry, "--plan", path.join(directory, "plan.json"), "--mode", mode], { shell: false, detached: true, windowsHide: true, stdio: "ignore", cwd: mode === "finish" ? plan.root : plan.runner.directory, env });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const identity = await captureUpdateProcess(child.pid!); if (!identity) updateFailure("update_process_unknown");
  await writeUpdateOwner(directory, { protocol: 5, transactionId: plan.transactionId, root: plan.root, phase: mode === "finish" ? "finisher" : "worker", process: identity, parent });
  child.unref();
}

async function reclaimStaleRootClaims(pending: string[], receipt: Awaited<ReturnType<typeof readServerUpdateReceipt>>,
  config: ServerConfig): Promise<string | undefined> {
  if (receipt?.serviceRestorePending) {
    await assertServerConfiguration(receipt.plan, config);
    const state = await probeUpdateProcess(receipt.owner.process);
    if (receipt.owner.process.pid !== process.pid && state !== "gone") updateFailure(state === "alive" ? "update_busy" : "update_owner_unknown");
  }
  const owners = new Map<string, UpdateOwner>();
  for (const directory of pending) {
    let owner: UpdateOwner;
    try { owner = await readUpdateOwner(directory); }
    catch (error) {
      // A committed receipt can outlive the primary owner during its recorded cleanup.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && receipt?.serviceRestorePending &&
          directory === receipt.cleanup.directory && receipt.cleanup.directories.includes(directory) &&
          receipt.cleanup.files.some(file => file.path === path.join(directory, "owner.json"))) continue;
      updateFailure("update_owner_unknown");
    }
    const state = await probeUpdateProcess(owner.process);
    if (state !== "gone") updateFailure(state === "alive" ? "update_busy" : "update_owner_unknown");
    owners.set(directory, owner);
  }
  const observed = [...owners.values()], transactionId = observed[0]?.transactionId;
  if (receipt?.serviceRestorePending && observed.some(owner => owner.transactionId !== receipt.transactionId)) updateFailure("update_transaction_pending");
  if (!transactionId || pending.length < 2 && !receipt?.serviceRestorePending ||
      observed.some(owner => owner.transactionId !== transactionId)) return;
  let bound = observed.some(owner => owner.cleanup) || receipt?.transactionId === transactionId;
  for (const directory of pending) {
    if (!await exists(path.join(directory, "plan.json"))) continue;
    const plan = await readServerPlan(directory);
    if (plan.transactionId !== transactionId) updateFailure("update_owner_unknown");
    await assertServerConfiguration(plan, config);
    bound = true;
  }
  if (!bound) return;
  const retired = path.join(observed[0]!.root, ".compet-maintenance-retired");
  let reclaimed: string | undefined;
  // The same stale root claim can accompany preparation, worker or receipt recovery.
  for (const directory of [retired, ...pending.filter(directory => directory !== retired)]) {
    const owner = owners.get(directory);
    if (!owner || owner.phase !== "preparing") continue;
    const names = await fs.readdir(directory);
    if (!names.includes("owner.json") || names.some(name => !["owner.json", "owner.json." + transactionId + ".tmp"].includes(name))) continue;
    await clearOwnedStaging(directory, owner);
    pending.splice(pending.indexOf(directory), 1); reclaimed = transactionId;
  }
  return reclaimed;
}

export async function executeServerUpdate(input: {
  action: ServerUpdateAction; layout: ServerLayout; config: ServerConfig; configPath: string;
  lifecycle: ServerLifecycle; authorizeOnline: () => Promise<void>;
}): Promise<ServerUpdateResult> {
  let claim: Awaited<ReturnType<typeof claimStaging>> | undefined;
  let quiescenceStarted = false;
  try {
    if (!["check", "apply", "repair", "recover"].includes(input.action) || input.layout.platform !== process.platform + "-" + process.arch) updateFailure("server_platform_unsupported");
    assertServerConfigPaths(input.config, input.layout);
    await assertPlainPath(input.layout.installRoot);
    const protectedPaths = serverProtectedPaths(input.layout, input.config);
    if (input.action === "check") {
      const version = await currentVersion(input.layout);
      const release = await loadServerRelease({ platform: input.layout.platform, currentVersion: version, action: "check" });
      const actual = await readServerProgramFiles({ root: input.layout.installRoot, platform: input.layout.platform, protectedPaths, transactionDirectories: await pendingDirectories(input.layout) });
      const changed = release.files.filter(file => !sameServerImage(actual.find(candidate => candidate.path === file.path) ?? null, file, false));
      const extras = actual.filter(file => !release.files.some(candidate => candidate.path === file.path));
      return { status: "no_changes", currentVersion: version, targetVersion: release.version, updateAvailable: compareSemver(release.version, version) > 0,
        changedFiles: changed.length + extras.length, changedBytes: changed.reduce((sum, file) => sum + file.size, 0) };
    }
    const pending = await pendingDirectories(input.layout);
    const retired = path.join(input.layout.installRoot, ".compet-maintenance-retired");
    if (pending.includes(retired) && (await fs.readdir(retired)).length === 0) {
      await fs.rmdir(retired); await syncDirectory(input.layout.installRoot);
      pending.splice(pending.indexOf(retired), 1);
    }
    const receipt = await readServerUpdateReceipt({ root: input.layout.installRoot, dataDir: input.config.dataDir });
    if (!receipt?.serviceRestorePending && input.layout.platform === "win32-x64" && pending.length === 1 && (await exists(path.join(pending[0]!, "plan.txt")) ||
        path.basename(pending[0]!) === ".compet-maintenance-retired" && (await fs.readdir(pending[0]!)).length === 0)) {
      const { handoffLegacyServerUpdate } = await import("./legacyServerWorker.js");
      const legacy = await handoffLegacyServerUpdate({ ...input, directory: pending[0]! });
      if (legacy.status !== "completed" || input.action === "recover") return legacy;
      pending.splice(0);
    }
    const reclaimed = await reclaimStaleRootClaims(pending, receipt, input.config);
    if (reclaimed && pending.length === 0 && !receipt?.serviceRestorePending) return { status: "completed", transactionId: reclaimed };
    if (receipt?.serviceRestorePending || input.action === "recover" && receipt && pending.length === 0) {
      claim = await claimStaging(input.layout, receipt.transactionId);
      if (receipt.serviceRestorePending && (await Promise.all(receipt.cleanup.directories.map(exists))).some(Boolean)) {
        const current = await input.lifecycle.capture();
        if (current.wasRunning) await input.authorizeOnline();
        await input.lifecycle.quiesce(receipt.lifecycle);
      }
      return await recoverServerReceipt({ layout: input.layout, config: input.config, lifecycle: input.lifecycle, receipt });
    }
    if (pending.length) {
      if (pending.length !== 1) updateFailure("update_transaction_pending");
      let directory = pending[0]!;
      if (!await exists(path.join(directory, "plan.json"))) {
        const observed = await readUpdateOwner(directory);
        if (observed.phase !== "preparing" || await probeUpdateProcess(observed.process) !== "gone") updateFailure("update_owner_unknown");
        if (path.basename(directory) === ".compet-maintenance-staging") {
          const active = path.join(input.layout.installRoot, ".compet-maintenance");
          if (await exists(active)) updateFailure("update_transaction_pending");
          await fs.rename(directory, active); await syncDirectory(input.layout.installRoot); directory = active;
        }
        claim = await claimStaging(input.layout, observed.transactionId);
        await clearOwnedStaging(directory, observed);
        return { status: "completed" };
      }
      const plan = await readServerPlan(directory);
      await assertServerConfiguration(plan, input.config);
      if ((await readUpdateOwner(directory)).cleanup || !await exists(path.join(directory, "journal.json")) || !await exists(path.join(directory, "result.json"))) {
        const observed = await readUpdateOwner(directory);
        if (observed.phase !== "preparing" || ![".compet-maintenance-staging", ".compet-maintenance"].includes(path.basename(directory))) updateFailure("update_recovery_required");
        if (path.basename(directory) === ".compet-maintenance-staging") {
          const active = path.join(plan.root, ".compet-maintenance");
          if (await exists(active)) updateFailure("update_transaction_pending");
          await fs.rename(directory, active); await syncDirectory(plan.root); directory = active;
        }
        claim = await claimStaging(input.layout, plan.transactionId);
        await clearOwnedStaging(directory, observed);
        return { status: "completed", transactionId: plan.transactionId };
      }
      if (path.basename(directory) === ".compet-maintenance-staging") {
        const stagedState = await readServerResult(directory, plan);
        if (stagedState.state !== "prepared" || (await readServerJournal(directory, plan)).count !== 0) updateFailure("update_transaction_pending");
        const observed = await readUpdateOwner(directory);
        if (await probeUpdateProcess(observed.process) !== "gone") updateFailure("update_busy");
        if (await exists(path.join(directory, "release.json"))) {
          await readPreparingFiles(directory, observed, plan.expectedFiles);
          await fs.unlink(path.join(directory, "release.json")); await syncDirectory(directory);
        }
        const active = path.join(plan.root, ".compet-maintenance");
        if (await exists(active)) updateFailure("update_transaction_pending");
        await fs.rename(directory, active); await syncDirectory(plan.root); directory = active;
        const moved = await readUpdateOwner(active);
        if (JSON.stringify(moved) !== JSON.stringify(observed)) updateFailure("update_owner_unknown");
      }
      claim = await claimStaging(input.layout, plan.transactionId);
      const owner = await readUpdateOwner(directory), state = await probeUpdateProcess(owner.process);
      if (state !== "gone") updateFailure(state === "alive" ? "update_busy" : "update_owner_unknown");
      await discardServerMetadataTemps(directory, owner, plan);
      const current = await input.lifecycle.capture();
      if (current.wasRunning) await input.authorizeOnline();
      await input.lifecycle.quiesce(plan.lifecycle);
      const result = await readServerResult(directory, plan);
      await launchServerWorker(plan, directory, ["verified", "rolled_back"].includes(result.state) ? "finish" : "recover");
      return { status: "handed_off", transactionId: plan.transactionId };
    }
    if (input.action === "recover") return { status: "no_changes" };
    const transactionId = randomUUID();
    claim = await claimStaging(input.layout, transactionId);
    if ((await pendingDirectories(input.layout)).some(directory => directory !== claim!.directory)) updateFailure("update_transaction_pending");
    const version = await currentVersion(input.layout);
    const configurationFingerprint = await fingerprintServerConfiguration({ config: input.config, configPath: input.configPath, layout: input.layout });
    const release = await loadServerRelease({ platform: input.layout.platform, currentVersion: version, action: input.action });
    if (input.action === "apply" && compareSemver(release.version, version) <= 0) return { status: "no_changes", currentVersion: version, targetVersion: release.version, updateAvailable: false };
    const inventoryFile = release.files.find(file => file.path === "compet-package-manifest.json");
    const packagePath = path.relative(input.layout.installRoot, path.join(input.layout.appRoot, "package.json")).split(path.sep).join("/");
    const packageFile = release.files.find(file => file.path === packagePath);
    const nodeFile = release.files.find(file => file.path === path.relative(input.layout.installRoot, input.layout.nodePath).split(path.sep).join("/"));
    const workerFile = release.files.find(file => file.path === path.relative(input.layout.installRoot, input.layout.workerEntry).split(path.sep).join("/"));
    if (!inventoryFile || !packageFile || !nodeFile || !workerFile) updateFailure("maintenance_inventory_missing");
    await writeDurableJson(path.join(claim.directory, "release.json"), { protocol: 5, transactionId, root: input.layout.installRoot,
      platform: input.layout.platform, version: release.version, files: release.files.map(({ url: _url, ...file }) => file) });
    const payload = path.join(claim.directory, "files"); await fs.mkdir(payload, { mode: 0o700 });
    const downloaded = new Set<string>();
    const download = async (file: ServerPackageFile) => {
      const destination = path.join(payload, file.sha256);
      if (!downloaded.has(file.sha256)) {
        await release.download(file, destination);
        if (!sameFingerprint(await fingerprintFile(destination), file)) updateFailure("maintenance_source_invalid");
        downloaded.add(file.sha256);
      }
      return destination;
    };
    const inventory = validateServerInventory(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(await download(inventoryFile)))), input.layout.platform);
    const outer = release.files.filter(file => file.path !== inventoryFile.path);
    if (inventory.version !== release.version || inventory.files.length !== outer.length || inventory.files.some(file => !outer.some(candidate => candidate.path === file.path && sameServerImage(file, candidate, false)))) updateFailure("maintenance_inventory_mismatch");
    const identity = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(await download(packageFile)))) as { name?: unknown; version?: unknown };
    if (identity.name !== inventory.appId || identity.version !== release.version) updateFailure("maintenance_identity_invalid");
    const baselineFiles = await readServerProgramFiles({ root: input.layout.installRoot, platform: input.layout.platform, protectedPaths, transactionDirectories: [claim.directory] });
    const expectedFiles = [...inventory.files, (({ url: _url, ...file }) => file)(inventoryFile)];
    const operations: ServerOperation[] = [];
    for (const target of expectedFiles) {
      const previous = baselineFiles.find(file => file.path.toLowerCase() === target.path.toLowerCase());
      if (previous && previous.path !== target.path) updateFailure("managed_path_case_conflict");
      if (!sameServerImage(previous ?? null, target, false)) {
        const before = previous && (({ path: _path, ...image }) => image)(previous);
        operations.push({ kind: "replace", ...target, source: "files/" + target.sha256, beforeExists: !!before, ...(before ? { before } : {}) });
      }
    }
    for (const { path: name, ...before } of baselineFiles) if (!expectedFiles.some(file => file.path === name)) operations.push({ kind: "delete", path: name, beforeExists: true, before });
    if (operations.length === 0) return { status: "no_changes", currentVersion: version, targetVersion: release.version, changedFiles: 0, changedBytes: 0 };
    for (const operation of operations) if (operation.kind === "replace") await download(expectedFiles.find(file => file.path === operation.path)!);
    await download(nodeFile); await download(workerFile);
    const lifecycle = await input.lifecycle.capture();
    const runnerDirectory = path.join(tmpdir(), "compet-server-runner-" + transactionId);
    if ([input.layout.installRoot, ...protectedPaths].some(root => serverPathsOverlap(root, runnerDirectory!, input.layout.platform))) updateFailure("update_runner_invalid");
    const node = input.layout.platform === "linux-x64" ? "node" : "node.exe";
    const plan: ServerPlanV5 = { protocol: 5, transactionId, platform: input.layout.platform, root: input.layout.installRoot,
      exe: input.layout.platform === "linux-x64" ? "bin/compet" : "Compet Server Manager.exe", targetVersion: release.version,
      configurationFingerprint, protectedPaths, expectedFiles, baselineFiles, operations,
      runner: { directory: runnerDirectory, node, entry: "worker.cjs", files: [
        (({ url: _url, ...file }) => ({ ...file, path: node }))(nodeFile),
        (({ url: _url, ...file }) => ({ ...file, path: "worker.cjs" }))(workerFile)] }, lifecycle };
    await writeServerPlan(claim.directory, plan);
    await writeServerJournal(claim.directory, { protocol: 5, transactionId, count: 0, entries: [] }, plan);
    await writeServerResult(claim.directory, { protocol: 5, transactionId, platform: plan.platform, root: plan.root, exe: plan.exe, targetVersion: plan.targetVersion, state: "prepared" }, plan);
    await fs.unlink(path.join(claim.directory, "release.json")); await syncDirectory(claim.directory);
    await rebuildMissingRunner(plan, claim.directory);
    await verifyRunner(plan);
    await assertServerConfiguration(plan, input.config);
    const beforeGate = await readServerProgramFiles({ root: plan.root, platform: plan.platform, protectedPaths, transactionDirectories: [claim.directory] });
    if (JSON.stringify(beforeGate) !== JSON.stringify(baselineFiles)) updateFailure("maintenance_before_changed");
    if (lifecycle.wasRunning) await input.authorizeOnline();
    await assertServerConfiguration(plan, input.config);
    quiescenceStarted = true;
    await input.lifecycle.quiesce(lifecycle); await input.lifecycle.assertStopped();
    const active = path.join(plan.root, ".compet-maintenance");
    if ((await pendingDirectories(input.layout)).some(directory => directory !== claim!.directory)) updateFailure("update_transaction_pending");
    await fs.rename(claim.directory, active); await syncDirectory(plan.root);
    claim = undefined;
    await launchServerWorker(plan, active, "apply");
    return { status: "handed_off", transactionId };
  } catch (error) {
    const code = codeOf(error);
    return { status: /^(update_(busy|owner_unknown|transaction_pending|recovery_required)|maintenance_(config_changed|before_changed|external_service))$/.test(code) ? "blocked" : "failed", code };
  } finally {
    if (claim && !quiescenceStarted) {
      try { await clearOwnedStaging(claim.directory, claim.owner); }
      catch { /* Preserve unrecognized evidence; the original result remains visible. */ }
    }
  }
}
