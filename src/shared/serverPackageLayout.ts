import path from "node:path";

export type ServerPlatform = "linux-x64";

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

export function assertNativeServerPlatform(platform: string, arch: string): void {
  if (platform !== "linux" || arch !== "x64") invalid("server_platform_unsupported");
}

function assertServerPlatform(platform: string): void {
  if (platform !== "linux-x64") invalid("server_platform_unsupported");
}

function absoluteRoot(value: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\x00-\x1f]/.test(value) ||
      !path.posix.isAbsolute(value) || value.includes("\\")) invalid("server_path_invalid");
  const root = path.posix.normalize(value);
  if (root === "/") invalid("server_path_invalid");
  return root.replace(/\/$/, "");
}

export function resolveServerLayout(input: { platform: ServerPlatform; installRoot: string }): ServerLayout {
  assertServerPlatform(input.platform);
  const installRoot = absoluteRoot(input.installRoot);
  return {
    platform: input.platform, installRoot, appRoot: installRoot,
    nodePath: path.posix.join(installRoot, "runtime/node/bin/node"),
    cliEntry: path.posix.join(installRoot, "dist/cli.cjs"),
    serviceEntry: path.posix.join(installRoot, "dist/main.cjs"),
    workerEntry: path.posix.join(installRoot, "runtime/updater/worker.cjs"),
    runCsgoPrefix: "run_csgo/",
  };
}

export function assertServerRoots(input: {
  platform: ServerPlatform; installRoot?: string; dataDir: string; serverRoot: string;
}): void {
  assertServerPlatform(input.platform);
  const roots = [input.installRoot, input.dataDir, input.serverRoot]
    .filter((value): value is string => value !== undefined).map(absoluteRoot);
  const within = (value: string) => value === "" ||
    (!path.posix.isAbsolute(value) && value !== ".." && !value.startsWith("../"));
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      if (within(path.posix.relative(roots[i]!, roots[j]!)) || within(path.posix.relative(roots[j]!, roots[i]!))) {
        invalid("server_roots_overlap");
      }
    }
  }
}
