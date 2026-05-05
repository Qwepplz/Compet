import { mkdirSync } from "node:fs";
import path from "node:path";

interface ManagerUserDataPathOptions {
  appRoot: string;
  defaultUserDataPath: string;
  isPackaged: boolean;
}

export function resolveManagerUserDataPath(options: ManagerUserDataPathOptions): string {
  if (!options.isPackaged) return options.defaultUserDataPath;
  return path.join(options.appRoot, "user-data");
}

export function ensureManagerUserDataPath(options: ManagerUserDataPathOptions): string {
  const userDataPath = resolveManagerUserDataPath(options);
  mkdirSync(userDataPath, { recursive: true });
  return userDataPath;
}
