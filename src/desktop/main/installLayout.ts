import { app } from "electron";
import path from "node:path";

export function getInstallRoot(): string {
  return path.resolve(app.getAppPath(), "..", "..", "..", "..");
}
