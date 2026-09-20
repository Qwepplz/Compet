import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { app } from "electron";
import { getInstallRoot } from "./installLayout.js";
import type { IntegrityProgress, IntegrityReport, UpdateCheckResult, UpdateInstallResult } from "../updateTypes.js";

export type { UpdateCheckResult, UpdateInstallResult };

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

type CodedUpdateError = Error & { code: string };

function updateError(code: string, message: string, ErrorType: ErrorConstructor = Error): CodedUpdateError {
  const error = new ErrorType(message) as CodedUpdateError;
  error.code = code;
  return error;
}

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const latestUrls: Record<string, string> = {
  "compet-player-client": "https://qwepplz111.site/update/client/latest.json",
  "compet-server-manager": "https://qwepplz111.site/update/server/latest.json",
};

export async function checkForUpdates(appId: string, timeoutMs?: number): Promise<UpdateCheckResult> {
  const loaded = await loadUpdate(appId, timeoutMs);
  const updateAvailable = compareSemver(loaded.latestVersion, loaded.currentVersion) > 0;
  if (timeoutMs !== undefined) {
    return {
      currentVersion: loaded.currentVersion,
      latestVersion: loaded.latestVersion,
      updateAvailable,
      changedFiles: 0,
      changedBytes: 0,
      manifestUrl: loaded.manifestUrl,
    };
  }

  const changed = await listChangedFiles(loaded.files);
  return {
    currentVersion: loaded.currentVersion,
    latestVersion: loaded.latestVersion,
    updateAvailable,
    changedFiles: changed.files.length,
    changedBytes: changed.bytes,
    manifestUrl: loaded.manifestUrl,
  };
}

let installing = false;
let integrityTask: Promise<IntegrityReport> | undefined;

export async function installUpdate(appId: string, exeName: string): Promise<UpdateInstallResult> {
  if (installing || integrityTask) throw updateError("update_busy", "Installation verification or update is running");
  installing = true;
  let launched = false;
  try {
    const result = await performInstallUpdate(appId, exeName);
    launched = result.installing;
    return result;
  } finally {
    if (!launched) installing = false;
  }
}

