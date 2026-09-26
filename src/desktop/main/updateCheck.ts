import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { app } from "electron";
import { getInstallRoot, isInstalledClientLayout } from "./installLayout.js";
import { cleanupMaintenancePayload, clearMaintenanceReceipt, clearMaintenanceStaging, clearMaintenanceTransaction,
  clearRetiredMaintenance, readMaintenanceJournal, readMaintenanceManifest, readMaintenancePlan, readMaintenanceReceipt,
  readMaintenanceSummary, readMaintenanceTransaction, writeMaintenancePlan, writeMaintenanceReceipt,
  writeMaintenanceSummary, writeMaintenanceTransaction } from "./updateTransaction.js";
import type { MaintenancePlan, MaintenanceTransaction } from "./updateTransaction.js";
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
let integrityController: AbortController | undefined;
let maintenanceController: AbortController | undefined;
let maintenanceHandedOff = false;
let integritySnapshot: { release: Omit<LoadedUpdate, "currentVersion">; fingerprint: string } | undefined;

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
  if (appId === "compet-player-client") {
    const controller = new AbortController();
    maintenanceController = controller;
    maintenanceHandedOff = false;
    try {
      const report = await performIntegrityCheck(true, controller.signal);
      if (report.status === "unavailable" || report.error || !integritySnapshot) {
        throw updateError(report.error ?? "integrity_unavailable", "Unable to scan the client installation");
      }
      const release = integritySnapshot.release;
      const updateAvailable = report.action === "update";
      const result: UpdateInstallResult = {
        currentVersion: report.currentVersion,
        latestVersion: report.version,
        updateAvailable,
        changedFiles: report.changedFiles,
        changedBytes: report.changedBytes,
        manifestUrl: release.manifestUrl,
        installing: false,
      };
      if (!updateAvailable || report.changedFiles === 0) return result;
      await prepareClientMaintenance(release, report, controller.signal, exeName);
      return { ...result, installing: true };
    } finally {
      if (maintenanceController === controller) maintenanceController = undefined;
    }
  }
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
    await downloadFile(downloadUrl, source, file.sha256, file.size);
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

async function loadReleaseManifest(
  appId: string,
  signal?: AbortSignal,
  skipIfNotNewerThan?: string,
): Promise<Omit<LoadedUpdate, "currentVersion">> {
  const latestUrl = latestUrls[appId];
  if (!latestUrl) throw updateError("update_source_unknown", "Unknown update source");
  const latest = await fetchJson<LatestPayload>(latestUrl, signal);
  signal?.throwIfAborted();
  if (!latest || typeof latest !== "object" || Array.isArray(latest) ||
      typeof latest.version !== "string" || !isSemver(latest.version)) {
    throw updateError("update_version_invalid", "Invalid update version");
  }
  if (typeof latest.manifestUrl !== "string") {
    throw updateError("update_manifest_url_invalid", "Invalid update manifest URL");
  }
  let manifestUrl: string;
  try { manifestUrl = new URL(latest.manifestUrl, latestUrl).toString(); }
  catch { throw updateError("update_manifest_url_invalid", "Invalid update manifest URL"); }
  ensureSameOrigin(latestUrl, manifestUrl);
  if (skipIfNotNewerThan !== undefined && compareSemver(latest.version, skipIfNotNewerThan) <= 0) {
    return { latestVersion: latest.version, manifestUrl, files: [] };
  }

  const manifest = await fetchJson<ManifestPayload>(manifestUrl, signal);
  signal?.throwIfAborted();
  return parseReleaseManifest(manifest, appId, latest.version, manifestUrl);
}

function parseReleaseManifest(
  manifest: unknown,
  appId: string,
  version: string,
  manifestUrl: string,
): Omit<LoadedUpdate, "currentVersion"> {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw updateError("integrity_manifest_invalid", "Invalid update manifest");
  }
  const value = manifest as ManifestPayload;
  if (value.appId !== appId) throw updateError("update_manifest_app_mismatch", "Update manifest does not target this application");
  if (value.version !== version) throw updateError("update_manifest_version_mismatch", "Update version does not match manifest");
  if (value.platform !== "win32-x64") throw updateError("update_manifest_platform_mismatch", "Update manifest does not target this platform");
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw updateError("update_manifest_files_invalid", "Invalid update file list");
  }
  const files = value.files.map(parseManifestFile);
  const paths = new Set<string>();
  for (const file of files) {
    ensureSameOrigin(manifestUrl, new URL(file.url, manifestUrl).toString());
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw updateError("integrity_manifest_invalid", "Manifest has duplicate paths");
    paths.add(key);
  }
  return { latestVersion: version, manifestUrl, files };
}

