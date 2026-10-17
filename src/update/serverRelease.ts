import path from "node:path";
import fs from "node:fs/promises";
import { assertPlainPath, assertServerProgramRelativePath, fingerprintFile, sameFingerprint } from "../desktop/main/serverManagedFiles.js";
import { ensureSameOrigin, downloadFile, fetchUpdateResponse } from "../shared/updateTransport.js";
import { isSemver } from "../shared/version.js";
import type { ServerPlatform } from "../shared/serverPackageLayout.js";
import { strictObject, assertFingerprint, updateFailure, type ServerPackageFile, type ServerPackageInventory } from "./serverUpdateTypes.js";

export function validateServerFile(raw: unknown, platform: ServerPlatform): ServerPackageFile {
  const value = strictObject(raw, ["path", "size", "sha256", ...(platform === "linux-x64" ? ["mode"] : [])]);
  if (typeof value.path !== "string") updateFailure("update_manifest_file_invalid");
  assertServerProgramRelativePath(value.path);
  assertFingerprint(value);
  if (platform === "linux-x64" && (value.mode !== 0o644 && value.mode !== 0o755 ||
      /^(bin\/compet|runtime\/node\/bin\/node)$|\.(?:sh|node|so(?:\.[0-9.]+)?)$/.test(value.path) && value.mode !== 0o755)) updateFailure("update_manifest_mode_invalid");
  return { path: value.path, size: Number(value.size), sha256: String(value.sha256).toUpperCase(),
    ...(platform === "linux-x64" ? { mode: Number(value.mode) } : {}) };
}

export function assertUniqueServerFiles(files: ServerPackageFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) updateFailure("update_manifest_path_conflict");
    seen.add(key);
  }
  for (const key of seen) {
    const parts = key.split("/");
    for (let n = 1; n < parts.length; n++) if (seen.has(parts.slice(0, n).join("/"))) updateFailure("update_manifest_path_conflict");
  }
}

export function validateServerInventory(raw: unknown, platform: ServerPlatform): ServerPackageInventory {
  const value = strictObject(raw, ["schemaVersion", "appId", "version", "platform", "files"]);
  if (value.platform !== platform) updateFailure("update_manifest_platform_mismatch");
  if (!["win32-x64", "linux-x64"].includes(platform) || value.schemaVersion !== 1 || value.appId !== "compet-server-manager" ||
      typeof value.version !== "string" || !isSemver(value.version) || !Array.isArray(value.files) || !value.files.length) updateFailure("update_manifest_invalid");
  const files = value.files.map(file => validateServerFile(file, platform));
  assertUniqueServerFiles(files);
  if (files.some(file => file.path.toLowerCase() === "compet-package-manifest.json")) updateFailure("update_manifest_invalid");
  return { schemaVersion: 1, appId: "compet-server-manager", platform, version: value.version, files };
}

export async function verifyServerFile(absolute: string, file: ServerPackageFile, platform: ServerPlatform): Promise<void> {
  validateServerFile(file, platform);
  await assertPlainPath(absolute);
  if (!sameFingerprint(await fingerprintFile(absolute), file)) updateFailure("update_file_hash_mismatch");
  if (platform === "linux-x64") {
    const info = await fs.lstat(absolute);
    if ((info.mode & 0o7777) !== file.mode) updateFailure("update_manifest_mode_invalid");
    const handle = await fs.open(absolute, "r");
    try {
      const magic = Buffer.alloc(4);
      const { bytesRead } = await handle.read(magic, 0, 4, 0);
      if (bytesRead === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && file.mode !== 0o755) updateFailure("update_manifest_mode_invalid");
    } finally { await handle.close(); }
  }
}

export interface ServerRelease {
  version: string;
  platform: ServerPlatform;
  manifestUrl: string;
  files: Array<ServerPackageFile & { url: string }>;
  download(file: ServerPackageFile, destination: string, signal?: AbortSignal): Promise<void>;
}

