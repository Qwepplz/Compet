import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  changedFiles: number;
  changedBytes: number;
  manifestUrl: string;
}

interface LatestPayload {
  version?: unknown;
  manifestUrl?: unknown;
}

interface ManifestPayload {
  appId?: unknown;
  version?: unknown;
  platform?: unknown;
  files?: unknown;
}

interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export async function checkForUpdates(appId: string, latestUrl: string): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const latest = await fetchJson<LatestPayload>(latestUrl);
  if (typeof latest.version !== "string" || !isSemver(latest.version)) throw new Error("更新版本号无效");
  if (typeof latest.manifestUrl !== "string") throw new Error("更新清单地址无效");
  const manifestUrl = new URL(latest.manifestUrl, latestUrl).toString();
  ensureSameOrigin(latestUrl, manifestUrl);

  const updateAvailable = compareSemver(latest.version, currentVersion) > 0;
  if (!updateAvailable) {
    return { currentVersion, latestVersion: latest.version, updateAvailable: false, changedFiles: 0, changedBytes: 0, manifestUrl };
  }

  const manifest = await fetchJson<ManifestPayload>(manifestUrl);
  if (manifest.appId !== appId) throw new Error("更新清单不适用于当前程序");
  if (manifest.version !== latest.version) throw new Error("更新版本与清单不一致");
  if (manifest.platform !== "win32-x64") throw new Error("更新清单不适用于当前平台");
  if (!Array.isArray(manifest.files)) throw new Error("更新文件列表无效");

  const files = manifest.files.map(parseManifestFile);
  const appRoot = path.resolve(app.getAppPath(), "..", "..");
  let changedFiles = 0;
  let changedBytes = 0;
  for (const file of files) {
    const absolutePath = path.resolve(appRoot, file.path);
    if (!absolutePath.startsWith(appRoot + path.sep)) throw new Error("更新清单包含非法路径");
    if (!(await hasSameFileHash(absolutePath, file.sha256, file.size))) {
      changedFiles += 1;
      changedBytes += file.size;
    }
  }

  return { currentVersion, latestVersion: latest.version, updateAvailable: true, changedFiles, changedBytes, manifestUrl };
}

export function getCurrentVersion(): string {
  return app.getVersion();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`更新服务器返回 ${response.status}`);
  return (await response.json()) as T;
}

function ensureSameOrigin(baseUrl: string, nextUrl: string): void {
  const base = new URL(baseUrl);
  const next = new URL(nextUrl);
  if (base.origin !== next.origin) throw new Error("更新清单地址必须与更新源同域");
}

function parseManifestFile(value: unknown): ManifestFile {
  const file = value as Partial<ManifestFile>;
  if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string" || typeof file.size !== "number") {
    throw new Error("更新文件条目无效");
  }
  const normalizedPath = file.path.replaceAll("\\", "/");
  if (path.isAbsolute(normalizedPath) || normalizedPath.split("/").includes("..") || !/^[a-f0-9]{64}$/i.test(file.sha256) || file.size < 0) {
    throw new Error("更新文件条目非法");
  }
  return { path: normalizedPath, sha256: file.sha256.toUpperCase(), size: file.size };
}

async function hasSameFileHash(filePath: string, sha256: string, size: number): Promise<boolean> {
  try {
    await access(filePath);
    const info = await stat(filePath);
    if (info.size !== size) return false;
    return (await hashFile(filePath)) === sha256;
  } catch {
    return false;
  }
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

function isSemver(version: string): boolean {
  return semverPattern.test(version);
}

function compareSemver(a: string, b: string): number {
  const left = a.match(semverPattern);
  const right = b.match(semverPattern);
  if (!left || !right) throw new Error("版本号无效");
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}