async function loadUpdate(appId: string, timeoutMs?: number): Promise<LoadedUpdate> {
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
    const release = await loadReleaseManifest(appId, signal, currentVersion);
    if (signal?.aborted) throw updateError("update_check_timeout", "Update check aborted");
    return { currentVersion, ...release };
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

async function downloadFile(
  url: string,
  filePath: string,
  sha256: string,
  size: number,
  signal?: AbortSignal,
  onChunk?: (bytes: number) => void,
): Promise<void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason ?? updateError("update_cancelled", "Update cancelled"));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const resetInactivity = () => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => controller.abort(updateError("update_download_timeout", "Download stalled")), 30000);
  };
  const temporary = filePath + "." + randomUUID() + ".tmp";
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  try {
    resetInactivity();
    const response = await awaitIntegrityOperation(
      () => fetch(url, { redirect: "error", signal: controller.signal }),
      controller.signal,
    );
    if (!response.ok || !response.body) {
      throw updateError("update_download_failed", "Unable to download managed file");
    }
    handle = await open(temporary, "wx");
    reader = response.body.getReader();
    const hash = createHash("sha256");
    let received = 0;
    while (true) {
      const next = await awaitIntegrityOperation(() => reader!.read(), controller.signal);
      if (next.done) break;
      const bytes = next.value;
      received += bytes.byteLength;
      if (!Number.isSafeInteger(received) || received > size) {
        throw updateError("update_file_hash_mismatch", "Downloaded file exceeds its expected size");
      }
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.write(bytes.subarray(offset));
        offset += result.bytesWritten;
      }
      hash.update(bytes);
      controller.signal.throwIfAborted();
      onChunk?.(bytes.byteLength);
      resetInactivity();
    }
    if (received !== size || hash.digest("hex").toUpperCase() !== sha256) {
      throw updateError("update_file_hash_mismatch", "Downloaded file does not match the release");
    }
    await handle.close();
    handle = undefined;
    controller.signal.throwIfAborted();
    await rename(temporary, filePath);
    completed = true;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason ?? error;
    throw error;
  } finally {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    signal?.removeEventListener("abort", onAbort);
    if (!completed && reader) void reader.cancel().catch(() => {});
    if (handle) await handle.close();
    if (!completed) await rm(temporary, { force: true });
  }
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
  if (path.isAbsolute(normalizedPath) || normalizedPath.split("/")[0]?.toLowerCase().startsWith(".compet-maintenance") ||
      normalizedPath.split("/").some((part) => !part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || !/^[a-f0-9]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) {
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

function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath, { signal });
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
  if (installing && !integrityTask) {
    const version = app.getVersion();
    return { version, currentVersion: version, checkedFiles: 0, totalFiles: 0,
      stage: "checking", downloadedBytes: 0, totalDownloadBytes: 0,
      action: "none", changedFiles: 0, changedBytes: 0,
      status: "unavailable", issues: [], error: "update_busy" };
  }
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

export function isClientMaintenanceActive(): boolean {
  return installing || integrityTask !== undefined || maintenanceController !== undefined;
}

export function cancelClientMaintenance(): void {
  if (maintenanceHandedOff) return;
  const reason = updateError("update_cancelled", "Client maintenance cancelled");
  maintenanceController?.abort(reason);
  integrityController?.abort(reason);
}

export async function repairClientIntegrity(
  onProgress?: (progress: IntegrityProgress) => void,
  beforeHandoff?: () => Promise<void>,
): Promise<import("../updateTypes.js").MaintenanceStartResult> {
  if (installing || integrityTask) return { status: "failed", error: "update_busy" };
  const previousFingerprint = integritySnapshot?.fingerprint;
  if (!previousFingerprint) return { status: "failed", error: "integrity_scan_required" };
  installing = true;
  maintenanceHandedOff = false;
  const controller = new AbortController();
  maintenanceController = controller;
  if (onProgress) integrityListeners.add(onProgress);
  let launched = false;
  try {
    const report = await performIntegrityCheck(true, controller.signal);
    if (controller.signal.aborted) return { status: "cancelled", error: "update_cancelled" };
    if (report.status === "unavailable" || report.error || !integritySnapshot) {
      return { status: "failed", error: report.error ?? "integrity_unavailable" };
    }
    if (integritySnapshot.fingerprint !== previousFingerprint) {
      return { status: "refresh_required", report };
    }
    if (report.changedFiles === 0) return { status: "no_changes", report };
    await prepareClientMaintenance(integritySnapshot.release, report, controller.signal, "Compet Player Client.exe", beforeHandoff);
    launched = true;
    maintenanceHandedOff = true;
    return { status: "installing" };
  } catch (error) {
    if (controller.signal.aborted) return { status: "cancelled", error: "update_cancelled" };
    const code = (error as Partial<CodedUpdateError>).code;
    if (code === "update_download_failed") {
      const refreshed = await performIntegrityCheck(true, controller.signal);
      if (controller.signal.aborted) return { status: "cancelled", error: "update_cancelled" };
      if (refreshed.status !== "unavailable" && integritySnapshot?.fingerprint !== previousFingerprint) {
        return { status: "refresh_required", report: refreshed };
      }
    }
    return { status: "failed", error: code ?? "integrity_failed" };
  } finally {
    if (onProgress) integrityListeners.delete(onProgress);
    if (!launched) installing = false;
    if (maintenanceController === controller) maintenanceController = undefined;
  }
}

async function assertNoLinkedAncestors(target: string): Promise<void> {
  let current = path.resolve(target);
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw updateError("integrity_path_outside", "Maintenance path contains a link");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function runHelperPreflight(helperPath: string, planPath: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(helperPath, ["--validate-plan", "--plan", planPath], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      reject(updateError("update_helper_spawn_failed", "Unable to start maintenance helper"));
      return;
    }
    const onAbort = () => {
      child.kill();
      reject(signal.reason ?? updateError("update_cancelled", "Client maintenance cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => {
      signal.removeEventListener("abort", onAbort);
      reject(updateError("update_helper_spawn_failed", "Unable to start maintenance helper"));
    });
    child.once("exit", code => {
      signal.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(updateError("update_helper_invalid", "Maintenance helper rejected the plan"));
    });
  });
}

async function prepareClientMaintenance(
  release: Omit<LoadedUpdate, "currentVersion">,
  report: IntegrityReport,
  signal: AbortSignal,
  exeName: string,
  beforeHandoff?: () => Promise<void>,
): Promise<void> {
  signal.throwIfAborted();
  const lexicalRoot = getInstallRoot();
  await assertNoLinkedAncestors(lexicalRoot);
  const installRoot = await realpath(lexicalRoot);
  const directory = path.join(installRoot, ".compet-maintenance");
  const stagingDirectory = path.join(installRoot, ".compet-maintenance-staging");
  try {
    await lstat(directory);
    throw updateError("update_transaction_pending", "A maintenance transaction already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await clearMaintenanceStaging(stagingDirectory);
  await mkdir(stagingDirectory);
  let handedOff = false;
  let promoted = false;
  try {
    const filesRoot = path.join(stagingDirectory, "files");
    await mkdir(filesRoot);
    const updaterFile = release.files.find(file => file.path.toLowerCase() === "runtime/updater/compet updater.exe");
    if (!updaterFile) throw updateError("update_helper_missing", "Release manifest has no maintenance helper");
    const changedPaths = new Set(report.issues.filter(issue => issue.kind !== "read_failed").map(issue => issue.path.toLowerCase()));
    const changed = release.files.filter(file => changedPaths.has(file.path.toLowerCase()));
    const localHelperPath = path.join(installRoot, updaterFile.path);
    const helperIsLocal = await hasSameFileHash(localHelperPath, updaterFile.sha256, updaterFile.size);
    const downloads = new Map<string, ManifestFile>();
    for (const file of changed) downloads.set(file.sha256, file);
    if (!helperIsLocal) downloads.set(updaterFile.sha256, updaterFile);
    let downloadedBytes = 0;
    const totalDownloadBytes = [...downloads.values()].reduce((total, file) => total + file.size, 0);
    if (!Number.isSafeInteger(totalDownloadBytes)) throw updateError("integrity_manifest_invalid", "Download total is too large");
    let lastProgressAt = 0;
    const publish = (stage: IntegrityProgress["stage"], force = false) => {
      signal.throwIfAborted();
      if (!force && Date.now() - lastProgressAt < 100) return;
      lastProgressAt = Date.now();
      const progress: IntegrityProgress = {
        version: report.version,
        checkedFiles: report.checkedFiles,
        totalFiles: report.totalFiles,
        stage,
        downloadedBytes,
        totalDownloadBytes,
      };
      for (const listener of integrityListeners) listener(progress);
    };
    publish("downloading", true);
    for (const file of downloads.values()) {
      signal.throwIfAborted();
      const source = path.join(filesRoot, file.sha256);
      const url = new URL(file.url, release.manifestUrl).toString();
      ensureSameOrigin(release.manifestUrl, url);
      await downloadFile(url, source, file.sha256, file.size, signal, bytes => {
        downloadedBytes += bytes;
        publish("downloading");
      });
    }
    publish("preparing", true);
    const helperPath = path.join(stagingDirectory, "Compet Updater.exe");
    await copyFile(helperIsLocal ? localHelperPath : path.join(filesRoot, updaterFile.sha256), helperPath);
    if (!(await hasSameFileHash(helperPath, updaterFile.sha256, updaterFile.size))) {
      throw updateError("update_helper_invalid", "Staged maintenance helper failed verification");
    }
    const plan: MaintenancePlan = {
      root: installRoot,
      exe: exeName,
      targetVersion: release.latestVersion,
      helper: { size: updaterFile.size, sha256: updaterFile.sha256 },
      files: changed.map(file => ({
        source: "files/" + file.sha256,
        path: file.path,
        size: file.size,
        sha256: file.sha256,
      })),
    };
    await writeMaintenancePlan(stagingDirectory, plan, {
      appId: "compet-player-client",
      version: release.latestVersion,
      platform: "win32-x64",
      files: release.files,
    });
    const planPath = path.join(stagingDirectory, "plan.txt");
    await runHelperPreflight(helperPath, planPath, signal);
    signal.throwIfAborted();
    try {
      const receipt = await readMaintenanceTransaction(stagingDirectory);
      if (receipt?.state !== "prepared") throw new Error("Missing helper receipt");
    } catch {
      throw updateError("update_helper_invalid", "Maintenance helper did not confirm preparation");
    }
    await beforeHandoff?.();
    signal.throwIfAborted();
    await rename(stagingDirectory, directory);
    promoted = true;
    signal.throwIfAborted();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(path.join(directory, "Compet Updater.exe"),
        ["--plan", path.join(directory, "plan.txt"), "--pid", String(process.pid)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      throw updateError("update_helper_spawn_failed", "Unable to start maintenance helper");
    }
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(updateError("update_helper_spawn_failed", "Unable to start maintenance helper")));
    });
    handedOff = true;
    maintenanceHandedOff = true;
    child.unref();
    app.quit();
  } finally {
    if (!handedOff) {
      if (promoted) await rm(directory, { recursive: true, force: true });
      else await clearMaintenanceStaging(stagingDirectory);
    }
  }
}

function awaitIntegrityOperation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then((value) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function assertWithinInstallation(root: string, target: string, allowRoot = false): void {
  const relative = path.relative(root, target);
  if ((!relative && !allowRoot) || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw updateError("integrity_path_outside", "Managed file resolves outside the installation");
  }
}

async function resolveManagedFile(root: string, filePath: string, signal: AbortSignal): Promise<string | null> {
  const absolute = path.resolve(root, filePath);
  assertWithinInstallation(root, absolute);
  try {
    const resolved = await awaitIntegrityOperation(() => realpath(absolute), signal);
    assertWithinInstallation(root, resolved);
    return resolved;
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let ancestor = path.dirname(absolute);
  while (true) {
    try {
      const resolved = await awaitIntegrityOperation(() => realpath(ancestor), signal);
      assertWithinInstallation(root, resolved, true);
      return null;
    } catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || ancestor === root) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
}

async function performIntegrityCheck(
  allowBusy = false,
  externalSignal?: AbortSignal,
  cachedRelease?: Omit<LoadedUpdate, "currentVersion">,
): Promise<IntegrityReport> {
  integritySnapshot = undefined;
  const currentVersion = app.getVersion();
  const report: IntegrityReport = {
    version: currentVersion,
    currentVersion,
    checkedFiles: 0,
    totalFiles: 0,
    stage: cachedRelease ? "verifying" : "checking",
    downloadedBytes: 0,
    totalDownloadBytes: 0,
    action: "none",
    changedFiles: 0,
    changedBytes: 0,
    status: "unavailable",
    issues: [],
  };
  const controller = new AbortController();
  integrityController = controller;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    if (installing && !allowBusy) throw updateError("update_busy", "Update is running");
    if (!isSemver(currentVersion) || !isInstalledClientLayout(app.getAppPath(), app.getPath("exe"))) {
      throw updateError("integrity_unavailable", "Integrity verification requires a supported client installation");
    }
    const readInstalledPackage = async (): Promise<{ name?: unknown; version?: unknown }> => {
      try {
        const value: unknown = JSON.parse(await awaitIntegrityOperation(
          () => readFile(path.join(app.getAppPath(), "package.json"), "utf8"),
          controller.signal,
        ));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid installed package");
        return value as { name?: unknown; version?: unknown };
      } catch {
        controller.signal.throwIfAborted();
        throw updateError("integrity_installation_invalid", "Unable to read the installed client package");
      }
    };
    const installedBefore = await readInstalledPackage();
    if (installedBefore.name !== "compet-player-client" || installedBefore.version !== currentVersion) {
      throw updateError("integrity_installation_invalid", "Installed package identity does not match the running client");
    }

    let release: Omit<LoadedUpdate, "currentVersion">;
    try {
      release = cachedRelease ?? await awaitIntegrityOperation(
        () => loadReleaseManifest("compet-player-client", controller.signal),
        controller.signal,
      );
    } catch (error) {
      controller.signal.throwIfAborted();
      const code = (error as Partial<CodedUpdateError>).code;
      if (code === "update_manifest_app_mismatch" || code === "update_manifest_version_mismatch" ||
          code === "update_manifest_platform_mismatch") {
        throw updateError("integrity_manifest_mismatch", "Manifest does not match this installation");
      }
      if (error instanceof SyntaxError || code === "update_version_invalid" ||
          code === "update_manifest_url_invalid" || code === "update_manifest_files_invalid") {
        throw updateError("integrity_manifest_invalid", "Invalid latest release or manifest");
      }
      if (!(error as Partial<CodedUpdateError>).code ||
          (error as Partial<CodedUpdateError>).code === "update_server_error") {
        throw updateError("integrity_manifest_unavailable", "Unable to retrieve the latest integrity manifest");
      }
      throw error;
    }
    report.version = release.latestVersion;
    report.totalFiles = release.files.length;
    const root = await awaitIntegrityOperation(() => realpath(getInstallRoot()), controller.signal);
    let lastProgressAt = 0;
    const publish = () => {
      controller.signal.throwIfAborted();
      if (report.checkedFiles !== report.totalFiles && Date.now() - lastProgressAt < 100) return;
      lastProgressAt = Date.now();
      const progress: IntegrityProgress = {
        version: report.version,
        checkedFiles: report.checkedFiles,
        totalFiles: report.totalFiles,
        stage: report.stage,
        downloadedBytes: report.downloadedBytes,
        totalDownloadBytes: report.totalDownloadBytes,
      };
      for (const listener of integrityListeners) listener(progress);
    };
    publish();

    for (const file of release.files) {
      let target: string | null;
      try {
        target = await resolveManagedFile(root, file.path, controller.signal);
      } catch (error) {
        controller.signal.throwIfAborted();
        if ((error as Partial<CodedUpdateError>).code === "integrity_path_outside") throw error;
        report.issues.push({ path: file.path, kind: "read_failed" });
        report.checkedFiles++;
        publish();
        continue;
      }
      if (target === null) {
        report.issues.push({ path: file.path, kind: "missing" });
        report.changedFiles++;
        report.changedBytes += file.size;
        report.checkedFiles++;
        publish();
        continue;
      }
      try {
        const info = await awaitIntegrityOperation(() => stat(target), controller.signal);
        if (!info.isFile()) report.issues.push({ path: file.path, kind: "read_failed" });
        else if (info.size !== file.size) report.issues.push({ path: file.path, kind: "size_mismatch" });
        else if (await awaitIntegrityOperation(() => hashFile(target, controller.signal), controller.signal) !== file.sha256) {
          report.issues.push({ path: file.path, kind: "hash_mismatch" });
        }
      } catch {
        controller.signal.throwIfAborted();
        report.issues.push({ path: file.path, kind: "read_failed" });
      }
      const issue = report.issues.at(-1);
      if (issue?.path === file.path && issue.kind !== "read_failed") {
        report.changedFiles++;
        report.changedBytes += file.size;
      }
      report.checkedFiles++;
      publish();
    }
    if (!Number.isSafeInteger(report.changedBytes)) throw updateError("integrity_manifest_invalid", "Managed file total is too large");
    const installed = await readInstalledPackage();
    if (app.getVersion() !== currentVersion || installed.version !== currentVersion) {
      throw updateError("integrity_version_changed", "Installation version changed during verification");
    }
    if (installed.name !== "compet-player-client") {
      throw updateError("integrity_installation_invalid", "Installed client identity changed during verification");
    }
    controller.signal.throwIfAborted();
    report.status = report.issues.some((issue) => issue.kind === "read_failed") ? "unavailable" : report.issues.length ? "issues" : "passed";
    report.action = release.latestVersion !== currentVersion ? "update" : report.changedFiles > 0 ? "repair" : "none";
    if (!cachedRelease && report.status !== "unavailable") {
      integritySnapshot = { release, fingerprint: JSON.stringify([release.latestVersion, release.manifestUrl, release.files]) };
    }
  } catch (error) {
    const abortCode = (controller.signal.reason as Partial<CodedUpdateError> | undefined)?.code;
    report.error = controller.signal.aborted
      ? abortCode === "update_cancelled" ? "update_cancelled" : "integrity_timeout"
      : (error as Partial<CodedUpdateError>).code ?? "integrity_failed";
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (integrityController === controller) integrityController = undefined;
  }
  return report;
}

let lastMaintenanceResult: IntegrityReport | null = null;

function maintenanceFailure(error: string, transaction?: MaintenanceTransaction): IntegrityReport {
  const version = transaction?.targetVersion ?? app.getVersion();
  return {
    version,
    currentVersion: app.getVersion(),
    checkedFiles: 0,
    totalFiles: 0,
    stage: "verifying",
    downloadedBytes: 0,
    totalDownloadBytes: 0,
    action: "none",
    changedFiles: 0,
    changedBytes: 0,
    status: "unavailable",
    issues: [],
    error,
  };
}

function maintenanceErrorCode(error: unknown): string {
  const code = (error as Partial<CodedUpdateError>)?.code;
  if (code && /^[a-z0-9_]+$/.test(code)) return code;
  const message = error instanceof Error ? error.message : "";
  if (/journal/i.test(message)) return "maintenance_journal_invalid";
  if (/manifest/i.test(message)) return "maintenance_manifest_invalid";
  if (/summary/i.test(message)) return "maintenance_summary_invalid";
  return "maintenance_transaction_invalid";
}

async function writeFailureSummary(
  directory: string,
  report: IntegrityReport,
  transaction?: MaintenanceTransaction,
): Promise<void> {
  lastMaintenanceResult = report;
  if (transaction) {
    try { await writeMaintenanceSummary(directory, report); }
    catch { /* Retain the transaction so startup can report the failure again. */ }
  }
}

async function runMaintenanceRecovery(directory: string, plan: MaintenancePlan): Promise<boolean> {
  const helper = path.join(directory, "Compet Updater.exe");
  await assertNoLinkedAncestors(helper);
  if (!(await hasSameFileHash(helper, plan.helper.sha256, plan.helper.size))) {
    throw updateError("maintenance_helper_invalid", "Staged recovery helper is invalid");
  }
  const planPath = path.join(directory, "plan.txt");
  return await new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(helper, ["--recover", "--plan", planPath, "--pid", String(process.pid)], {
        detached: true, windowsHide: true, stdio: "ignore",
      });
    } catch { resolve(false); return; }
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref(); resolve(true); });
  });
}

