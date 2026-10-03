import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPlainPath, fingerprintFile, isProtectedProgramPath, saveInstalledInventory,
  validatePackageInventory, type PackageFile, type PackageInventory } from "../src/desktop/main/serverManagedFiles.js";

async function scanPackage(root: string, version: string): Promise<PackageInventory> {
  await assertPlainPath(root);
  const identity = JSON.parse((await readFile(path.join(root, "runtime/electron/resources/app/package.json"), "utf8")).replace(/^\uFEFF/, "")) as { name?: unknown; version?: unknown };
  if (identity.name !== "compet-server-manager" || identity.version !== version) throw new Error("package_identity_invalid");
  const files: PackageFile[] = [];
  async function visit(directory: string): Promise<void> {
    await assertPlainPath(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === "compet-package-manifest.json") continue;
      if (isProtectedProgramPath(relative)) throw new Error("package_contains_runtime_data: " + relative);
      await assertPlainPath(absolute);
      if (entry.isDirectory()) await visit(absolute);
      else {
        const fingerprint = await fingerprintFile(absolute);
        if (!fingerprint) throw new Error("package_file_disappeared");
        files.push({ path: relative, ...fingerprint });
      }
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return validatePackageInventory({ schemaVersion: 1, appId: "compet-server-manager", version, files });
}

export async function createPackageInventory(root: string, version: string): Promise<PackageInventory> {
  const inventory = await scanPackage(root, version);
  await saveInstalledInventory(path.join(root, "compet-package-manifest.json"), inventory);
  return inventory;
}

export async function verifyPackageInventory(root: string, version: string): Promise<void> {
  const recorded = validatePackageInventory(JSON.parse(await readFile(path.join(root, "compet-package-manifest.json"), "utf8")));
  const actual = await scanPackage(root, version);
  const normalize = (inventory: PackageInventory) => JSON.stringify({ ...inventory,
    files: [...inventory.files].sort((a, b) => a.path.localeCompare(b.path, "en")) });
  if (normalize(recorded) !== normalize(actual)) throw new Error("package_inventory_mismatch");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, root, version] = process.argv.slice(2);
  if (!root || !version || !["create", "verify"].includes(mode ?? "")) throw new Error("Usage: create-package-inventory.ts create|verify root version");
  if (mode === "create") await createPackageInventory(path.resolve(root), version);
  else await verifyPackageInventory(path.resolve(root), version);
}
