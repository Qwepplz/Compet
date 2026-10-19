import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { repositoryRoot } from "./build-sourcemod.js";
import { buildServer } from "./build-server.js";
import { createPackageInventory, verifyPackageInventory } from "./create-package-inventory.js";
import { createServerUpdateFeed } from "./create-server-update-feed.js";
import { assertPlainPath, fingerprintFile } from "../src/desktop/main/serverManagedFiles.js";
import { resolveServerLayout, type ServerPlatform } from "../src/shared/serverPackageLayout.js";
import { isSemver } from "../src/shared/version.js";
export interface PackageOptions { platform: ServerPlatform; requiredClientVersion: string; artifactsDir: string }
export function parsePackageOptions(args: string[]): PackageOptions {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    if (!["--platform", "--required-client-version", "--artifacts-dir"].includes(key) || !args[i + 1] || key in values) throw new Error("Invalid package argument: " + key);
    values[key] = args[i + 1]!;
  }
  const requiredClientVersion = values["--required-client-version"];
  if (!requiredClientVersion || !isSemver(requiredClientVersion)) throw new Error("Invalid or missing required-client-version");
  const platform = values["--platform"] ?? process.platform + "-" + process.arch;
  if (!["win32-x64", "linux-x64"].includes(platform)) throw new Error("Unsupported platform");
  if (platform !== process.platform + "-" + process.arch) throw new Error("Package platform must match native host");
  return { platform: platform as ServerPlatform, requiredClientVersion, artifactsDir: path.resolve(values["--artifacts-dir"] ?? path.join(repositoryRoot, "artifacts")) };
}
export async function validateArtifactsDirectory(directory: string): Promise<void> {
  const relative = path.relative(path.join(repositoryRoot, "artifacts"), directory);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) throw new Error("Output must be inside repository artifacts");
  if (["compet-server", "compet-client"].includes(relative.split(path.sep)[0]?.toLowerCase() ?? "")) throw new Error("Output overlaps protected user runtime instance");
  await assertPlainPath(directory);
}
export function validateProfileSeed(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.entries(raw).some(([key, value]) =>
    /^[0-9]{17}$/.test(key) && value && typeof value.personaName === "string" && value.personaName.trim())) throw new Error("Invalid profile seed");
}
export async function readServerPackageMetadata(requiredClientVersion: string, root = repositoryRoot): Promise<{ name: "compet-server-manager"; version: string; requiredClientVersion: string; [key: string]: unknown }> {
  if (!isSemver(requiredClientVersion)) throw new Error("Invalid required-client-version");
  const metadata = JSON.parse(await fs.readFile(path.join(root, "packaging/server/app-package.json"), "utf8"));
  if (metadata.name !== "compet-server-manager" || !isSemver(metadata.version)) throw new Error("package_identity_invalid");
  return { ...metadata, requiredClientVersion };
}
export async function validatePackageSources(root: string, platform: ServerPlatform): Promise<void> {
  const required = ["src/main.ts", "src/cli/main.ts", "src/sourcemod/compet_match_lock.sp",
    "packaging/server/app-package.json", "packaging/server/profile-seed/human-index.json",
    "src/mysql_preinit/compet_mysql_preinit" + (platform === "win32-x64" ? ".ps1" : ".sh"),
    ...(platform === "win32-x64" ? ["src/mysql_preinit/compet_mysql_preinit.cmd", "packaging/assets/compet-icon.ico"] : [])];
  for (const relative of required) {
    const file = path.join(root, relative); await assertPlainPath(file);
    if (!await fs.stat(file).then(info => info.isFile(), () => false)) throw new Error("Missing required path: " + relative);
  }
  validateProfileSeed(JSON.parse(await fs.readFile(path.join(root, "packaging/server/profile-seed/human-index.json"), "utf8")));
}
export async function copyManualMysqlEntries(root: string, appRoot: string, platform: ServerPlatform): Promise<void> {
  const names = platform === "win32-x64" ? ["compet_mysql_preinit.ps1", "compet_mysql_preinit.cmd"] : ["compet_mysql_preinit.sh"];
  for (const name of names) await copy(path.join(root, "src/mysql_preinit", name), path.join(appRoot, "mysql_preinit", name));
}
function run(executable: string, args: string[], cwd = repositoryRoot, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(executable, args, { cwd, env, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("Command failed: " + executable + "\n" + result.stdout + result.stderr + (result.error?.message ?? ""));
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}
async function copy(source: string, target: string): Promise<void> {
  await assertPlainPath(source); await assertPlainPath(target);
  const info = await fs.lstat(source);
  if (info.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const name of await fs.readdir(source)) await copy(path.join(source, name), path.join(target, name));
  } else if (info.isFile()) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target); }
  else throw new Error("package_source_type_invalid");
}
async function pruneModules(root: string, platform: ServerPlatform): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name);
    await assertPlainPath(item);
    if (entry.isDirectory()) {
      if (["src", "test", "tests", "example", "examples", ".github"].includes(entry.name) ||
          /^(win32|linux|darwin|freebsd|android)-/.test(entry.name) && entry.name !== platform) await fs.rm(item, { recursive: true, force: true });
      else await pruneModules(item, platform);
    } else if (/\.(?:ts|cts|mts|map|cpp|cc|h|md)$|^binding\.gyp$/.test(entry.name)) await fs.unlink(item);
  }
}
async function copyRuntimeModules(appRoot: string, platform: ServerPlatform): Promise<void> {
  const copied = new Set<string>();
  async function dependency(name: string): Promise<void> {
    if (copied.has(name)) return;
    copied.add(name);
    const source = path.join(repositoryRoot, "node_modules", name);
    const metadata = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
    const destination = path.join(appRoot, "node_modules", name);
    if (name === "node-pty") {
      // node-addon-api and deps/winpty are build inputs, never runtime assets.
      for (const relative of ["package.json", "LICENSE", "lib", "build/Release/pty.node"]) {
        await copy(path.join(source, relative), path.join(destination, relative));
      }
    } else {
      await copy(source, destination);
      for (const child of Object.keys(metadata.dependencies ?? {})) await dependency(child);
    }
  }
  for (const name of ["argon2", "zod", ...(platform === "linux-x64" ? ["node-pty"] : [])]) await dependency(name);
  await pruneModules(path.join(appRoot, "node_modules"), platform);
}
async function pinnedNode(platform: ServerPlatform): Promise<string> {
  const versions = JSON.parse(await fs.readFile(path.join(repositoryRoot, "packaging/server/runtime-versions.json"), "utf8"));
  if (process.versions.node !== versions.node.version) throw new Error("Build requires Node " + versions.node.version);
  const expected = versions.node.platforms[platform];
  if (!/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error("node_archive_fingerprint_invalid");
  const cache = path.join(repositoryRoot, ".local-tools/runtime-cache", platform);
  await assertPlainPath(cache); await fs.mkdir(cache, { recursive: true });
  const archive = path.join(cache, path.basename(new URL(expected.url).pathname));
  let bytes = await fs.readFile(archive).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
    const response = await fetch(expected.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || response.url !== expected.url) throw new Error("node_archive_download_failed");
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new Error("node_archive_fingerprint_invalid");
    await fs.writeFile(archive, bytes, { mode: 0o600 });
  }
  const extracted = path.join(cache, "extracted");
  await assertPlainPath(extracted);
  await fs.mkdir(extracted, { recursive: true });
  if (platform === "win32-x64") {
    const quote = (value: string) => "\u0027" + value.replaceAll("\u0027", "\u0027\u0027") + "\u0027";
    const command = "$ErrorActionPreference=\u0027Stop\u0027; $ProgressPreference=\u0027SilentlyContinue\u0027; Expand-Archive -LiteralPath " + quote(archive) + " -DestinationPath " + quote(extracted) + " -Force";
    run("pwsh", ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")]);
  }
  else run("tar", ["-xJf", archive, "-C", extracted]);
  const node = path.join(extracted, "node-v" + versions.node.version + (platform === "win32-x64" ? "-win-x64/node.exe" : "-linux-x64/bin/node"));
  if (run(node, ["-p", "process.versions.node"]).trim() !== versions.node.version) throw new Error("packaged_node_version_mismatch");
  if ((await fingerprintFile(node))?.sha256 !== (await fingerprintFile(process.execPath))?.sha256) throw new Error("build_node_differs_from_pinned_runtime");
  return node;
}
async function normalizeModes(root: string): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    await assertPlainPath(absolute);
    if (entry.isDirectory()) { await fs.chmod(absolute, 0o755); await normalizeModes(absolute); }
    else {
      const info = await fs.stat(absolute), bytes = await fs.readFile(absolute);
      await fs.chmod(absolute, info.mode & 0o111 || bytes.subarray(0, 4).equals(Buffer.from([127,69,76,70])) || /\.(?:sh|node)$/.test(entry.name) || absolute.endsWith(path.sep + "compet") ? 0o755 : 0o644);
    }
  }
}
async function probePackage(root: string, platform: ServerPlatform): Promise<void> {
  const layout = resolveServerLayout({ installRoot: root, platform });
  const source = 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(":memory:"); db.exec("SELECT 1"); db.close(); const a=require("argon2"); a.hash("package-probe").then(h=>a.verify(h,"package-probe")).then(ok=>{if(!ok)throw Error("argon2"); console.log(JSON.stringify({node:process.versions.node,abi:process.versions.modules,sqlite:process.versions.sqlite}));});';
  const env = { ...process.env }; for (const key of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  process.stdout.write(run(layout.nodePath, ["-e", source], layout.appRoot, env));
  if (platform === "linux-x64") {
    const pty = 'const p=require("node-pty").spawn("/bin/sh",["-c","test -t 0 && printf COMPET_PTY_OK"],{name:"xterm",cols:80,rows:24,cwd:process.cwd(),env:process.env});let text="";p.onData(s=>text+=s);p.onExit(e=>{if(e.exitCode!==0||!text.includes("COMPET_PTY_OK"))process.exitCode=1;else console.log("COMPET_PTY_OK")});';
    process.stdout.write(run(layout.nodePath, ["-e", pty], layout.appRoot, env));
  }
  process.stdout.write(run(layout.nodePath, [layout.cliEntry, "--help"], os.tmpdir(), env));
  for (const name of ["plan.json", "plan.txt"]) {
    const result = spawnSync(layout.nodePath, [layout.workerEntry, "--plan", path.join(root, "absent", name), "--mode", "validate"], { env, windowsHide: true, encoding: "utf8" });
    if (result.status !== 1 || !result.stderr.trim()) throw new Error("packaged_worker_entry_invalid");
  }
  const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "compet-package-config-"));
  try {
    const config = JSON.parse(await fs.readFile(path.join(repositoryRoot, "packaging/server/linux/server.example.json"), "utf8"));
    config.dataDir = path.join(probeRoot, "data"); config.gameServer.serverRoot = path.join(probeRoot, "game");
    const configPath = path.join(probeRoot, "server.json");
    await fs.writeFile(configPath, JSON.stringify(config));
    for (const key of Object.keys(env)) if (key.startsWith("COMPET_")) delete env[key];
    process.stdout.write(run(layout.nodePath, [layout.cliEntry, "config", "check", "--config", configPath, "--json"], os.tmpdir(), env));
    if ((await fs.readdir(probeRoot)).join() !== "server.json") throw new Error("config_check_wrote_data");
  } finally { await fs.rm(probeRoot, { recursive: true, force: true }); }
}
export async function packageServer(options: PackageOptions): Promise<void> {
  await validateArtifactsDirectory(options.artifactsDir);
  const stage = path.join(options.artifactsDir, "staging", options.platform);
  await assertPlainPath(stage);
  await validatePackageSources(repositoryRoot, options.platform);
  const metadata = await readServerPackageMetadata(options.requiredClientVersion);
  // SourcePawn must complete before build output, staging or existing archives are removed.
  await buildServer();
  const node = await pinnedNode(options.platform);
  if (options.platform === "linux-x64") {
    const release = await fs.readFile("/etc/os-release", "utf8");
    const version = /VERSION_ID="([0-9.]+)"/.exec(release)?.[1];
    if (!release.includes("ID=ubuntu") || !version || Number(version) > 26.04) throw new Error("Linux release build requires Ubuntu baseline <=26.04");
  } else run(process.execPath, [path.join(repositoryRoot, "node_modules/electron-vite/bin/electron-vite.js"), "build"]);
  await fs.rm(stage, { recursive: true, force: true }); await fs.mkdir(stage, { recursive: true });
  const layout = resolveServerLayout({ platform: options.platform, installRoot: stage });
  await fs.mkdir(path.dirname(layout.nodePath), { recursive: true }); await copy(node, layout.nodePath);
  await fs.mkdir(path.dirname(layout.workerEntry), { recursive: true });
  if (options.platform === "win32-x64") {
    const electron = path.join(stage, "runtime/electron");
    await copy(path.join(repositoryRoot, "node_modules/electron/dist"), electron);
    await fs.rm(path.join(electron, "resources/default_app.asar"), { force: true });
    const locales = path.join(electron, "locales");
    for (const name of await fs.readdir(locales)) if (!["en-US.pak", "zh-CN.pak"].includes(name)) await fs.unlink(path.join(locales, name));
    await copy(path.join(repositoryRoot, "out"), path.join(layout.appRoot, "out"));
    await copy(path.join(repositoryRoot, "packaging/server/runtime/7zr.exe"), path.join(layout.appRoot, "runtime/7z/7zr.exe"));
    run("pwsh", ["-NoProfile", "-File", path.join(repositoryRoot, "scripts/package-server-windows-resources.ps1"), "-Stage", stage, "-Version", JSON.parse(await fs.readFile(path.join(repositoryRoot, "packaging/server/app-package.json"), "utf8")).version]);
    await copy(path.join(repositoryRoot, "packaging/server/windows/compet.cmd"), path.join(stage, "compet.cmd"));
  } else {
    await copy(path.join(repositoryRoot, "packaging/server/linux/compet"), path.join(stage, "bin/compet"));
    await copy(path.join(repositoryRoot, "packaging/server/linux/compet.service"), path.join(stage, "systemd/compet.service"));
    await copy(path.join(repositoryRoot, "packaging/server/linux/server.example.json"), path.join(stage, "server.example.json"));
  }
  await fs.mkdir(layout.appRoot, { recursive: true });
  await fs.writeFile(path.join(layout.appRoot, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
  await copy(path.join(repositoryRoot, "packaging/server/profile-seed/human-index.json"), path.join(layout.appRoot, "runtime/profiles/human-index.json"));
  await copy(path.join(repositoryRoot, "src/sourcemod/compet_match_lock.smx"), path.join(layout.appRoot, "sourcemod/compet_match_lock.smx"));
  await copy(path.join(repositoryRoot, "src/run_csgo"), path.join(layout.appRoot, "run_csgo"));
  const otherExtension = options.platform === "linux-x64" ? ".ps1" : ".sh";
  await fs.unlink(path.join(layout.appRoot, "run_csgo/run_csgo" + otherExtension));
  await copyManualMysqlEntries(repositoryRoot, layout.appRoot, options.platform);
  for (const [entry, outfile] of [["src/main.ts", layout.serviceEntry], ["src/cli/main.ts", layout.cliEntry], ["scripts/server-worker-entry.ts", layout.workerEntry]]) {
    await build({ entryPoints: [path.join(repositoryRoot, entry!)], outfile, bundle: true, platform: "node", format: "cjs", target: "node24", external: ["argon2", "node-pty"], logLevel: "warning" });
  }
  await copyRuntimeModules(layout.appRoot, options.platform);
  if (options.platform === "linux-x64") await normalizeModes(stage);
  await probePackage(stage, options.platform);
  await createPackageInventory(stage, metadata.version, options.platform);
  await verifyPackageInventory(stage, metadata.version, options.platform);
  const archive = path.join(options.artifactsDir, options.platform === "win32-x64" ? "Compet-Server-win32-x64.7z" : "Compet-Server-linux-x64.tar.gz");
  const temporary = archive + ".tmp";
  await assertPlainPath(archive); await assertPlainPath(temporary); await fs.rm(temporary, { force: true });
  try {
    if (options.platform === "win32-x64") {
      const sevenZip = path.join(repositoryRoot, ".local-tools/7zr.exe");
      run(sevenZip, ["a", "-t7z", temporary, ".", "-r", "-mx=7", "-bb0", "-bd", "-y"], stage);
      run(sevenZip, ["t", temporary, "-bb0", "-bd", "-y"]);
    } else run("tar", ["-czf", temporary, "-C", stage, "."]);
    const unpack = await fs.mkdtemp(path.join(options.artifactsDir, "package-verify-"));
    try {
      if (options.platform === "win32-x64") run(path.join(repositoryRoot, ".local-tools/7zr.exe"), ["x", temporary, "-o" + unpack, "-y"]);
      else run("tar", ["-xzf", temporary, "-C", unpack]);
      await verifyPackageInventory(unpack, metadata.version, options.platform);
      await probePackage(unpack, options.platform);
    } finally { await fs.rm(unpack, { recursive: true, force: true }); }
    await createServerUpdateFeed({ packageRoot: stage, outputRoot: path.join(options.artifactsDir, "update/server"), platform: options.platform, version: metadata.version, baseUrl: process.env.COMPET_SERVER_UPDATE_BASE_URL ?? "https://qwepplz111.site/update/server/" });
    await fs.rename(temporary, archive);
    process.stdout.write(JSON.stringify({ archive, ...(await fingerprintFile(archive)), platform: options.platform, requiredClientVersion: options.requiredClientVersion }) + "\n");
  } finally { await fs.rm(temporary, { force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await packageServer(parsePackageOptions(process.argv.slice(2)));