async function finishVerifiedMaintenance(directory: string, report: IntegrityReport): Promise<IntegrityReport> {
  const completed = { ...report };
  if (completed.error === "maintenance_cleanup_pending") delete completed.error;
  try {
    await cleanupMaintenancePayload(directory);
    await writeMaintenanceReceipt(path.dirname(directory), completed);
    await clearMaintenanceTransaction(directory);
    lastMaintenanceResult = completed;
    return completed;
  } catch {
    const pending = { ...completed, error: "maintenance_cleanup_pending" };
    lastMaintenanceResult = pending;
    try { await writeMaintenanceSummary(directory, pending); } catch { /* Preserve the verified transaction. */ }
    try { await writeMaintenanceReceipt(path.dirname(directory), pending); } catch { /* Preserve the transaction summary. */ }
    return pending;
  }
}

export async function getMaintenanceResult(acknowledge = false): Promise<IntegrityReport | null> {
  const directory = path.join(getInstallRoot(), ".compet-maintenance");
  let report = lastMaintenanceResult;
  if (!report) {
    try { report = await readMaintenanceSummary(directory) ?? await readMaintenanceReceipt(getInstallRoot()); }
    catch (error) { report = maintenanceFailure(maintenanceErrorCode(error)); }
  }
  if (!report) return null;
  if (acknowledge) {
    let transaction: MaintenanceTransaction | null;
    try { transaction = await readMaintenanceTransaction(directory); }
    catch { return report; }
    if (!transaction || transaction.state === "verified" || transaction.state === "rolled_back") {
      try {
        if (transaction) await clearMaintenanceTransaction(directory);
        await clearRetiredMaintenance(getInstallRoot());
        await clearMaintenanceReceipt(getInstallRoot());
        lastMaintenanceResult = null;
      } catch {
        if (report.status === "passed") {
          report = { ...report, error: "maintenance_cleanup_pending" };
          lastMaintenanceResult = report;
          if (transaction) {
            try { await writeMaintenanceSummary(directory, report); } catch { /* Preserve evidence. */ }
          }
          try { await writeMaintenanceReceipt(getInstallRoot(), report); } catch { /* Preserve evidence. */ }
        }
      }
    }
  }
  return report;
}

