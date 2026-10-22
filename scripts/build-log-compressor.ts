import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertPlainPath } from "../src/desktop/main/serverManagedFiles.js";

const execute = promisify(execFile);
export const LZMA_SDK_SOURCE_SHA256 = "0266ecbfc2abb46fac570361be4361e5bde1819f93a7c2d7982b51b9e22750b1";
const requiredSdkFiles = ["C/7zVersion.h", "C/XzEnc.h", "C/XzEnc.c", "C/XzDec.c",
  "CPP/7zip/Bundles/Alone7z/makefile.gcc", "CPP/7zip/cmpl_gcc.mak",
  "CPP/7zip/var_gcc.mak", "CPP/7zip/7zip_gcc.mak", "DOC/lzma-sdk.txt"] as const;

export async function validateLzmaSdkRoot(sdkRoot: string): Promise<void> {
  if (!sdkRoot || !path.isAbsolute(sdkRoot)) throw new Error("lzma_sdk_path_invalid");
  await assertPlainPath(sdkRoot);
  for (const relative of requiredSdkFiles) {
    const target = path.join(sdkRoot, relative);
    await assertPlainPath(target);
    const info = await fs.lstat(target).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info?.isFile()) throw new Error("lzma_sdk_input_invalid");
  }
  const version = await fs.readFile(path.join(sdkRoot, "C/7zVersion.h"), "utf8");
  if (!/^#define MY_VERSION_NUMBERS "26[.]04"\r?$/m.test(version)) throw new Error("lzma_sdk_version_invalid");
}
async function sdkFiles(sdkRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(relative: string): Promise<void> {
    const absolute = path.join(sdkRoot, relative);
    await assertPlainPath(absolute);
    const info = await fs.lstat(absolute);
    if (info.isDirectory()) {
      for (const name of await fs.readdir(absolute)) await walk(relative + "/" + name);
    } else if (info.isFile()) files.push(relative);
    else throw new Error("lzma_sdk_input_invalid");
  }
  for (const name of ["C", "CPP", "DOC/lzma-sdk.txt"]) await walk(name);
  return files.sort();
}
export async function fingerprintLzmaSdkRoot(sdkRoot: string): Promise<string> {
  await validateLzmaSdkRoot(sdkRoot);
  const records: string[] = [];
  for (const relative of await sdkFiles(sdkRoot)) {
    const bytes = await fs.readFile(path.join(sdkRoot, relative));
    records.push(relative + "\0" + bytes.length + "\0" + createHash("sha256").update(bytes).digest("hex"));
  }
  records.sort();
  return createHash("sha256").update(records.join("\n") + "\n").digest("hex");
}

export interface BuiltLogCompressor {
  binaryPath: string;
  licensePath: string;
  version: "26.04";
  sourceSha256: string;
  dispose(): Promise<void>;
}
export async function buildLogCompressor(input: { sdkRoot: string; repositoryRoot: string }): Promise<BuiltLogCompressor> {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("log_compressor_native_linux_required");
  if (await fingerprintLzmaSdkRoot(input.sdkRoot) !== LZMA_SDK_SOURCE_SHA256) throw new Error("lzma_sdk_source_mismatch");
  const parent = path.join(input.repositoryRoot, ".local-tools");
  await assertPlainPath(parent);
  await fs.mkdir(parent, { recursive: true });
  const buildRoot = await fs.mkdtemp(path.join(parent, "log-compressor-"));
  const identity = await fs.lstat(buildRoot);
  const dispose = async (): Promise<void> => {
    await assertPlainPath(buildRoot);
    const current = await fs.lstat(buildRoot).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!current) return;
    if (path.dirname(buildRoot) !== parent || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error("log_compressor_cleanup_conflict");
    }
    await fs.rm(buildRoot, { recursive: true });
  };
  try {
    const sdk = path.join(buildRoot, "sdk");
    for (const relative of await sdkFiles(input.sdkRoot)) {
      const target = path.join(sdk, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(input.sdkRoot, relative), target, constants.COPYFILE_EXCL);
    }
    if (await fingerprintLzmaSdkRoot(sdk) !== LZMA_SDK_SOURCE_SHA256) throw new Error("lzma_sdk_source_mismatch");
    for (const command of ["make", "gcc", "g++"]) {
      const result = await execute(command, ["--version"], { windowsHide: true, timeout: 120000 });
      process.stderr.write(result.stdout.split("\n")[0] + "\n");
    }
    process.stderr.write("Log compressor build: " + buildRoot + "\n");
    const cwd = path.join(sdk, "CPP/7zip/Bundles/Alone7z");
    await execute("make", ["-j2", "-f", "../../cmpl_gcc.mak"], { cwd, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const binaryPath = path.join(cwd, "b/g/7zr");
    await assertPlainPath(binaryPath);
    if (!(await fs.lstat(binaryPath)).isFile()) throw new Error("log_compressor_type_invalid");
    await fs.chmod(binaryPath, 0o755);
    await probeLogCompressor(binaryPath);
    return { binaryPath, licensePath: path.join(sdk, "DOC/lzma-sdk.txt"), version: "26.04", sourceSha256: LZMA_SDK_SOURCE_SHA256, dispose };
  } catch (error) {
    await dispose().catch(cleanup => process.stderr.write("Log compressor cleanup failed: " + String(cleanup) + "\n"));
    throw error;
  }
}

export async function probeLogCompressor(executable: string): Promise<void> {
  if (!path.isAbsolute(executable)) throw new Error("log_compressor_path_invalid");
  await assertPlainPath(executable);
  const info = await fs.lstat(executable);
  if (!info.isFile()) throw new Error("log_compressor_type_invalid");
  if (process.platform === "linux") {
    await fs.access(executable, constants.X_OK);
    const handle = await fs.open(executable, "r");
    try {
      const header = Buffer.alloc(20);
      await handle.read(header, 0, header.length, 0);
      if (!header.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) || header.readUInt16LE(18) !== 62) {
        throw new Error("log_compressor_elf_invalid");
      }
    } finally { await handle.close(); }
    if ((info.mode & 0o777) !== 0o755) throw new Error("log_compressor_mode_invalid");
  }
  const run = (args: string[]) => execute(executable, args, { windowsHide: true, timeout: 120000, encoding: "buffer", maxBuffer: 1024 * 1024 });
  const formats = (await run(["i"])).stdout.toString("utf8");
  if (!/26[.]04/.test(formats) || !/\bxz\b/i.test(formats)) throw new Error("log_compressor_format_invalid");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "compet-xz-probe-"));
  try {
    const samples = [Buffer.alloc(0), Buffer.from("log\n中文\r\n"), Buffer.from(Array.from({ length: 256 }, (_, n) => n))];
    for (const [index, bytes] of samples.entries()) {
      const source = path.join(root, "sample-" + index);
      const archive = source + ".xz";
      await fs.writeFile(source, bytes, { mode: 0o600, flag: "wx" });
      await run(["a", "-txz", archive, source, "-mx=5", "-md=8m", "-mmt=1", "-bb0", "-bd", "-y"]);
      const encoded = await fs.readFile(archive);
      if (!encoded.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]))) throw new Error("log_compressor_xz_invalid");
      await run(["t", archive, "-bb0", "-bd"]);
      const decoded = (await run(["x", archive, "-so", "-bb0", "-bd"])).stdout;
      if (!decoded.equals(bytes)) throw new Error("log_compressor_roundtrip_invalid");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
