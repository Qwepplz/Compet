import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: WriteJsonFileOptions = {},
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const json = options.pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2);

  try {
    await writeFile(tempPath, `${json}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function ensureJsonFile<T>(filePath: string, defaultValue: T): Promise<void> {
  if (!(await pathExists(filePath))) {
    await writeJsonFileAtomic(filePath, defaultValue);
  }
}
