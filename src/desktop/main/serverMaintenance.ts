import { copyFile, lstat, mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { legacyRunCsgoFiles } from "../../game/legacyRunCsgoFiles.js";
import { spawn } from "node:child_process";
import { assertPlainPath, buildServerUpdatePlan, listUnmanagedProgramPaths, fingerprintFile, sameFingerprint, saveInstalledInventory,
  validatePackageInventory, type PackageFile, type PackageInventory, type FileFingerprint } from "./serverManagedFiles.js";
import { cleanupMaintenancePayload, clearMaintenanceStaging, clearMaintenanceTransaction, clearRetiredMaintenance,
  readMaintenanceJournal, readMaintenanceManifest, readMaintenancePlan, readMaintenanceTransaction,
  writeMaintenancePlan, writeMaintenanceTransaction, type ServerMaintenancePlan } from "./updateTransaction.js";

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
}
function failure(code: string): never { throw Object.assign(new Error(code), { code }); }
const inventoryName = "compet-package-manifest.json";
const installedPath = (appRoot: string) => path.join(appRoot, "user-data/server-installed-files.json");
const configPath = (appRoot: string) => path.join(appRoot, "user-data/manager-config.json");

async function readInventory(file: string): Promise<PackageInventory | null> {
  await assertPlainPath(file);
  try { return validatePackageInventory(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function protections(appRoot: string, config: ServerMaintenanceConfig): string[] {
  const values = [path.join(appRoot, "user-data"), path.join(appRoot, "server-data"), config.dataDir];
  if (config.serverRoot) values.push(config.serverRoot);
  if (values.some(value => !path.isAbsolute(value))) failure("maintenance_config_invalid");
  return [...new Set(values.map(value => path.resolve(value)))];
}
async function verifyInventory(root: string, inventory: PackageInventory, protectedPaths: string[]): Promise<void> {
  const result = await buildServerUpdatePlan({ root, current: inventory, target: inventory, protectedPaths });
  if (result.conflicts.length || result.operations.length) failure("maintenance_verification_failed");
  const identity = JSON.parse((await readFile(path.join(root, "runtime/electron/resources/app/package.json"), "utf8")).replace(/^\uFEFF/, "")) as { name?: unknown; version?: unknown };
  if (identity.name !== inventory.appId || identity.version !== inventory.version) failure("maintenance_identity_invalid");
}
export async function prepareServerMaintenance(input: {
  installRoot: string; appRoot: string; config: ServerMaintenanceConfig; target: ServerRelease;
}): Promise<PreparedServerMaintenance> {
  const { installRoot, appRoot, target } = input;
  if (path.resolve(installRoot, "runtime/electron/resources/app") !== appRoot) failure("maintenance_layout_invalid");
  await assertPlainPath(installRoot);
  const directory = path.join(installRoot, ".compet-maintenance-staging");
  try { await lstat(path.join(installRoot, ".compet-maintenance")); failure("update_transaction_pending"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await clearMaintenanceStaging(directory);
  const protectedPaths = protections(appRoot, input.config);
  const configFingerprint = await fingerprintFile(configPath(appRoot));
  const current = await readInventory(installedPath(appRoot));
  if (!current) failure("maintenance_inventory_missing");
  await mkdir(path.join(directory, "files"), { recursive: true });
  try {
    const inventoryFile = target.files.find(file => file.path === inventoryName);
    const helperFile = target.files.find(file => file.path === "runtime/updater/Compet Updater.exe");
    if (!inventoryFile || !helperFile) failure("maintenance_inventory_missing");
    const download = async (file: PackageFile) => {
      const destination = path.join(directory, "files", file.sha256);
      await target.download(file, destination);
      if (!sameFingerprint(await fingerprintFile(destination), file)) failure("maintenance_source_invalid");
      return destination;
    };
    const inventorySource = await download(inventoryFile);
    const inventory = validatePackageInventory(JSON.parse(await readFile(inventorySource, "utf8")));
    if (inventory.version !== target.version) failure("maintenance_inventory_mismatch");
    const outer = new Map(target.files.filter(file => file.path !== inventoryName).map(file => [file.path, file]));
    if (outer.size !== inventory.files.length || target.files.length !== inventory.files.length + 1 ||
        inventory.files.some(file => !sameFingerprint(outer.get(file.path) ?? null, file))) failure("maintenance_inventory_mismatch");
    const difference = await buildServerUpdatePlan({ root: installRoot, current, target: inventory, protectedPaths });
    if (difference.conflicts.length) failure(difference.conflicts[0]!.code);
    const packageBefore = await fingerprintFile(path.join(installRoot, inventoryName));
    const operations = [...difference.operations];
    if (!sameFingerprint(packageBefore, inventoryFile)) operations.push({ kind: "replace", path: inventoryName,
      source: "files/" + inventoryFile.sha256, size: inventoryFile.size, sha256: inventoryFile.sha256,
      ...(packageBefore ? { before: packageBefore } : {}) });
    const downloaded = new Set([inventoryFile.sha256]);
    for (const operation of operations) {
      if (operation.kind === "delete" || downloaded.has(operation.sha256)) continue;
      const file = target.files.find(file => file.path === operation.path)!;
      await download(file); downloaded.add(file.sha256);
    }
    if (!downloaded.has(helperFile.sha256)) await download(helperFile);
    const helper = path.join(directory, "Compet Updater.exe");
    await copyFile(path.join(directory, "files", helperFile.sha256), helper);
    const plan: ServerMaintenancePlan = { protocol: 3, root: installRoot, exe: "Compet Server Manager.exe",
      targetVersion: target.version, helper: { size: helperFile.size, sha256: helperFile.sha256 }, protectedPaths, operations };
    await writeMaintenancePlan(directory, plan, { inventory, previous: current });
    await target.preflight(helper, path.join(directory, "plan.txt"));
    if ((await readMaintenanceTransaction(directory))?.state !== "prepared") failure("maintenance_helper_invalid");
    return { installRoot, appRoot, directory, plan, inventory, configFingerprint };
  } catch (error) { await clearMaintenanceStaging(directory); throw error; }
}
async function startHelper(directory: string, recover: boolean, validate = false): Promise<void> {
  const plan = await readMaintenancePlan(directory);
  const helper = path.join(directory, "Compet Updater.exe");
  if (plan.protocol !== 3 || !sameFingerprint(await fingerprintFile(helper), plan.helper)) failure("maintenance_helper_invalid");
  const child = spawn(helper, [...(validate ? ["--validate-plan"] : recover ? ["--recover"] : []), "--plan", path.join(directory, "plan.txt"), "--pid", String(process.pid)],
    { detached: !validate, windowsHide: true, stdio: "ignore" });
  if (validate) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("maintenance_helper_timeout")); }, 30000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("maintenance_helper_invalid")); });
    });
    return;
  }
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
export async function handoffServerMaintenance(prepared: PreparedServerMaintenance): Promise<void> {
  if (!sameFingerprint(await fingerprintFile(configPath(prepared.appRoot)), prepared.configFingerprint)) failure("maintenance_config_changed");
  const actual = await readMaintenancePlan(prepared.directory);
  if (actual.protocol !== 3 || actual.root !== prepared.plan.root || actual.exe !== prepared.plan.exe ||
      actual.targetVersion !== prepared.plan.targetVersion || !sameFingerprint(actual.helper, prepared.plan.helper) ||
      JSON.stringify(actual.operations) !== JSON.stringify(prepared.plan.operations) ||
      JSON.stringify(actual.protectedPaths) !== JSON.stringify(prepared.plan.protectedPaths)) failure("maintenance_plan_changed");
  const directory = path.join(prepared.installRoot, ".compet-maintenance");
  await rename(prepared.directory, directory);
  await startHelper(directory, false);
}
export async function finalizeServerMaintenance(input: { installRoot: string; appRoot: string }): Promise<"ready" | "exit_requested" | "blocked"> {
  const { installRoot, appRoot } = input;
  const directory = path.join(installRoot, ".compet-maintenance");
  try {
    await assertPlainPath(installRoot);
    const transaction = await readMaintenanceTransaction(directory);
    if (transaction && transaction.protocol !== 3) return "blocked";
    if (transaction && !["applied", "verified", "rolled_back"].includes(transaction.state)) {
      await startHelper(directory, true); return "exit_requested";
    }
    if (transaction?.state === "rolled_back") {
      const evidence = await readMaintenanceManifest(directory) as { previous?: unknown; legacyCleanup?: boolean };
      if (evidence.legacyCleanup) return "blocked";
      const previous = validatePackageInventory(evidence.previous);
      const plan = await readMaintenancePlan(directory);
      await verifyInventory(installRoot, previous, plan.protectedPaths ?? []);
      await saveInstalledInventory(installedPath(appRoot), previous);
      await cleanupMaintenancePayload(directory);
      await clearMaintenanceTransaction(directory);
      return "ready";
    }
    let config: ServerMaintenanceConfig = { dataDir: path.join(appRoot, "server-data"), serverRoot: "" };
    if (await fingerprintFile(configPath(appRoot))) {
      const raw = JSON.parse(await readFile(configPath(appRoot), "utf8")) as Partial<ServerMaintenanceConfig>;
      if (typeof raw.dataDir !== "string" || typeof raw.serverRoot !== "string") failure("maintenance_config_invalid");
      config = { dataDir: raw.dataDir, serverRoot: raw.serverRoot };
    }
    const protectedPaths = protections(appRoot, config);
    const inventory = await readInventory(path.join(installRoot, inventoryName));
    if (!inventory) return "blocked";
    const installed = !transaction ? await readInventory(installedPath(appRoot)) : null;
    if (installed && JSON.stringify(installed) !== JSON.stringify(inventory)) failure("maintenance_inventory_mismatch");
    try {
      await verifyInventory(installRoot, inventory, protectedPaths);
      if (transaction) {
        const evidence = await readMaintenanceManifest(directory) as { inventory?: unknown };
        if (JSON.stringify(validatePackageInventory(evidence.inventory)) !== JSON.stringify(inventory)) failure("maintenance_inventory_mismatch");
        const plan = await readMaintenancePlan(directory);
        await readMaintenanceJournal(directory, true);
        for (const op of plan.operations ?? []) if (op.kind === "delete" && await fingerprintFile(path.join(installRoot, op.path))) failure("maintenance_obsolete_file_present");
      }
    } catch (error) {
      if (transaction?.state === "applied") { await startHelper(directory, true); return "exit_requested"; }
      throw error;
    }
    if (!transaction && !installed && await prepareLegacyCleanup(installRoot, inventory, protectedPaths)) return "exit_requested";
    if (!installed) {
      const unknown = await listUnmanagedProgramPaths(installRoot, inventory.files, protectedPaths);
      if (unknown.length) console.warn("Unmanaged installation paths preserved:", unknown);
    }
    await mkdir(path.dirname(installedPath(appRoot)), { recursive: true });
    await saveInstalledInventory(installedPath(appRoot), inventory);
    if (transaction) {
      await writeMaintenanceTransaction(directory, { ...transaction, state: "verified" });
      await cleanupMaintenancePayload(directory);
      await clearMaintenanceTransaction(directory);
    }
    await clearRetiredMaintenance(installRoot);
    return "ready";
  } catch (error) {
    console.error("Server maintenance blocked:", (error as { code?: string }).code ?? (error as Error).message);
    return "blocked";
  }
}

