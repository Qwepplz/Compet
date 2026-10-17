import path from "node:path";

export type ServerPlatform = "win32-x64" | "linux-x64";

export interface ServerLayout {
  platform: ServerPlatform;
  installRoot: string;
  appRoot: string;
  nodePath: string;
  cliEntry: string;
  serviceEntry: string;
  workerEntry: string;
  runCsgoPrefix: string;
}

function invalid(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function platformPath(platform: ServerPlatform): typeof path.posix {
  if (platform === "win32-x64") return path.win32;
  if (platform === "linux-x64") return path.posix;
  return invalid("server_platform_unsupported");
}

function absoluteRoot(platform: ServerPlatform, value: string): string {
  const api = platformPath(platform);
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\x00-\x1f]/.test(value) ||
      !api.isAbsolute(value) || (platform === "linux-x64" && value.includes("\\")) ||
      (platform === "win32-x64" && !/^[A-Za-z]:[\\/]/.test(value))) invalid("server_path_invalid");
  const root = api.normalize(value);
  if (root === api.parse(root).root) invalid("server_path_invalid");
  return root.replace(/[\\/]$/, "");
}

export function resolveServerLayout(input: { platform: ServerPlatform; installRoot: string }): ServerLayout {
  const api = platformPath(input.platform);
  const installRoot = absoluteRoot(input.platform, input.installRoot);
  const appRoot = input.platform === "win32-x64"
    ? api.join(installRoot, "runtime/electron/resources/app") : installRoot;
  return {
    platform: input.platform, installRoot, appRoot,
    nodePath: api.join(installRoot, input.platform === "win32-x64" ? "runtime/node/node.exe" : "runtime/node/bin/node"),
    cliEntry: api.join(appRoot, "dist/cli.cjs"),
    serviceEntry: api.join(appRoot, "dist/main.cjs"),
    workerEntry: api.join(installRoot, "runtime/updater/worker.cjs"),
    runCsgoPrefix: input.platform === "win32-x64" ? "runtime/electron/resources/app/run_csgo/" : "run_csgo/",
  };
}

export function assertServerRoots(input: {
  platform: ServerPlatform; installRoot?: string; dataDir: string; serverRoot: string;
}): void {
  const api = platformPath(input.platform);
  const roots = [input.installRoot, input.dataDir, ...(input.platform === "win32-x64" && input.serverRoot === "" ? [] : [input.serverRoot])].filter((value): value is string => value !== undefined).map(value => {
    const normalized = absoluteRoot(input.platform, value);
    return input.platform === "win32-x64" ? normalized.toLowerCase() : normalized;
  });
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      if (input.platform === "win32-x64" && input.installRoot && i === 0 && j === 1) {
        const dataRoot = api.join(resolveServerLayout({ platform: input.platform, installRoot: input.installRoot }).appRoot, "server-data").toLowerCase();
        if (roots[j] === dataRoot || roots[j]!.startsWith(dataRoot + api.sep)) continue;
      }
      const relative = api.relative(roots[i]!, roots[j]!);
      const reverse = api.relative(roots[j]!, roots[i]!);
      const within = (value: string) => value === "" ||
        (!api.isAbsolute(value) && value !== ".." && !value.startsWith(".." + api.sep));
      if (within(relative) || within(reverse)) invalid("server_roots_overlap");
    }
  }
}