async function performInstallUpdate(appId: string, exeName: string): Promise<UpdateInstallResult> {
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
      throw updateError("update_file_hash_mismatch", `Update file hash verification failed: ${file.path}`);
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

async function loadUpdate(appId: string, timeoutMs?: number): Promise<LoadedUpdate> {
  const latestUrl = latestUrls[appId];
  if (!latestUrl) throw updateError("update_source_unknown", "Unknown update source");

  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw updateError("update_timeout_invalid", "timeoutMs must be a finite positive number", RangeError);
  }

  const currentVersion = app.getVersion();
  const controller = timeoutMs === undefined ? undefined : new AbortController();
  const signal = controller?.signal;
  const deadlineTimer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        controller?.abort();
      }, timeoutMs);

  try {
    const latest = await fetchJson<LatestPayload>(latestUrl, signal);
    if (signal?.aborted) throw updateError("update_check_timeout", "Update check aborted");
    if (typeof latest.version !== "string" || !isSemver(latest.version)) throw updateError("update_version_invalid", "Invalid update version");
    if (typeof latest.manifestUrl !== "string") throw updateError("update_manifest_url_invalid", "Invalid update manifest URL");
    const manifestUrl = new URL(latest.manifestUrl, latestUrl).toString();
    ensureSameOrigin(latestUrl, manifestUrl);

    if (compareSemver(latest.version, currentVersion) <= 0) {
      return { currentVersion, latestVersion: latest.version, manifestUrl, files: [] };
    }

    const manifest = await fetchJson<ManifestPayload>(manifestUrl, signal);
    if (signal?.aborted) throw updateError("update_check_timeout", "Update check aborted");
    if (manifest.appId !== appId) throw updateError("update_manifest_app_mismatch", "Update manifest does not target this application");
    if (manifest.version !== latest.version) throw updateError("update_manifest_version_mismatch", "Update version does not match manifest");
    if (manifest.platform !== "win32-x64") throw updateError("update_manifest_platform_mismatch", "Update manifest does not target this platform");
    if (!Array.isArray(manifest.files)) throw updateError("update_manifest_files_invalid", "Invalid update file list");
    return { currentVersion, latestVersion: latest.version, manifestUrl, files: manifest.files.map(parseManifestFile) };
  } catch (error) {
    if (signal?.aborted) throw updateError("update_check_timeout", "Update check aborted");
    throw error;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

async function listChangedFiles(files: ManifestFile[]): Promise<{ files: ManifestFile[]; bytes: number }> {
  const installRoot = getInstallRoot();
  const changed = [];
  let bytes = 0;
  for (const file of files) {
    const absolutePath = path.resolve(installRoot, file.path);
    if (!absolutePath.startsWith(installRoot + path.sep)) throw updateError("update_manifest_path_invalid", "Update manifest contains an invalid path");
    if (!(await hasSameFileHash(absolutePath, file.sha256, file.size))) {
      changed.push(file);
      bytes += file.size;
    }
  }
  return { files: changed, bytes };
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    redirect: "error",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw updateError("update_server_error", `Update server returned ${response.status}`);
  return (await response.json()) as T;
}

async function downloadFile(url: string, filePath: string): Promise<void> {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw updateError("update_download_failed", `Failed to download update file: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, data);
}

function ensureSameOrigin(baseUrl: string, nextUrl: string): void {
  const base = new URL(baseUrl);
  const next = new URL(nextUrl);
  if (base.origin !== next.origin) throw updateError("update_manifest_origin_invalid", "Update manifest URL must use the update source origin");
}

function parseManifestFile(value: unknown): ManifestFile {
  const file = value as Partial<ManifestFile>;
  if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string" || typeof file.size !== "number" || typeof file.url !== "string") {
    throw updateError("update_manifest_file_invalid", "Invalid update file entry");
  }
  const normalizedPath = file.path.replaceAll("\\", "/");
  if (path.isAbsolute(normalizedPath) || normalizedPath.split("/").some((part) => !part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || !/^[a-f0-9]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) {
    throw updateError("update_manifest_path_or_hash_invalid", "Invalid update file entry path or hash");
  }
  if (file.url.includes("..") || file.url.startsWith("/") || /^[a-z]+:/i.test(file.url)) {
    throw updateError("update_file_url_invalid", "Invalid update file URL");
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
  if (!left || !right) throw updateError("update_version_invalid", "Invalid version");
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

const integrityListeners = new Set<(progress: IntegrityProgress) => void>();

export async function verifyClientIntegrity(onProgress?: (progress: IntegrityProgress) => void): Promise<IntegrityReport> {
  if (onProgress) integrityListeners.add(onProgress);
  try {
    if (!integrityTask) {
      const task = performIntegrityCheck();
      integrityTask = task;
      void task.finally(() => { if (integrityTask === task) integrityTask = undefined; });
    }
    return await integrityTask;
  } finally {
    if (onProgress) integrityListeners.delete(onProgress);
  }
}

async function performIntegrityCheck(): Promise<IntegrityReport> {
  const version = app.getVersion();
  const report: IntegrityReport = { version, checkedFiles: 0, totalFiles: 0, status: "unavailable", issues: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    if (installing) throw updateError("update_busy", "Update is running");
    if (!app.isPackaged || !isSemver(version)) throw updateError("integrity_unavailable", "Integrity verification requires an installed release");
    const manifestUrl = new URL("releases/" + encodeURIComponent(version) + "/manifest.json", latestUrls["compet-player-client"]).toString();
    ensureSameOrigin(latestUrls["compet-player-client"]!, manifestUrl);
    const manifest = await fetchJson<ManifestPayload>(manifestUrl, controller.signal);
    if (manifest.appId !== "compet-player-client" || manifest.version !== version || manifest.platform !== "win32-x64") throw updateError("integrity_manifest_mismatch", "Manifest does not match this installation");

    if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw updateError("integrity_manifest_invalid", "Manifest has no managed files");
    const files = manifest.files.map(parseManifestFile);
    const paths = new Set<string>();
    for (const file of files) {
      ensureSameOrigin(manifestUrl, new URL(file.url, manifestUrl).toString());
      const key = file.path.toLowerCase();
      if (paths.has(key)) throw updateError("integrity_manifest_invalid", "Manifest has duplicate paths");
      paths.add(key);
    }
    const root = await realpath(getInstallRoot());
    report.totalFiles = files.length;
    let lastProgressAt = 0;
    const publish = () => {
      if (report.checkedFiles !== report.totalFiles && Date.now() - lastProgressAt < 100) return;
      lastProgressAt = Date.now();
      for (const listener of integrityListeners) listener({ version, checkedFiles: report.checkedFiles, totalFiles: report.totalFiles });
    };
    publish();
    for (const file of files) {
      let target: string;
      try { target = await realpath(path.resolve(root, file.path)); }
      catch (error) {
        report.issues.push({ path: file.path, kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "read_failed" });
        report.checkedFiles++;
        publish();
        continue;
      }
      const relative = path.relative(root, target);
      if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw updateError("integrity_path_outside", "Managed file resolves outside the installation");

      try {
        const info = await stat(target);
        if (!info.isFile()) report.issues.push({ path: file.path, kind: "read_failed" });
        else if (info.size !== file.size) report.issues.push({ path: file.path, kind: "size_mismatch" });
        else if (await hashFile(target) !== file.sha256) report.issues.push({ path: file.path, kind: "hash_mismatch" });
      } catch {
        report.issues.push({ path: file.path, kind: "read_failed" });
      }
      report.checkedFiles++;
      publish();
    }
    const installed = JSON.parse(await readFile(path.join(app.getAppPath(), "package.json"), "utf8")) as { version?: unknown };
    if (app.getVersion() !== version || installed.version !== version) throw updateError("integrity_version_changed", "Installation version changed during verification");
    report.status = report.issues.some((issue) => issue.kind === "read_failed") ? "unavailable" : report.issues.length ? "issues" : "passed";
  } catch (error) {
    report.error = controller.signal.aborted ? "integrity_timeout" : (error as Partial<CodedUpdateError>).code ?? "integrity_failed";
  } finally {
    clearTimeout(timer);
  }
  return report;
}