async function prepareLegacyCleanup(root: string, inventory: PackageInventory, protectedPaths: string[]): Promise<boolean> {
  const operations: ServerMaintenancePlan["operations"] = [];
  for (const legacy of legacyRunCsgoFiles) {
    const relative = "runtime/electron/resources/app/run_csgo/" + legacy.path;
    if (inventory.files.some(file => file.path.toLowerCase() === relative.toLowerCase())) continue;
    const actual = await fingerprintFile(path.join(root, relative));
    if (!actual) continue;
    if (actual.sha256 !== legacy.sha256) failure("maintenance_legacy_conflict");
    operations.push({ kind: "delete", path: relative, before: actual });
  }
  if (!operations.length) return false;
  const helper = inventory.files.find(file => file.path === "runtime/updater/Compet Updater.exe");
  if (!helper) failure("maintenance_helper_invalid");
  const staging = path.join(root, ".compet-maintenance-staging");
  await clearMaintenanceStaging(staging);
  await mkdir(staging);
  await copyFile(path.join(root, helper.path), path.join(staging, "Compet Updater.exe"));
  const plan: ServerMaintenancePlan = { protocol: 3, root, exe: "Compet Server Manager.exe",
    targetVersion: inventory.version, helper, protectedPaths, operations };
  await writeMaintenancePlan(staging, plan, { inventory, previous: inventory, legacyCleanup: true });
  await startHelper(staging, false, true);
  const directory = path.join(root, ".compet-maintenance");
  await rename(staging, directory);
  await startHelper(directory, false);
  return true;
}
