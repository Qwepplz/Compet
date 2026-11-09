import { app } from "electron";
import path from "node:path";

export function getInstallRoot(appPath: string = app.getAppPath()): string {
  return path.resolve(appPath, "..", "..", "..", "..");
}

export function isInstalledClientLayout(appPath: string, executablePath: string): boolean {
  if (!path.isAbsolute(appPath) || !path.isAbsolute(executablePath)) return false;
  const root = getInstallRoot(appPath);
  const runtime = path.join(root, "runtime", "electron");
  return path.relative(path.join(runtime, "resources", "app"), appPath) === ""
    && path.relative(path.join(runtime, "electron.exe"), executablePath) === "";
}
