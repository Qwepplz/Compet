import path from "node:path";

export interface PlayerAppIdentity {
  appId: "site.qwepplz.compet.player";
  displayName: "Compet Player Client";
  iconPath: string;
  relaunchCommand: string;
}

export function assertWindowsClientPlatform(platform: string): void {
  if (platform !== "win32") throw Object.assign(new Error("client_platform_unsupported"), { code: "client_platform_unsupported" });
}

function quoteArgument(value: string): string {
  return '"' + value.replace(/(\\+)$/u, "$1$1") + '"';
}

export function resolvePlayerAppIdentity(input: {
  appRoot: string;
  executablePath: string;
  installRoot?: string;
}): PlayerAppIdentity {
  const values = [input.appRoot, input.executablePath, ...(input.installRoot === undefined ? [] : [input.installRoot])];
  if (values.some(value => !path.win32.isAbsolute(value) || /["\x00-\x1f]/u.test(value))) {
    throw Object.assign(new Error("app_identity_path_invalid"), { code: "app_identity_path_invalid" });
  }
  const appRoot = path.win32.normalize(input.appRoot);
  return {
    appId: "site.qwepplz.compet.player",
    displayName: "Compet Player Client",
    iconPath: path.win32.join(appRoot, input.installRoot ? "assets/compet-icon.ico" : "packaging/assets/compet-icon.ico"),
    relaunchCommand: input.installRoot
      ? quoteArgument(path.win32.join(input.installRoot, "Compet Player Client.exe"))
      : quoteArgument(path.win32.normalize(input.executablePath)) + " " + quoteArgument(appRoot),
  };
}