async function strictJson(url: string, signal: AbortSignal): Promise<unknown> {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) updateFailure("update_manifest_url_invalid");
  const response = await fetchUpdateResponse(url, signal);
  // Release metadata is bounded separately from large streamed payloads.
  const reader = response.body?.getReader();
  if (!reader) updateFailure("update_manifest_invalid");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 32 * 1024 * 1024) updateFailure("update_manifest_invalid");
      parts.push(item.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
  } catch { await reader.cancel().catch(() => {}); updateFailure("update_manifest_invalid"); }
}

export async function loadServerRelease(input: {
  platform: ServerPlatform; currentVersion: string; action: "check" | "apply" | "repair"; sourceRoot?: string; signal?: AbortSignal;
}): Promise<ServerRelease> {
  if (!["win32-x64", "linux-x64"].includes(input.platform) || !isSemver(input.currentVersion) ||
      !["check", "apply", "repair"].includes(input.action)) updateFailure("update_source_invalid");
  const source = new URL(input.platform + "/", input.sourceRoot ?? "https://qwepplz111.site/update/server/").toString();
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  let version = input.currentVersion;
  let manifestUrl = new URL("releases/" + version + "/manifest.json", source).toString();
  if (input.action !== "repair") {
    const latestUrl = new URL("latest.json", source).toString();
    const latest = strictObject(await strictJson(latestUrl, signal), ["version", "manifestUrl"], ["channel", "publishedAt"]);
    if (typeof latest.version !== "string" || !isSemver(latest.version) || typeof latest.manifestUrl !== "string" ||
        "channel" in latest && latest.channel !== "stable" || "publishedAt" in latest && (typeof latest.publishedAt !== "string" || !Number.isFinite(Date.parse(latest.publishedAt)))) updateFailure("update_version_invalid");
    version = latest.version;
    manifestUrl = new URL(latest.manifestUrl, latestUrl).toString();
    ensureSameOrigin(source, manifestUrl);
  }
  const manifest = strictObject(await strictJson(manifestUrl, signal), ["appId", "version", "platform", "files"], ["baseUrl"]);
  if (manifest.appId !== "compet-server-manager") updateFailure("update_manifest_app_mismatch");
  if (manifest.version !== version) updateFailure("update_manifest_version_mismatch");
  if (manifest.platform !== input.platform) updateFailure("update_manifest_platform_mismatch");
  if (!Array.isArray(manifest.files) || !manifest.files.length) updateFailure("update_manifest_files_invalid");
  if ("baseUrl" in manifest) {
    if (typeof manifest.baseUrl !== "string") updateFailure("update_manifest_url_invalid");
    ensureSameOrigin(manifestUrl, new URL(manifest.baseUrl, manifestUrl).toString());
  }
  const files = manifest.files.map(raw => {
    const entry = strictObject(raw, ["path", "size", "sha256", "url", ...(input.platform === "linux-x64" ? ["mode"] : [])]);
    const { url, ...fingerprint } = entry;
    const file = validateServerFile(fingerprint, input.platform);
    if (typeof url !== "string" || url !== "files/" + file.sha256.toLowerCase()) updateFailure("update_file_url_invalid");
    ensureSameOrigin(manifestUrl, new URL(url, manifestUrl).toString());
    return { ...file, url };
  });
  assertUniqueServerFiles(files);
  return { version, platform: input.platform, manifestUrl, files,
    async download(file, destination, downloadSignal) {
      const entry = files.find(candidate => candidate.path === file.path && candidate.size === file.size && candidate.sha256 === file.sha256 && candidate.mode === file.mode);
      if (!entry || !path.isAbsolute(destination)) updateFailure("update_manifest_file_invalid");
      await downloadFile(new URL(entry.url, manifestUrl).toString(), destination, entry.sha256, entry.size, downloadSignal);
    } };
}
