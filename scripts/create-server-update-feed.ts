import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { assertPlainPath } from "../src/desktop/main/serverManagedFiles.js";
import { writeDurableJson } from "../src/update/serverTransaction.js";
import { validateServerInventory } from "../src/update/serverRelease.js";
import { verifyPackageInventory } from "./create-package-inventory.js";
import type { ServerPlatform } from "../src/shared/serverPackageLayout.js";

export async function createServerUpdateFeed(input: { packageRoot: string; outputRoot: string; platform: ServerPlatform; version: string; baseUrl: string }): Promise<void> {
  const { packageRoot, outputRoot, platform, version } = input;
  const base = new URL(input.baseUrl.endsWith("/") ? input.baseUrl : input.baseUrl + "/");
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("update_base_url_invalid");
  await verifyPackageInventory(packageRoot, version, platform);
  const inventory = validateServerInventory(JSON.parse(await fs.readFile(path.join(packageRoot, "compet-package-manifest.json"), "utf8")), platform);
  // The package manifest is transferred too, but cannot recursively fingerprint itself.
  const { fingerprintFile } = await import("../src/desktop/main/serverManagedFiles.js");
  const manifestFingerprint = await fingerprintFile(path.join(packageRoot, "compet-package-manifest.json"));
  if (!manifestFingerprint) throw new Error("package_inventory_missing");
  const files = [...inventory.files, { path: "compet-package-manifest.json", ...manifestFingerprint, ...(platform === "linux-x64" ? { mode: 0o644 } : {}) }]
    .map(file => ({ ...file, url: "files/" + file.sha256.toLowerCase() }));
  await assertPlainPath(outputRoot);
  const releases = path.join(outputRoot, platform, "releases"), release = path.join(releases, version);
  await assertPlainPath(release);
  const manifest = { appId: "compet-server-manager", version, platform, files };
  const bytes = JSON.stringify(manifest);
  const existing = await fs.readFile(path.join(release, "manifest.json"), "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing !== null && JSON.stringify(JSON.parse(existing)) !== bytes) throw new Error("update_version_already_published_with_different_bytes");
  if (existing === null) {
    await fs.mkdir(releases, { recursive: true });
    const temporary = path.join(releases, "." + version + "-" + randomUUID());
    await fs.mkdir(path.join(temporary, "files"), { recursive: true });
    try {
      for (const file of files) {
        const source = path.join(packageRoot, file.path), target = path.join(temporary, file.url);
        await assertPlainPath(source);
        await fs.copyFile(source, target);
        if (platform === "linux-x64") await fs.chmod(target, file.mode!);
        const copied = await fingerprintFile(target);
        if (copied?.sha256 !== file.sha256 || copied.size !== file.size) throw new Error("update_feed_copy_mismatch");
      }
      await writeDurableJson(path.join(temporary, "manifest.json"), manifest);
      await fs.rename(temporary, release);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  const latest = { channel: "stable", version, manifestUrl: new URL(platform + "/releases/" + version + "/manifest.json", base).toString(), publishedAt: new Date().toISOString() };
  await writeDurableJson(path.join(outputRoot, platform, "latest.json"), latest);
  // Old Windows Managers read this address; a Linux build must never replace it.
  if (platform === "win32-x64") await writeDurableJson(path.join(outputRoot, "latest.json"), latest);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [packageRoot, outputRoot, platform, version, baseUrl] = process.argv.slice(2);
  if (!packageRoot || !outputRoot || !version || !baseUrl || !["win32-x64", "linux-x64"].includes(platform ?? "")) throw new Error("Usage: create-server-update-feed.ts packageRoot outputRoot platform version baseUrl");
  await createServerUpdateFeed({ packageRoot: path.resolve(packageRoot), outputRoot: path.resolve(outputRoot), platform: platform as ServerPlatform, version, baseUrl });
}
