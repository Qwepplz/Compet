import { chmod, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPlainPath, fingerprintFile } from "../src/desktop/main/serverManagedFiles.js";
import { writeDurableJson } from "../src/update/serverTransaction.js";
import { validateServerInventory } from "../src/update/serverRelease.js";
import type { ServerPlatform } from "../src/shared/serverPackageLayout.js";
import { isSemver } from "../src/shared/version.js";
import type { ServerPackageFile, ServerPackageInventory } from "../src/update/serverUpdateTypes.js";

async function scanPackage(root: string, version: string, platform: ServerPlatform): Promise<ServerPackageInventory> {
  await assertPlainPath(root);
  const appRoot = platform === "win32-x64" ? path.join(root, "runtime/electron/resources/app") : root;
  const identity = JSON.parse((await readFile(path.join(appRoot, "package.json"), "utf8")).replace(/^\uFEFF/, "")) as Record<string, unknown>;
  if (identity.name !== "compet-server-manager" || identity.version !== version || typeof identity.requiredClientVersion !== "string" || !isSemver(identity.requiredClientVersion)) throw new Error("package_identity_invalid");
  const files: ServerPackageFile[] = [];
  async function visit(directory: string): Promise<void> {
    await assertPlainPath(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name), relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === "compet-package-manifest.json") continue;
      const key = relative.toLowerCase();
      if (relative.split("/").some(part => [".git", "server-data", "user-data"].includes(part.toLowerCase())) || /(?:^|\/)(?:recent-maps|manager-config)\.json$/.test(key)) throw new Error("package_contains_runtime_data: " + relative);
      await assertPlainPath(absolute);
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (!entry.isFile()) throw new Error("package_file_invalid");
      const fingerprint = await fingerprintFile(absolute);
      if (!fingerprint) throw new Error("package_file_disappeared");
      const bytes = await readFile(absolute);
      const elf = bytes.subarray(0, 4).equals(Buffer.from([127,69,76,70])), pe = bytes.subarray(0, 2).toString() === "MZ";
      if (platform === "win32-x64" ? elf || /(?:^|\/)node-pty(?:\/|$)/.test(key) || /\.sh$/.test(key)
        : pe || /\.exe$|\.dll$|(?:^|\/)electron(?:\/|$)|win32-|\.ps1$|\.cmd$/.test(key)) throw new Error("package_foreign_platform_file: " + relative);
      const mode = (await stat(absolute)).mode & 0o7777;
      files.push({ path: relative, ...fingerprint, ...(platform === "linux-x64" ? { mode: mode & 0o111 || /^(bin\/compet|runtime\/node\/bin\/node)$|\.(?:sh|node|so(?:\.[0-9.]+)?)$/.test(relative) ? 0o755 : 0o644 } : {}) });
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return validateServerInventory({ schemaVersion: 1, appId: "compet-server-manager", version, platform, files }, platform);
}
export async function createPackageInventory(root: string, version: string, platform: ServerPlatform = "win32-x64"): Promise<ServerPackageInventory> {
  const inventory = await scanPackage(root, version, platform);
  await writeDurableJson(path.join(root, "compet-package-manifest.json"), inventory);
  if (platform === "linux-x64" && process.platform === "linux") await chmod(path.join(root, "compet-package-manifest.json"), 0o644);
  return inventory;
}
export async function verifyPackageInventory(root: string, version: string, platform: ServerPlatform = "win32-x64"): Promise<void> {
  const recorded = validateServerInventory(JSON.parse(await readFile(path.join(root, "compet-package-manifest.json"), "utf8")), platform);
  const actual = await scanPackage(root, version, platform);
  if (JSON.stringify(recorded) !== JSON.stringify(actual)) throw new Error("package_inventory_mismatch");
  if (platform === "linux-x64" && process.platform === "linux") for (const file of actual.files) {
    if (((await stat(path.join(root, file.path))).mode & 0o7777) !== file.mode) throw new Error("package_mode_mismatch");
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, root, version, platform = "win32-x64"] = process.argv.slice(2);
  if (!root || !version || !["create", "verify"].includes(mode ?? "") || !["win32-x64", "linux-x64"].includes(platform)) throw new Error("Usage: create-package-inventory.ts create|verify root version [platform]");
  if (mode === "create") await createPackageInventory(path.resolve(root), version, platform as ServerPlatform);
  else await verifyPackageInventory(path.resolve(root), version, platform as ServerPlatform);
}
