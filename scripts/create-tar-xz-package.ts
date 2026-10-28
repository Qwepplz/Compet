import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { XzProcess } from "../src/archive/xzCodec.js";
import { assertPlainPath } from "../src/desktop/main/serverManagedFiles.js";

const execute = promisify(execFile);
const timeoutMs = 600000;
async function withTarWorkspace(parent: string, compressorPath: string, operation: (tarPath: string, codec: XzProcess) => Promise<void>): Promise<void> {
  await assertPlainPath(parent);
  const codec = new XzProcess(compressorPath, timeoutMs);
  const root = await fs.mkdtemp(path.join(parent, "package-tar-xz-"));
  const identity = await fs.lstat(root);
  const errors: unknown[] = [];
  try { await operation(path.join(root, "payload.tar"), codec); }
  catch (error) { errors.push(error); }
  try { await codec.cancel(); } catch (error) { errors.push(error); }
  try {
    await assertPlainPath(root);
    const current = await fs.lstat(root);
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("package_tar_cleanup_conflict");
    await fs.rm(root, { recursive: true });
  } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "package_tar_operation_or_cleanup_failed: " + errors.map(String).join("; "));
}
async function tar(args: string[]): Promise<void> {
  const result = await execute("tar", args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  if (result.stderr) process.stderr.write(result.stderr);
}
export async function createTarXzPackage(input: {
  sourceRoot: string;
  targetPath: string;
  compressorPath: string;
}): Promise<void> {
  await assertPlainPath(input.sourceRoot); await assertPlainPath(input.targetPath);
  const parent = path.dirname(input.targetPath), relative = path.relative(input.sourceRoot, parent);
  if (!relative || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep)) throw new Error("package_tar_workspace_inside_source");
  // Refuse existing outputs before invoking tar; encode also uses wx to close the race.
  const existing = await fs.lstat(input.targetPath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (existing) throw Object.assign(new Error("EEXIST: package target exists"), { code: "EEXIST" });
  await withTarWorkspace(parent, input.compressorPath, async (tarPath, codec) => {
    await tar(["-cf", tarPath, "-C", input.sourceRoot, "."]);
    const handle = await fs.open(tarPath, "r");
    const errors: unknown[] = [];
    try { await codec.encode(handle.createReadStream({ autoClose: false }), input.targetPath); }
    catch (error) { errors.push(error); }
    try { await codec.cancel(); } catch (error) { errors.push(error); }
    try { await handle.close(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "package_tar_encode_failed: " + errors.map(String).join("; "));
  });
}
export async function extractTarXzPackage(input: {
  archivePath: string;
  targetRoot: string;
  compressorPath: string;
}): Promise<void> {
  await assertPlainPath(input.archivePath); await assertPlainPath(input.targetRoot);
  if (!(await fs.lstat(input.targetRoot)).isDirectory() || (await fs.readdir(input.targetRoot)).length) throw new Error("package_extract_target_not_empty");
  await withTarWorkspace(path.dirname(input.archivePath), input.compressorPath, async (tarPath, codec) => {
    const handle = await fs.open(tarPath, "wx", 0o600);
    const errors: unknown[] = [];
    try {
      await codec.decode(input.archivePath, async output => {
        for await (const chunk of output) {
          let offset = 0;
          while (offset < chunk.length) {
            const written = await handle.write(chunk, offset, chunk.length - offset);
            if (!written.bytesWritten) throw new Error("archive_write_failed");
            offset += written.bytesWritten;
          }
        }
      });
    } catch (error) { errors.push(error); }
    try { await codec.cancel(); } catch (error) { errors.push(error); }
    try { await handle.close(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "package_tar_decode_failed: " + errors.map(String).join("; "));
    await tar(["-xf", tarPath, "-C", input.targetRoot]);
  });
}
