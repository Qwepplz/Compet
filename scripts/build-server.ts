import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSourcemod, repositoryRoot } from "./build-sourcemod.js";
import { cleanServerBuild } from "./clean-server-build.js";
export async function buildServer(): Promise<void> {
  await buildSourcemod();
  await cleanServerBuild();
  const run = spawnSync(process.execPath, [path.join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", path.join(repositoryRoot, "tsconfig.build.json")], { cwd: repositoryRoot, stdio: "inherit", windowsHide: true });
  if (run.error || run.status !== 0) throw new Error("server_build_failed");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildServer();
