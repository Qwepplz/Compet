import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { assertPlainPath } from "../desktop/main/serverManagedFiles.js";
import path from "node:path";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string, fallback?: T): Promise<T> {
  if (!(await pathExists(filePath))) {
    if (fallback !== undefined) return fallback;
    throw new Error(`JSON file does not exist: ${filePath}`);
  }
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export interface WriteJsonFileOptions {
  pretty?: boolean;
  createParent?: boolean;
  durable?: boolean;
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: WriteJsonFileOptions = {},
): Promise<void> {
  if (options.durable) await assertPlainPath(filePath);
  if (options.createParent !== false) {
    await mkdir(path.dirname(filePath), { recursive: true });
  }
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const json = options.pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2);

  try {
    if (options.durable) {
      const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "linux" ? constants.O_NOFOLLOW : 0), 0o600);
      try { await handle.writeFile(`${json}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    } else { await writeFile(tempPath, `${json}\n`, "utf8"); }
    await rename(tempPath, filePath);
    if (options.durable && process.platform === "linux") {
      const directory = await open(path.dirname(filePath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch (cleanupError) {
      const details: Record<string, string> = { file: tempPath };
      if (cleanupError && typeof cleanupError === "object") {
        const fields = cleanupError as Record<string, unknown>;
        for (const field of ["code", "syscall"]) {
          if (typeof fields[field] === "string") details[field] = fields[field];
        }
      }
      process.stderr.write("Failed to clean JSON temporary file: " + JSON.stringify(details) + "\n");
    }
    throw error;
  }
}

export async function ensureJsonFile<T>(filePath: string, defaultValue: T): Promise<void> {
  if (!(await pathExists(filePath))) {
    await writeJsonFileAtomic(filePath, defaultValue);
  }
}
