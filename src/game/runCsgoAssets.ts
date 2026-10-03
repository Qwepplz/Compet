import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertPlainPath, fingerprintFile, listUnmanagedProgramPaths, validatePackageInventory, type PackageFile, type PackageInventory } from "../desktop/main/serverManagedFiles.js";
import { beginRunCsgoAssets, type AssetInstallInput, type RunCsgoAssetTransaction } from "./runCsgoAssetState.js";
export interface RunCsgoSource { root: string; files: PackageFile[]; version: string }

export function resolveRunCsgoSource(input: { appRoot: string; developmentRoot?: string; inventory: PackageInventory }): RunCsgoSource {
  const inventory = validatePackageInventory(input.inventory);
  if (!path.isAbsolute(input.appRoot) || (input.developmentRoot && !path.isAbsolute(input.developmentRoot))) throw new Error("asset_source_invalid");
  const prefix = "runtime/electron/resources/app/run_csgo/";
  const files = inventory.files.filter(file => file.path.startsWith(prefix)).map(file => ({ ...file, path: file.path.slice(prefix.length) }));
  if (!files.length) throw new Error("asset_source_empty");
  return { root: input.developmentRoot ?? path.join(input.appRoot, "run_csgo"), files, version: inventory.version };
}
export async function loadRunCsgoSource(input: { appRoot: string; developmentRoot?: string }): Promise<RunCsgoSource> {
  let inventory: PackageInventory;
  const prefix = "runtime/electron/resources/app/run_csgo/";
  if (input.developmentRoot) {
    const files: PackageFile[] = [];
    async function visit(directory: string): Promise<void> {
      await assertPlainPath(directory);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        await assertPlainPath(absolute);
        if (entry.isDirectory()) await visit(absolute);
        else {
          const fingerprint = await fingerprintFile(absolute);
          if (!fingerprint) throw new Error("asset_source_invalid");
          files.push({ path: prefix + path.relative(input.developmentRoot!, absolute).split(path.sep).join("/"), ...fingerprint });
        }
      }
    }
    await visit(input.developmentRoot);
    const identity = JSON.parse(await readFile(path.join(input.appRoot, "packaging/server/app-package.json"), "utf8")) as { version: string };
    inventory = validatePackageInventory({ schemaVersion: 1, appId: "compet-server-manager", version: identity.version, files });
  } else {
    const installRoot = path.resolve(input.appRoot, "../../../..");
    await assertPlainPath(input.appRoot);
    const identity = JSON.parse((await readFile(path.join(input.appRoot, "package.json"), "utf8")).replace(/^\uFEFF/, "")) as { name?: unknown; version?: unknown };
    inventory = validatePackageInventory(JSON.parse(await readFile(path.join(installRoot, "compet-package-manifest.json"), "utf8")));
    if (identity.name !== inventory.appId || identity.version !== inventory.version) throw new Error("asset_package_identity_invalid");
  }
  const source = resolveRunCsgoSource({ ...input, inventory });
  if (!input.developmentRoot) {
    const unknown = await listUnmanagedProgramPaths(source.root, source.files, []);
    if (unknown.length) console.warn("Unmanaged run_csgo source paths preserved and excluded:", unknown);
  }
  return source;
}
export function installRunCsgoAssets(input: AssetInstallInput): Promise<RunCsgoAssetTransaction> {
  return beginRunCsgoAssets(input);
}
