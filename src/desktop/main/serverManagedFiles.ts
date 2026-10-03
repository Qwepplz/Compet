import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isSemver } from "../../shared/version.js";

export interface FileFingerprint { size: number; sha256: string }
export interface PackageFile extends FileFingerprint { path: string }
export interface PackageInventory {
  schemaVersion: 1;
  appId: "compet-server-manager";
  version: string;
  files: PackageFile[];
}
export type ManagedFileOperation =
  | ({ kind: "replace"; path: string; source: string; before?: FileFingerprint } & FileFingerprint)
  | { kind: "delete"; path: string; before: FileFingerprint };

function invalid(code = "package_inventory_invalid"): never { throw Object.assign(new Error(code), { code }); }

export function assertManagedRelativePath(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || value.includes("\\") ||
      path.posix.isAbsolute(value) || value.split("/").some(part =>
        !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) ||
        /^\.compet-maintenance/i.test(part))) invalid("managed_path_invalid");
}

export function validatePackageInventory(raw: unknown): PackageInventory {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const value = raw as Partial<PackageInventory>;
  if (value.schemaVersion !== 1 || value.appId !== "compet-server-manager" ||
      typeof value.version !== "string" || !isSemver(value.version) || !Array.isArray(value.files) ||
      value.files.length === 0) invalid();
  const seen = new Set<string>();
  const files = value.files.map((entry: unknown): PackageFile => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid();
    const item = entry as Partial<PackageFile>;
    if (typeof item.path !== "string") invalid();
    assertManagedRelativePath(item.path);
    const key = item.path.toLowerCase();
    if (key === "compet-package-manifest.json" || seen.has(key) ||
        !Number.isSafeInteger(item.size) || item.size! < 0 ||
        typeof item.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(item.sha256)) invalid();
    seen.add(key);
    return { path: item.path, size: item.size!, sha256: item.sha256.toUpperCase() };
  });
  for (const key of seen) {
    const parts = key.split("/");
    for (let n = 1; n < parts.length; n++) if (seen.has(parts.slice(0, n).join("/"))) invalid();
  }
  return { schemaVersion: 1, appId: "compet-server-manager", version: value.version, files };
}

export function isProtectedProgramPath(relative: string): boolean {
  return relative.split("/").some(part =>
    /^(user-data|server-data|records|certs|certificates|backups|mysql-backups)$/i.test(part) ||
    /^(manager-config|manager-login|language|server-installed-files)\.json$/i.test(part) ||
    /\.(db|sqlite|sqlite3)(-wal|-shm)?$/i.test(part) || /-(wal|shm)$/i.test(part));
}

export function pathsOverlap(a: string, b: string): boolean {
  const left = path.resolve(a).toLowerCase();
  const right = path.resolve(b).toLowerCase();
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
}

export async function assertPlainPath(absolute: string): Promise<void> {
  if (!path.isAbsolute(absolute)) invalid("managed_path_invalid");
  const parts: string[] = [];
  for (let cursor = absolute; ; cursor = path.dirname(cursor)) {
    parts.unshift(cursor);
    if (cursor === path.dirname(cursor)) break;
  }
  for (const [index, part] of parts.entries()) {
    try {
      const info = await lstat(part);
      if (info.isSymbolicLink()) invalid("managed_path_linked");
      if (index !== parts.length - 1 && !info.isDirectory()) invalid("managed_path_type_conflict");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

export async function fingerprintFile(absolute: string): Promise<FileFingerprint | null> {
  await assertPlainPath(absolute);
  let info;
  try { info = await lstat(absolute); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!info.isFile()) invalid("managed_path_type_conflict");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolute)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest("hex").toUpperCase() };
}
export function sameFingerprint(a: FileFingerprint | null, b: FileFingerprint | null): boolean {
  return a === null || b === null ? a === b : a.size === b.size && a.sha256.toUpperCase() === b.sha256.toUpperCase();
}

export async function buildServerUpdatePlan(input: {
  root: string; current: PackageInventory | null; target: PackageInventory; protectedPaths: string[];
}): Promise<{ operations: ManagedFileOperation[]; conflicts: Array<{ path: string; code: string }> }> {
  const current = input.current === null ? null : validatePackageInventory(input.current);
  const target = validatePackageInventory(input.target);
  await assertPlainPath(input.root);
  if (!(await lstat(input.root)).isDirectory()) invalid("managed_path_type_conflict");
  for (const protectedPath of input.protectedPaths) await assertPlainPath(protectedPath);
  const previous = new Map(current?.files.map(file => [file.path.toLowerCase(), file]));
  const next = new Map(target.files.map(file => [file.path.toLowerCase(), file]));
  const operations: ManagedFileOperation[] = [];
  const conflicts: Array<{ path: string; code: string }> = [];
  for (const key of new Set([...previous.keys(), ...next.keys()])) {
    const before = previous.get(key);
    const after = next.get(key);
    const relative = after?.path ?? before!.path;
    const absolute = path.join(input.root, relative);
    try {
      if (isProtectedProgramPath(relative) || input.protectedPaths.some(p => pathsOverlap(absolute, p))) invalid("managed_path_protected");
      if (before && after && before.path !== after.path) invalid("managed_path_case_conflict");
      const actual = await fingerprintFile(absolute);
      if (before && actual && !sameFingerprint(actual, before)) invalid("managed_file_modified");
      if (!before && actual && !sameFingerprint(actual, after ?? null)) invalid("managed_file_unknown");
      if (after && !sameFingerprint(actual, after)) {
        operations.push({ kind: "replace", path: relative, source: "files/" + after.sha256,
          size: after.size, sha256: after.sha256, ...(actual ? { before: actual } : {}) });
      } else if (!after && actual) operations.push({ kind: "delete", path: relative, before: actual });
    } catch (error) {
      conflicts.push({ path: relative, code: (error as NodeJS.ErrnoException).code ?? "managed_file_unreadable" });
    }
  }
  return { operations: conflicts.length ? [] : operations, conflicts };
}

export async function saveInstalledInventory(destination: string, inventory: PackageInventory): Promise<void> {
  const valid = validatePackageInventory(inventory);
  await assertPlainPath(destination);
  const temporary = destination + "." + randomUUID() + ".tmp";
  try {
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(JSON.stringify(valid) + "\n"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}

export async function listUnmanagedProgramPaths(root: string, files: PackageFile[], protectedPaths: string[]): Promise<string[]> {
  const known = new Set(files.map(file => file.path.toLowerCase()));
  const parents = new Set<string>();
  for (const file of known) {
    const parts = file.split("/");
    for (let n = 1; n < parts.length; n++) parents.add(parts.slice(0, n).join("/"));
  }
  const unknown: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    await assertPlainPath(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name, key = relative.toLowerCase(), absolute = path.join(directory, entry.name);
      if (key === "compet-package-manifest.json" || entry.name.startsWith(".compet-maintenance") ||
          isProtectedProgramPath(relative) || protectedPaths.some(p => pathsOverlap(absolute, p) && !p.toLowerCase().startsWith(absolute.toLowerCase() + path.sep))) continue;
      if (known.has(key)) continue;
      if (entry.isDirectory() && parents.has(key)) await visit(absolute, relative + "/");
      else unknown.push(relative + (entry.isDirectory() ? "/" : ""));
    }
  }
  await visit(root, "");
  return unknown;
}
