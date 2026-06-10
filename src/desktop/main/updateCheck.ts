import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { app } from "electron";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  changedFiles: number;
  changedBytes: number;
  manifestUrl: string;
}

export interface UpdateInstallResult extends UpdateCheckResult {
  installing: boolean;
}

interface LatestPayload {
  version?: unknown;
  manifestUrl?: unknown;
}

interface ManifestPayload {
  appId?: unknown;
  version?: unknown;
  platform?: unknown;
  baseUrl?: unknown;
  files?: unknown;
}

interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
  url: string;
}

interface LoadedUpdate {
  currentVersion: string;
  latestVersion: string;
  manifestUrl: string;
  files: ManifestFile[];
}

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const latestUrls: Record<string, string> = {
  "compet-player-client": "https://qwepplz111.site/update/client/latest.json",
  "compet-server-manager": "https://qwepplz111.site/update/server/latest.json",
};

export async function checkForUpdates(appId: string): Promise<UpdateCheckResult> {
  const loaded = await loadUpdate(appId);
  const changed = await listChangedFiles(loaded.files);
  return {
    currentVersion: loaded.currentVersion,
    latestVersion: loaded.latestVersion,
    updateAvailable: compareSemver(loaded.latestVersion, loaded.currentVersion) > 0,
    changedFiles: changed.files.length,
    changedBytes: changed.bytes,
    manifestUrl: loaded.manifestUrl,
  };
}

export async function installUpdate(appId: string, exeName: string): Promise<UpdateInstallResult> {
  const loaded = await loadUpdate(appId);
  if (compareSemver(loaded.latestVersion, loaded.currentVersion) <= 0) {
    return {
      currentVersion: loaded.currentVersion,
      latestVersion: loaded.latestVersion,
      updateAvailable: false,
      changedFiles: 0,
      changedBytes: 0,
      manifestUrl: loaded.manifestUrl,
      installing: false,
    };
  }

  const changed = await listChangedFiles(loaded.files);
  if (changed.files.length === 0) {
    return {
      currentVersion: loaded.currentVersion,
      latestVersion: loaded.latestVersion,
      updateAvailable: true,
      changedFiles: 0,
      changedBytes: 0,
      manifestUrl: loaded.manifestUrl,
      installing: false,
    };
  }

  const installRoot = getInstallRoot();
  const pendingRoot = path.join(app.getPath("userData"), "update-pending");
  const pendingFilesRoot = path.join(pendingRoot, "files");
  await rm(pendingRoot, { recursive: true, force: true });
  await mkdir(pendingFilesRoot, { recursive: true });

  const planFiles = [];
  for (const file of changed.files) {
    const source = path.join(pendingFilesRoot, file.sha256);
    const downloadUrl = new URL(file.url, loaded.manifestUrl).toString();
    ensureSameOrigin(loaded.manifestUrl, downloadUrl);
    await downloadFile(downloadUrl, source);
    if (!(await hasSameFileHash(source, file.sha256, file.size))) {
      throw new Error(`更新文件校验失败: ${file.path}`);
    }
    planFiles.push({ source, path: file.path });
  }

  const planPath = path.join(pendingRoot, "plan.txt");
  await writeFile(
    planPath,
    [`root=${installRoot}`, `exe=${exeName}`, ...planFiles.map((file) => `${file.source}\t${file.path}`)].join("\n"),
    "utf8",
  );

  const updaterPath = path.join(installRoot, "runtime", "updater", "Compet Updater.exe");
  await access(updaterPath);
  const pendingUpdaterPath = path.join(pendingRoot, "Compet Updater.exe");
  await copyFile(updaterPath, pendingUpdaterPath);

  const child = spawn(pendingUpdaterPath, ["--plan", planPath, "--pid", String(process.pid)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  app.quit();

  return {
    currentVersion: loaded.currentVersion,
    latestVersion: loaded.latestVersion,
    updateAvailable: true,
    changedFiles: changed.files.length,
    changedBytes: changed.bytes,
    manifestUrl: loaded.manifestUrl,
    installing: true,
  };
}

export function getCurrentVersion(): string {
  return app.getVersion();
}

async function loadUpdate(appId: string): Promise<LoadedUpdate> {
  const latestUrl = latestUrls[appId];
  if (!latestUrl) throw new Error("未知更新源");
  const currentVersion = app.getVersion();
  const latest = await fetchJson<LatestPayload>(latestUrl);
  if (typeof latest.version !== "string" || !isSemver(latest.version)) throw new Error("更新版本号无效");
  if (typeof latest.manifestUrl !== "string") throw new Error("更新清单地址无效");
  const manifestUrl = new URL(latest.manifestUrl, latestUrl).toString();
  ensureSameOrigin(latestUrl, manifestUrl);

  if (compareSemver(latest.version, currentVersion) <= 0) {
    return { currentVersion, latestVersion: latest.version, manifestUrl, files: [] };
  }

  const manifest = await fetchJson<ManifestPayload>(manifestUrl);
  if (manifest.appId !== appId) throw new Error("更新清单不适用于当前程序");
  if (manifest.version !== latest.version) throw new Error("更新版本与清单不一致");
  if (manifest.platform !== "win32-x64") throw new Error("更新清单不适用于当前平台");
  if (!Array.isArray(manifest.files)) throw new Error("更新文件列表无效");
  return { currentVersion, latestVersion: latest.version, manifestUrl, files: manifest.files.map(parseManifestFile) };
}

async function listChangedFiles(files: ManifestFile[]): Promise<{ files: ManifestFile[]; bytes: number }> {
  const installRoot = getInstallRoot();
  const changed = [];
  let bytes = 0;
  for (const file of files) {
    const absolutePath = path.resolve(installRoot, file.path);
    if (!absolutePath.startsWith(installRoot + path.sep)) throw new Error("更新清单包含非法路径");
    if (!(await hasSameFileHash(absolutePath, file.sha256, file.size))) {
      changed.push(file);
      bytes += file.size;
    }
  }
  return { files: changed, bytes };
}

function getInstallRoot(): string {
  return path.resolve(app.getAppPath(), "..", "..", "..", "..");
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`更新服务器返回 ${response.status}`);
  return (await response.json()) as T;
}

async function downloadFile(url: string, filePath: string): Promise<void> {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`下载更新文件失败 ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, data);
}

function ensureSameOrigin(baseUrl: string, nextUrl: string): void {
  const base = new URL(baseUrl);
  const next = new URL(nextUrl);
  if (base.origin !== next.origin) throw new Error("更新清单地址必须与更新源同域");
}

function parseManifestFile(value: unknown): ManifestFile {
  const file = value as Partial<ManifestFile>;
  if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string" || typeof file.size !== "number" || typeof file.url !== "string") {
    throw new Error("更新文件条目无效");
  }
  const normalizedPath = file.path.replaceAll("\\", "/");
  if (path.isAbsolute(normalizedPath) || normalizedPath.split("/").includes("..") || !/^[a-f0-9]{64}$/i.test(file.sha256) || file.size < 0) {
    throw new Error("更新文件条目非法");
  }
  if (file.url.includes("..") || file.url.startsWith("/") || /^[a-z]+:/i.test(file.url)) {
    throw new Error("更新文件地址非法");
  }
  return { path: normalizedPath, sha256: file.sha256.toUpperCase(), size: file.size, url: file.url };
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
