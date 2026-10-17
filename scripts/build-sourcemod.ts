import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertPlainPath } from "../src/desktop/main/serverManagedFiles.js";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function buildSourcemod(input: { compilerPath?: string; sourcePath?: string; outputPath?: string } = {}): Promise<void> {
  let compiler = input.compilerPath || process.env.COMPET_SPCOMP;
  if (!compiler) for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, process.platform === "win32" ? "spcomp.exe" : "spcomp");
    if (await fs.stat(candidate).then(x => x.isFile(), () => false)) { compiler = candidate; break; }
  }
  if (!compiler || !await fs.stat(compiler).then(x => x.isFile(), () => false)) throw new Error("SourcePawn compiler not found. Use COMPET_SPCOMP or --compiler-path.");
  compiler = path.resolve(compiler);
  const source = path.resolve(input.sourcePath ?? path.join(repositoryRoot, "src/sourcemod/compet_match_lock.sp"));
  const output = path.resolve(input.outputPath ?? path.join(repositoryRoot, "src/sourcemod/compet_match_lock.smx"));
  await assertPlainPath(source); await assertPlainPath(path.dirname(output));
  await assertPlainPath(output);
  const temporary = path.join(path.dirname(output), ".sourcemod-" + randomUUID().replaceAll("-", "") + ".tmp.smx");
  try {
    const args = ["-i" + path.join(path.dirname(compiler), "include"), "-o" + temporary, source];
    const run = compiler.endsWith(".ps1")
      ? spawnSync("pwsh", ["-NoProfile", "-File", compiler, ...args], { windowsHide: true, encoding: "utf8" })
      : spawnSync(compiler, args, { windowsHide: true, encoding: "utf8" });
    if (run.error || run.status !== 0 || !await fs.stat(temporary).then(x => x.isFile() && x.size > 0, () => false)) {
      throw new Error("SourcePawn compilation failed: " + (run.stderr || run.stdout || run.error?.message || run.status));
    }
    await fs.rename(temporary, output);
    process.stdout.write(run.stdout);
  } finally { await fs.rm(temporary, { force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options: Record<string, string> = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    if (!["--compiler-path", "--source-path", "--output-path"].includes(key) || !args[i + 1] || key in options) throw new Error("Invalid SourcePawn argument");
    options[key] = args[i + 1]!;
  }
  await buildSourcemod({ compilerPath: options["--compiler-path"], sourcePath: options["--source-path"], outputPath: options["--output-path"] });
}
