import { copyFile, lstat, mkdir, readFile, readdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertPlainPath, buildStrictServerUpdatePlan, fingerprintFile, sameFingerprint, pathsOverlap,
  validatePackageInventory, type PackageFile, type PackageInventory, type FileFingerprint } from "./serverManagedFiles.js";
import { clearMaintenanceStaging, readServerMaintenancePlan, readMaintenanceManifest, readMaintenanceTransaction,
  readServerMaintenanceState, clearServerTerminalTransaction, writeMaintenancePlan, type ServerMaintenancePlan } from "./updateTransaction.js";

export interface ServerRelease {
  version: string;
  files: PackageFile[];
  download(file: PackageFile, destination: string): Promise<void>;
  preflight(helper: string, plan: string): Promise<void>;
}
export interface ServerMaintenanceConfig { dataDir: string; serverRoot: string }
export interface PreparedServerMaintenance {
  installRoot: string; appRoot: string; directory: string; plan: ServerMaintenancePlan;
  configFingerprint: FileFingerprint | null; inventory: PackageInventory;
  planFingerprint: FileFingerprint; manifestFingerprint: FileFingerprint | null;
  pending?: boolean;
}
export interface EmptyRetiredServerMaintenance {
  installRoot: string; appRoot: string; directory: string; plan: null; pending: true;
  configFingerprint: FileFingerprint | null; helperFingerprint: FileFingerprint;
}
function failure(code: string, relatedPath?: string): never {
  throw Object.assign(new Error(code + (relatedPath ? ": " + relatedPath : "")), { code, path: relatedPath });
}
const inventoryName = "compet-package-manifest.json";
const helperName = "runtime/updater/Compet Updater.exe";
const configPath = (appRoot: string) => path.join(appRoot, "user-data/manager-config.json");
async function exists(file: string): Promise<boolean> {
  await assertPlainPath(file);
  try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function protections(root: string, appRoot: string, config: ServerMaintenanceConfig): Promise<string[]> {
  if (!path.isAbsolute(root) || path.resolve(root, "runtime/electron/resources/app") !== appRoot) failure("maintenance_layout_invalid");
  await assertPlainPath(root);
  if (typeof config.dataDir !== "string" || !path.isAbsolute(config.dataDir) ||
      typeof config.serverRoot !== "string" || config.serverRoot && !path.isAbsolute(config.serverRoot)) failure("maintenance_config_invalid");
  if (config.serverRoot && pathsOverlap(root, config.serverRoot)) failure("maintenance_game_root_overlap", config.serverRoot);
  if (config.serverRoot) await assertPlainPath(config.serverRoot);
  const values = [...new Set([path.join(appRoot, "user-data"), path.join(appRoot, "server-data"), path.resolve(config.dataDir)])];
  for (const value of values) {
    await assertPlainPath(value);
    if (pathsOverlap(root, value) && !value.toLowerCase().startsWith(root.toLowerCase() + path.sep) ||
        [".compet-maintenance-staging", ".compet-maintenance", ".compet-maintenance-retired"].some(name => pathsOverlap(value, path.join(root, name)))) failure("managed_path_protected", value);
  }
  return values;
}

export async function preparePendingServerMaintenance(input: {
  installRoot: string; appRoot: string; config: ServerMaintenanceConfig;
}): Promise<PreparedServerMaintenance | EmptyRetiredServerMaintenance | null> {
  const { installRoot, appRoot } = input;
  const protectedPaths = await protections(installRoot, appRoot, input.config);
  const active = path.join(installRoot, ".compet-maintenance"), retired = path.join(installRoot, ".compet-maintenance-retired");
  const hasActive = await exists(active), hasRetired = await exists(retired);
  if (hasActive && hasRetired) failure("maintenance_transaction_conflict", installRoot);
  if (!hasActive && !hasRetired) return null;
  const directory = hasActive ? active : retired;
  if (hasRetired && !await exists(path.join(directory, "plan.txt"))) {
    if ((await readdir(directory)).length !== 0) failure("maintenance_plan_incomplete", directory);
    const helperFingerprint = await fingerprintFile(path.join(installRoot, helperName));
    if (!helperFingerprint) failure("maintenance_helper_invalid", helperName);
    return { installRoot, appRoot, directory, plan: null, pending: true, helperFingerprint,
      configFingerprint: await fingerprintFile(configPath(appRoot)) };
  }
  const plan = await readServerMaintenancePlan(directory);
  if (plan.root !== installRoot) failure("maintenance_layout_invalid", directory);
  for (const value of protectedPaths) {
    if (plan.expectedFiles.some(file => pathsOverlap(value, path.join(installRoot, file.path))) ||
        plan.baselineFiles.some(file => pathsOverlap(value, path.join(installRoot, file.path)))) failure("managed_path_protected", value);
    if (value.toLowerCase().startsWith(installRoot.toLowerCase() + path.sep) &&
        !plan.protectedPaths.some(p => value.toLowerCase() === p.toLowerCase() || value.toLowerCase().startsWith(p.toLowerCase() + path.sep))) failure("maintenance_config_changed", value);
  }
  const inventory = validatePackageInventory({ schemaVersion: 1, appId: "compet-server-manager", version: plan.targetVersion,
    files: plan.expectedFiles.filter(file => file.path !== inventoryName) }, true);
  const manifestFingerprint = await fingerprintFile(path.join(directory, "manifest.json"));
  return { installRoot, appRoot, directory, plan, inventory, pending: true,
    configFingerprint: await fingerprintFile(configPath(appRoot)), planFingerprint: (await fingerprintFile(path.join(directory, "plan.txt")))!,
    manifestFingerprint };
}

export async function prepareServerMaintenance(input: {
  installRoot: string; appRoot: string; config: ServerMaintenanceConfig; target: ServerRelease;
}): Promise<PreparedServerMaintenance> {
  const { installRoot, appRoot, target } = input;
  const pending = await preparePendingServerMaintenance(input);
  if (pending) {
    if (pending.plan === null) failure("update_transaction_pending", pending.directory);
    return pending;
  }
  const protectedPaths = await protections(installRoot, appRoot, input.config);
  const configFingerprint = await fingerprintFile(configPath(appRoot));
  const directory = path.join(installRoot, ".compet-maintenance-staging");
  await clearMaintenanceStaging(directory);
  const inventoryFiles = target.files.filter(file => file.path === inventoryName);
  const outer = validatePackageInventory({ schemaVersion: 1, appId: "compet-server-manager", version: target.version,
    files: target.files.filter(file => file.path !== inventoryName) }, true);
  const helperFile = outer.files.find(file => file.path === helperName), packageFile = outer.files.find(file => file.path === "runtime/electron/resources/app/package.json");
  if (inventoryFiles.length !== 1 || !helperFile || !packageFile) failure("maintenance_inventory_missing");
  const inventoryFile = inventoryFiles[0]!;
  if (!Number.isSafeInteger(inventoryFile.size) || inventoryFile.size < 0 || !/^[A-F0-9]{64}$/.test(inventoryFile.sha256)) failure("maintenance_inventory_invalid");
  await mkdir(path.join(directory, "files"), { recursive: true });
  try {
    const downloaded = new Set<string>();
    const download = async (file: PackageFile): Promise<string> => {
      const destination = path.join(directory, "files", file.sha256);
      if (!downloaded.has(file.sha256)) {
        await target.download(file, destination);
        if (!sameFingerprint(await fingerprintFile(destination), file)) failure("maintenance_source_invalid", file.path);
        downloaded.add(file.sha256);
      }
      return destination;
    };
    const inventory = validatePackageInventory(JSON.parse((await readFile(await download(inventoryFile), "utf8")).replace(/^\uFEFF/, "")), true);
    if (inventory.version !== target.version || inventory.files.length !== outer.files.length ||
        inventory.files.some(file => !outer.files.some(candidate => candidate.path === file.path && sameFingerprint(candidate, file)))) failure("maintenance_inventory_mismatch");
    const identity = JSON.parse((await readFile(await download(packageFile), "utf8")).replace(/^\uFEFF/, "")) as { name?: unknown; version?: unknown };
    if (identity.name !== inventory.appId || identity.version !== target.version) failure("maintenance_identity_invalid", packageFile.path);
    const difference = await buildStrictServerUpdatePlan({ root: installRoot, target: inventory, inventoryFile, protectedPaths, transactionDirectory: directory });
    if (difference.conflicts.length) failure(difference.conflicts[0]!.code, difference.conflicts[0]!.path);
    for (const op of difference.operations) if (op.kind === "replace") await download({ path: op.path, size: op.size, sha256: op.sha256 });
    await copyFile(await download(helperFile), path.join(directory, "Compet Updater.exe"));
    const plan: ServerMaintenancePlan = { protocol: 4, root: installRoot, exe: "Compet Server Manager.exe", targetVersion: target.version,
      helper: { size: helperFile.size, sha256: helperFile.sha256 }, protectedPaths, operations: difference.operations,
      expectedFiles: difference.expectedFiles, baselineFiles: difference.baselineFiles };
    await writeMaintenancePlan(directory, plan, { inventory });
    await target.preflight(path.join(directory, "Compet Updater.exe"), path.join(directory, "plan.txt"));
    if ((await readMaintenanceTransaction(directory))?.state !== "prepared") failure("maintenance_helper_invalid");
    return { installRoot, appRoot, directory, plan, inventory, configFingerprint,
      planFingerprint: (await fingerprintFile(path.join(directory, "plan.txt")))!, manifestFingerprint: await fingerprintFile(path.join(directory, "manifest.json")) };
  } catch (error) {
    try { await clearMaintenanceStaging(directory); } catch (cleanupError) { console.error("Failed to clear server update staging", cleanupError); }
    throw error;
  }
}

async function assertPreparedServerMaintenance(prepared: PreparedServerMaintenance | EmptyRetiredServerMaintenance): Promise<void> {
  if (!sameFingerprint(await fingerprintFile(configPath(prepared.appRoot)), prepared.configFingerprint)) failure("maintenance_config_changed");
  if (prepared.plan === null) {
    if (prepared.directory !== path.join(prepared.installRoot, ".compet-maintenance-retired") ||
        await exists(path.join(prepared.installRoot, ".compet-maintenance"))) failure("maintenance_transaction_conflict", prepared.directory);
    await assertPlainPath(prepared.directory);
    if ((await readdir(prepared.directory)).length !== 0) failure("maintenance_plan_changed", prepared.directory);
    const helper = path.join(prepared.installRoot, helperName);
    if (!sameFingerprint(await fingerprintFile(helper), prepared.helperFingerprint)) failure("maintenance_helper_invalid", helper);
  } else {
    if (!sameFingerprint(await fingerprintFile(path.join(prepared.directory, "plan.txt")), prepared.planFingerprint) ||
        !sameFingerprint(await fingerprintFile(path.join(prepared.directory, "manifest.json")), prepared.manifestFingerprint)) failure("maintenance_plan_changed");
    const actual = await readServerMaintenancePlan(prepared.directory);
    if (["protocol", "root", "exe", "targetVersion", "helper", "protectedPaths", "operations", "expectedFiles", "baselineFiles"].some(key =>
      JSON.stringify(actual[key as keyof ServerMaintenancePlan]) !== JSON.stringify(prepared.plan[key as keyof ServerMaintenancePlan]))) failure("maintenance_plan_changed");
  }
}

export async function clearRolledBackServerMaintenance(prepared: PreparedServerMaintenance | EmptyRetiredServerMaintenance): Promise<boolean> {
  await assertPreparedServerMaintenance(prepared);
  if (prepared.plan === null) {
    await rmdir(prepared.directory);
    return true;
  }
  if (!prepared.pending) return false;
  const state = await readServerMaintenanceState(prepared.directory);
  if (state !== "rolled_back" && state !== null) return false;
  const difference = await buildStrictServerUpdatePlan({ root: prepared.installRoot, target: prepared.inventory,
    inventoryFile: prepared.plan.expectedFiles.find(file => file.path === inventoryName)!, protectedPaths: prepared.plan.protectedPaths,
    transactionDirectory: prepared.directory });
  if (difference.conflicts.length || difference.baselineFiles.length !== prepared.plan.baselineFiles.length ||
      difference.baselineFiles.some(file => !prepared.plan!.baselineFiles.some(expected => file.path === expected.path && sameFingerprint(file, expected)))) {
    if (state === null) return false;
    failure("maintenance_baseline_changed", prepared.directory);
  }
  await assertPreparedServerMaintenance(prepared);
  await clearServerTerminalTransaction(prepared.directory);
  return true;
}

export async function handoffServerMaintenance(prepared: PreparedServerMaintenance | EmptyRetiredServerMaintenance): Promise<void> {
  await assertPreparedServerMaintenance(prepared);
  if (prepared.plan === null) failure("update_transaction_terminal", prepared.directory);
  let helper: string, args: string[];
  {
    const actual = prepared.plan;
    let directory = prepared.directory;
    let finish = path.basename(directory) === ".compet-maintenance-retired";
    if (!prepared.pending) {
      const evidence = await readMaintenanceManifest(directory) as { inventory?: unknown };
      if (JSON.stringify(validatePackageInventory(evidence.inventory, true)) !== JSON.stringify(prepared.inventory)) failure("maintenance_plan_changed");
      const inventoryFile = prepared.plan.expectedFiles.find(file => file.path === inventoryName)!;
      const difference = await buildStrictServerUpdatePlan({ root: prepared.installRoot, target: prepared.inventory, inventoryFile,
        protectedPaths: prepared.plan.protectedPaths, transactionDirectory: directory });
      if (difference.conflicts.length || JSON.stringify(difference.baselineFiles) !== JSON.stringify(prepared.plan.baselineFiles)) failure("maintenance_baseline_changed");
    } else if (!finish) {
      const state = await readServerMaintenanceState(directory);
      if (state === "rolled_back") failure("update_transaction_terminal", directory);
      finish = state === "verified";
    }
    helper = finish ? path.join(prepared.installRoot, helperName) : path.join(directory, "Compet Updater.exe");
    const helperActual = await fingerprintFile(helper);
    if (!sameFingerprint(helperActual, actual.helper)) failure("maintenance_helper_invalid");
    if (!prepared.pending) {
      directory = path.join(prepared.installRoot, ".compet-maintenance");
      if (await exists(directory) || await exists(path.join(prepared.installRoot, ".compet-maintenance-retired"))) failure("update_transaction_pending");
      await rename(prepared.directory, directory);
    }
    if (!prepared.pending) helper = path.join(directory, "Compet Updater.exe");
    args = [...(finish ? ["--finish-server"] : prepared.pending ? ["--recover"] : []), "--plan", path.join(directory, "plan.txt"), "--pid", String(process.pid)];
  }
  const child = spawn(helper, args,
    { detached: true, windowsHide: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
