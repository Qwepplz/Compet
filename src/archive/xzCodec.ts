import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertPlainPath } from "../desktop/main/serverManagedFiles.js";
import type { ArchiveFingerprint } from "./singleFileTar.js";

export type LogFingerprint = ArchiveFingerprint;
export interface XzCodec {
  encode(sourcePath: string, targetPath: string): Promise<void>;
  fingerprintDecoded(archivePath: string): Promise<LogFingerprint>;
  cancel(): Promise<void>;
}
let slot: Promise<void> = Promise.resolve();
export async function archiveFile(file: string, links = 1n) {
  await assertPlainPath(file);
  const info = await fs.lstat(file, { bigint: true });
  if (!info.isFile() || info.nlink !== links) throw new Error("archive_file_invalid");
  return info;
}
export function sameArchiveIdentity(a: Awaited<ReturnType<typeof archiveFile>>, b: Awaited<ReturnType<typeof archiveFile>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}
async function compressedFile(file: string) {
  const info = await fs.lstat(file, { bigint: true });
  // Publication temporarily has final + the caller-owned attempt. Callers validate that pair before cleanup.
  return archiveFile(file, info.nlink === 2n ? 2n : 1n);
}
export async function checkXz(file: string): Promise<void> {
  const before = await compressedFile(file);
  const handle = await fs.open(file, constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
  try {
    if (!sameArchiveIdentity(before, await handle.stat({ bigint: true }))) throw new Error("archive_source_changed");
    const magic = Buffer.alloc(6); const { bytesRead } = await handle.read(magic, 0, 6, 0);
    if (bytesRead !== 6 || !magic.equals(Buffer.from([253, 55, 122, 88, 90, 0]))) throw new Error("archive_xz_invalid");
  } finally { await handle.close(); }
}
export class XzProcess {
  private cancelled = false;
  private readonly cancellation = new AbortController();
  private readonly active = new Map<ChildProcess, Promise<unknown>>();
  constructor(private readonly executable: string, private readonly timeoutMs = 120000) {
    if (!path.isAbsolute(executable)) throw new Error("log_compressor_path_invalid");
  }
  async run<T>(args: string[], input: AsyncIterable<Uint8Array> | undefined, consume: (output: AsyncIterable<Uint8Array>) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = slot, current = new Promise<void>(resolve => { release = resolve; });
    slot = previous.then(() => current);
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("log_archive_cancelled"));
      this.cancellation.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      if (this.cancelled) throw new Error("log_archive_cancelled");
      await Promise.race([previous, cancelled]);
      if (this.cancelled) throw new Error("log_archive_cancelled");
      await archiveFile(this.executable);
      if (this.cancelled) throw new Error("log_archive_cancelled");
      const child = spawn(this.executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let failure: unknown, diagnostics = Buffer.alloc(0), forced: NodeJS.Timeout | undefined;
      const terminate = (): void => {
        child.kill("SIGTERM");
        forced ??= setTimeout(() => child.kill("SIGKILL"), 1000);
        forced.unref();
      };
      const fail = (error: unknown): void => { failure ??= error; terminate(); };
      const closed = new Promise<number | null>(resolve => {
        child.once("error", fail); child.once("close", resolve);
      });
      this.active.set(child, closed);
      child.stderr!.on("data", (bytes: Buffer) => {
        if (diagnostics.length < 32768) diagnostics = Buffer.concat([diagnostics, bytes.subarray(0, 32768 - diagnostics.length)]);
      });
      child.stderr!.on("error", fail);
      const timer = setTimeout(() => fail(new Error("log_archive_process_timeout")), this.timeoutMs);
      const guarded = async <R>(operation: () => Promise<R>): Promise<R> => {
        try { return await operation(); } catch (error) { fail(error); throw error; }
      };
      try {
        const output = guarded(() => consume(child.stdout!));
        const feeding = guarded(async () => {
          if (input) await pipeline(Readable.from(input), child.stdin!);
          else { child.stdin!.on("error", fail); child.stdin!.end(); }
        });
        const [view, , exit] = await Promise.allSettled([output, feeding, closed]);
        if (failure) throw failure;
        if (this.cancelled) throw new Error("log_archive_cancelled");
        if (exit.status !== "fulfilled" || exit.value !== 0) throw new Error("log_archive_process_failed: " + (exit.status === "fulfilled" ? exit.value : "?") + " " + diagnostics.toString("utf8"));
        if (view.status !== "fulfilled") throw view.reason;
        return view.value;
      } finally {
        clearTimeout(timer); if (forced) clearTimeout(forced);
        this.active.delete(child);
      }
    } finally { this.cancellation.signal.removeEventListener("abort", abort); release(); }
  }
  async encode(input: AsyncIterable<Uint8Array>, targetPath: string): Promise<void> {
    await assertPlainPath(targetPath);
    const handle = await fs.open(targetPath, "wx", 0o600);
    try {
      await this.run(["a", "-txz", "-an", "-si", "-so", "-mx=5", "-md=8m", "-mmt=1", "-bb0", "-bd"], input, async output => {
        for await (const chunk of output) {
          let offset = 0;
          while (offset < chunk.length) {
            const written = await handle.write(chunk, offset, chunk.length - offset);
            if (!written.bytesWritten) throw new Error("archive_write_failed");
            offset += written.bytesWritten;
          }
        }
      });
      await handle.sync();
    } finally { await handle.close(); }
  }
  async decode<T>(archivePath: string, consume: (output: AsyncIterable<Uint8Array>) => Promise<T>): Promise<T> {
    const before = await compressedFile(archivePath); await checkXz(archivePath);
    const view = await this.run(["x", archivePath, "-so", "-bb0", "-bd"], undefined, consume);
    if (!sameArchiveIdentity(before, await compressedFile(archivePath))) throw new Error("archive_source_changed");
    return view;
  }
  async cancel(): Promise<void> {
    this.cancelled = true; this.cancellation.abort();
    await Promise.all([...this.active].map(async ([child, closed]) => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      try { await closed; } finally { clearTimeout(timer); }
    }));
  }
}
export class SevenZipXzCodec implements XzCodec {
  private readonly process: XzProcess;
  constructor(executable: string) { this.process = new XzProcess(executable); }
  async encode(sourcePath: string, targetPath: string): Promise<void> {
    const before = await archiveFile(sourcePath), handle = await fs.open(sourcePath, constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
    try {
      if (!sameArchiveIdentity(before, await handle.stat({ bigint: true }))) throw new Error("archive_source_changed");
      await this.process.encode(handle.createReadStream({ autoClose: false }), targetPath);
      if (!sameArchiveIdentity(before, await handle.stat({ bigint: true })) || !sameArchiveIdentity(before, await archiveFile(sourcePath))) throw new Error("archive_source_changed");
    } finally { await handle.close(); }
  }
  fingerprintDecoded(archivePath: string): Promise<LogFingerprint> {
    return this.process.run(["x", archivePath, "-so", "-bb0", "-bd"], undefined, async output => {
      let size = 0; const hash = createHash("sha256");
      for await (const chunk of output) { size += chunk.length; hash.update(chunk); }
      return { size, sha256: hash.digest("hex") };
    });
  }
  cancel(): Promise<void> { return this.process.cancel(); }
}
