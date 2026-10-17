import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "./build-sourcemod.js";
import { assertPlainPath } from "../src/desktop/main/serverManagedFiles.js";
export async function cleanServerBuild(): Promise<void> {
  const target = path.join(repositoryRoot, "dist");
  if (path.dirname(target) !== repositoryRoot || path.basename(target) !== "dist") throw new Error("unsafe_build_directory");
  await assertPlainPath(target);
  await fs.rm(target, { recursive: true, force: true });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cleanServerBuild();