export async function finalizeClientMaintenance(): Promise<IntegrityReport | null | "exit_requested"> {
  const directory = path.join(getInstallRoot(), ".compet-maintenance");
  let transaction: MaintenanceTransaction | null;
  try { transaction = await readMaintenanceTransaction(directory); }
  catch (error) {
    const report = maintenanceFailure(maintenanceErrorCode(error));
    lastMaintenanceResult = report;
    return report;
  }
  if (!transaction) {
    let cleanupPending = false;
    try { await clearRetiredMaintenance(getInstallRoot()); }
    catch { cleanupPending = true; }
    try {
      const receipt = await readMaintenanceReceipt(getInstallRoot());
      if (!receipt) {
        lastMaintenanceResult = cleanupPending ? maintenanceFailure("maintenance_cleanup_pending") : null;
      } else if (cleanupPending && receipt.error !== "maintenance_cleanup_pending") {
        lastMaintenanceResult = { ...receipt, error: "maintenance_cleanup_pending" };
        await writeMaintenanceReceipt(getInstallRoot(), lastMaintenanceResult);
      } else if (!cleanupPending && receipt.error === "maintenance_cleanup_pending") {
        lastMaintenanceResult = { ...receipt };
        delete lastMaintenanceResult.error;
        await writeMaintenanceReceipt(getInstallRoot(), lastMaintenanceResult);
      } else {
        lastMaintenanceResult = receipt;
      }
    } catch (error) { lastMaintenanceResult = maintenanceFailure(maintenanceErrorCode(error)); }
    return lastMaintenanceResult;
  }
  if (transaction.state === "verified") {
    try {
      const summary = await readMaintenanceSummary(directory);
      if (!summary) throw new Error("Invalid maintenance summary");
      return await finishVerifiedMaintenance(directory, summary);
    } catch (error) {
      const report = maintenanceFailure(maintenanceErrorCode(error), transaction);
      lastMaintenanceResult = report;
      return report;
    }
  }
  if (transaction.state !== "applied") {
    try {
      const saved = await readMaintenanceSummary(directory);
      if (saved?.version === transaction.targetVersion && saved.status === "unavailable") {
        lastMaintenanceResult = saved;
        return saved;
      }
    } catch { /* Use the transaction state when the summary is damaged. */ }
    const report = maintenanceFailure(transaction.error ??
      (transaction.state === "recovery_failed" ? "maintenance_recovery_failed" :
        transaction.state === "rolled_back" ? "maintenance_rolled_back" : "maintenance_incomplete"), transaction);
    await writeFailureSummary(directory, report, transaction);
    return report;
  }
  let plan: MaintenancePlan;
  let release: Omit<LoadedUpdate, "currentVersion">;
  try {
    plan = await readMaintenancePlan(directory);
    const root = await realpath(getInstallRoot());
    if (root.toLowerCase() !== transaction.root.toLowerCase() ||
        plan.exe !== "Compet Player Client.exe" ||
        !isInstalledClientLayout(app.getAppPath(), app.getPath("exe")) ||
        app.getVersion() !== transaction.targetVersion) {
      throw updateError("maintenance_identity_invalid", "Maintenance identity does not match");
    }
    const journal = await readMaintenanceJournal(directory, true);
    for (const entry of journal) {
      if (entry.existed && !(await hasSameFileHash(
        path.join(directory, entry.backup), entry.sha256, entry.size,
      ))) throw updateError("maintenance_backup_invalid", "Maintenance backup is damaged");
    }
    const manifest = await readMaintenanceManifest(directory);
    release = parseReleaseManifest(manifest, "compet-player-client", transaction.targetVersion,
      "https://qwepplz111.site/update/client/latest.json");
    for (const file of plan.files) {
      if (!release.files.some(entry => entry.path.toLowerCase() === file.path.toLowerCase() &&
          entry.sha256 === file.sha256 && entry.size === file.size)) {
        throw updateError("maintenance_manifest_invalid", "Cached release does not match the transaction");
      }
    }
  } catch (error) {
    const report = maintenanceFailure(maintenanceErrorCode(error), transaction);
    await writeFailureSummary(directory, report, transaction);
    return report;
  }

  const report = await performIntegrityCheck(false, undefined, release);
  if (report.error === "integrity_timeout") {
    report.error = "maintenance_verification_timeout";
    await writeFailureSummary(directory, report, transaction);
    return report;
  }
  if (report.status !== "passed") {
    report.status = "unavailable";
    report.error = "maintenance_verification_failed";
    await writeFailureSummary(directory, report, transaction);
    let handedOff = false;
    try { handedOff = await runMaintenanceRecovery(directory, plan); }
    catch { /* The launcher will keep the unresolved transaction blocked. */ }
    if (!handedOff) {
      report.error = "maintenance_recovery_failed";
      await writeFailureSummary(directory, report, transaction);
    }
    maintenanceHandedOff = true;
    app.quit();
    return "exit_requested";
  }

  try {
    await writeMaintenanceSummary(directory, report);
    await writeMaintenanceTransaction(directory, { ...transaction, state: "verified", error: undefined });
    return await finishVerifiedMaintenance(directory, report);
  } catch (error) {
    const failed = maintenanceFailure(maintenanceErrorCode(error), transaction);
    await writeFailureSummary(directory, failed, transaction);
    return failed;
  }
}