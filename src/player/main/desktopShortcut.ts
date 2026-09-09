import { existsSync } from "node:fs";
import path from "node:path";
import { app, shell } from "electron";
import { getInstallRoot } from "../../desktop/main/installLayout.js";

const PLAYER_LAUNCHER_NAME = "Compet Player Client.exe";
const PLAYER_SHORTCUT_NAME = "Compet Player Client.lnk";

export function createPlayerDesktopShortcut(): void {
  const installRoot = getInstallRoot();
  const launcherPath = path.join(installRoot, PLAYER_LAUNCHER_NAME);
  if (!existsSync(launcherPath)) {
    throw new Error(`Player launcher is missing: ${launcherPath}`);
  }

  const shortcutPath = path.join(app.getPath("desktop"), PLAYER_SHORTCUT_NAME);
  const created = shell.writeShortcutLink(shortcutPath, "replace", {
    target: launcherPath,
    cwd: installRoot,
    description: "Compet Player Client",
    icon: launcherPath,
    iconIndex: 0,
  });
  if (!created) throw new Error(`Failed to create desktop shortcut: ${shortcutPath}`);
}
