import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LogFingerprint, XzCodec } from "../archive/xzCodec.js";
import { readArchiveMetadata, type TarXzCodec } from "../archive/tarXzCodec.js";
import type { ArchiveMetadata } from "../archive/singleFileTar.js";
export { SevenZipXzCodec } from "../archive/xzCodec.js";
export type { LogFingerprint, XzCodec } from "../archive/xzCodec.js";
import type { LogArchiver } from "../manager/main/logStore.js";
import { assertPlainPath } from "../desktop/main/serverManagedFiles.js";

export interface XzArchiverOptions { onError(error: unknown): void; legacyCodec?: XzCodec }
const magic = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]);
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const archivePattern = "(\\d{4}-\\d{2}-\\d{2})(?:\\.part-" + uuid + ")?\\.log(?:\\.tar)?\\.xz";
const pendingPattern = new RegExp("^\\.compet-(" + archivePattern + ")\\.pending$");
const attemptPattern = new RegExp("^\\.compet-(" + archivePattern + ")\\.attempt-" + uuid + "\\.tmp\\.xz$");
function validDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}
async function stat(file: string) {
  await assertPlainPath(file);
  return fs.lstat(file, { bigint: true }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
}
async function plain(file: string, links = 1n) {
  const info = await stat(file);
  if (!info?.isFile() || info.nlink !== links) throw new Error("log_archive_file_invalid");
  return info;
}
type Identity = Awaited<ReturnType<typeof plain>>;
function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function sameBytes(a: LogFingerprint, b: LogFingerprint): boolean { return a.size === b.size && a.sha256 === b.sha256; }
async function sourceFingerprint(file: string): Promise<{ identity: Identity; fingerprint: LogFingerprint }> {
  const before = await plain(file);
  const handle = await fs.open(file, constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW : 0));
  try {
    const identity = await handle.stat({ bigint: true });
    if (!sameIdentity(before, identity) || identity.nlink !== 1n) throw new Error("log_archive_source_changed");
    const hash = createHash("sha256"); let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; hash.update(chunk); }
    if (!sameIdentity(identity, await handle.stat({ bigint: true })) || !sameIdentity(identity, await plain(file))) throw new Error("log_archive_source_changed");
    return { identity, fingerprint: { size, sha256: hash.digest("hex") } };
  } finally { await handle.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform !== "linux") return;
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export class XzLogArchiver implements LogArchiver {
  private queue = Promise.resolve();
  private readonly queued = new Set<string>();
  private failures: unknown[] = [];
  private stopped = false;
  private cancelled = false;
  private closing?: Promise<void>;
  constructor(private readonly logDir: string, private readonly codec: TarXzCodec, private readonly options: XzArchiverOptions) {}
  private report(error: unknown): void {
    this.failures.push(error);
    try { this.options.onError(error); } catch { /* Diagnostics must not break recovery. */ }
  }
  async archiveBefore(utcDay: string): Promise<void> {
    if (!validDay(utcDay)) throw new Error("log_archive_day_invalid");
    if (this.stopped) return;
    await assertPlainPath(this.logDir);
    await fs.mkdir(this.logDir, { recursive: true, mode: 0o700 });
    const names = (await fs.readdir(this.logDir)).sort();
    for (const name of names) {
      if (this.stopped) break;
      const pending = pendingPattern.exec(name);
      if (pending && validDay(pending[2]!)) {
        try {
          let archive = pending[1]!;
          if (!archive.endsWith(".tar.xz") && !await stat(path.join(this.logDir, archive))) {
            const old = path.join(this.logDir, name), migrated = archive.replace(/\.xz$/, ".tar.xz");
            const target = path.join(this.logDir, ".compet-" + migrated + ".pending");
            await plain(old);
            if (await stat(target) || await stat(path.join(this.logDir, migrated))) throw new Error("log_archive_conflict");
            await fs.rename(old, target); await syncDirectory(this.logDir);
            archive = migrated;
          }
          this.enqueue(archive);
        } catch (error) { this.report(error); }
        continue;
      }
      const match = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (!match || !validDay(match[1]!) || match[1]! >= utcDay) continue;
      try {
        const source = path.join(this.logDir, name);
        await plain(source);
        const primary = name + ".tar.xz";
        const prefix = ".compet-" + primary;
        const usePrimary = !await stat(path.join(this.logDir, primary)) &&
          !(await fs.readdir(this.logDir)).some(n => n === prefix + ".pending" || n.startsWith(prefix + ".attempt-"));
        const archive = usePrimary ? primary : match[1] + ".part-" + randomUUID() + ".log.tar.xz";
        const target = path.join(this.logDir, ".compet-" + archive + ".pending");
        if (await stat(target)) throw new Error("log_archive_conflict");
        const handle = await fs.open(source, process.platform === "linux" ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_RDWR);
        try {
          const identity = await handle.stat({ bigint: true });
          if (!identity.isFile() || identity.nlink !== 1n || !sameIdentity(identity, await plain(source))) throw new Error("log_archive_source_changed");
          await handle.sync();
        } finally { await handle.close(); }
        await fs.rename(source, target);
        await syncDirectory(this.logDir);
        this.enqueue(archive);
      } catch (error) { this.report(error); }
    }
    // Published links can survive a crash after source cleanup.
    for (const name of names) {
      const match = attemptPattern.exec(name);
      if (!match || !validDay(match[2]!) || this.queued.has(match[1]!)) continue;
      const archive = match[1]!;
      if (await stat(path.join(this.logDir, ".compet-" + archive + ".pending"))) continue;
      this.queue = this.queue.then(() => this.cleanupPublishedAttempt(archive, name)).catch(error => this.report(error));
    }
  }
  private enqueue(archive: string): void {
    if (this.queued.has(archive)) return;
    this.queued.add(archive);
    this.queue = this.queue.then(async () => {
      if (!this.cancelled) await this.process(archive);
    }).catch(error => this.report(error)).finally(() => this.queued.delete(archive));
  }
  private async publishedLinks(archive: string): Promise<string[]> {
    const final = path.join(this.logDir, archive), info = await stat(final);
    if (!info?.isFile()) throw new Error("log_archive_conflict");
    const matches: string[] = [];
    for (const name of await fs.readdir(this.logDir)) {
      const match = attemptPattern.exec(name);
      if (match?.[1] !== archive) continue;
      const candidate = await stat(path.join(this.logDir, name));
      if (candidate?.isFile() && candidate.dev === info.dev && candidate.ino === info.ino) matches.push(name);
    }
    if (info.nlink !== BigInt(matches.length + 1)) throw new Error("log_archive_conflict");
    return matches;
  }
  private async decoded(archive: string, file: string, metadata?: ArchiveMetadata): Promise<LogFingerprint> {
    if (!archive.endsWith(".tar.xz")) {
      if (!this.options.legacyCodec) throw new Error("log_archive_legacy_codec_missing");
      return this.options.legacyCodec.fingerprintDecoded(file);
    }
    const view = await this.codec.inspect(file);
    if (view.memberName !== archive.slice(0, 10) + ".log" ||
        metadata && (view.metadata.birthtimeNs !== metadata.birthtimeNs || view.metadata.mtimeNs !== metadata.mtimeNs)) throw new Error("log_archive_metadata_mismatch");
    return view;
  }
  private async verifiedFinal(archive: string, metadata?: ArchiveMetadata): Promise<LogFingerprint> {
    const final = path.join(this.logDir, archive);
    await this.publishedLinks(archive);
    const before = await stat(final);
    const handle = await fs.open(final, constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW : 0));
    try {
      if (!before || !sameIdentity(before, await handle.stat({ bigint: true }))) throw new Error("log_archive_conflict");
      const header = Buffer.alloc(magic.length);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead !== magic.length || !header.equals(magic)) throw new Error("log_archive_xz_invalid");
    } finally { await handle.close(); }
    const result = await this.decoded(archive, final, metadata);
    if (!before || !sameIdentity(before, await plain(final, before.nlink))) throw new Error("log_archive_conflict");
    return result;
  }
  private async cleanupPublishedAttempt(archive: string, name: string): Promise<void> {
    const final = path.join(this.logDir, archive), temporary = path.join(this.logDir, name);
    const a = await stat(final), b = await stat(temporary);
    if (!a || !b || a.dev !== b.dev || a.ino !== b.ino) {
      throw new Error("log_archive_orphan_attempt");
    }
    await this.verifiedFinal(archive);
    const current = await stat(temporary), published = await stat(final);
    if (!current || !published || current.dev !== published.dev || current.ino !== published.ino) throw new Error("log_archive_conflict");
    await fs.unlink(temporary); await syncDirectory(this.logDir);
  }
  private async process(archive: string): Promise<void> {
    const pending = path.join(this.logDir, ".compet-" + archive + ".pending"), final = path.join(this.logDir, archive);
    const before = await sourceFingerprint(pending);
    const metadata = archive.endsWith(".tar.xz") ? await readArchiveMetadata(pending) : undefined;
    if (await stat(final)) {
      if (!sameBytes(await this.verifiedFinal(archive, metadata), before.fingerprint)) throw new Error("log_archive_conflict");
      const after = await sourceFingerprint(pending);
      if (!sameIdentity(before.identity, after.identity) || !sameBytes(before.fingerprint, after.fingerprint)) throw new Error("log_archive_source_changed");
      await syncDirectory(this.logDir);
      await fs.unlink(pending); await syncDirectory(this.logDir);
      for (const name of await this.publishedLinks(archive)) await this.cleanupPublishedAttempt(archive, name);
      return;
    }
    for (const name of await fs.readdir(this.logDir)) {
      if (attemptPattern.exec(name)?.[1] === archive) {
        try { this.options.onError(new Error("log_archive_orphan_attempt")); } catch { /* Preserve unknown outputs. */ }
      }
    }
    const temporary = path.join(this.logDir, ".compet-" + archive + ".attempt-" + randomUUID() + ".tmp.xz");
    if (await stat(temporary)) throw new Error("log_archive_conflict");
    let temporaryIdentity: Identity | undefined;
    try {
      if (!metadata) throw new Error("log_archive_legacy_encode_forbidden");
      await this.codec.encode({ sourcePath: pending, memberName: archive.slice(0, 10) + ".log", metadata }, temporary);
      temporaryIdentity = await plain(temporary);
      if (this.cancelled) throw new Error("log_archive_cancelled");
      const after = await sourceFingerprint(pending);
      if (!sameIdentity(before.identity, after.identity) || !sameBytes(before.fingerprint, after.fingerprint)) throw new Error("log_archive_source_changed");
      const handle = await fs.open(temporary, process.platform === "linux" ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_RDWR);
      try {
        const identity = await handle.stat({ bigint: true });
        if (!identity.isFile() || identity.nlink !== 1n || !sameIdentity(identity, await plain(temporary))) throw new Error("log_archive_file_invalid");
        const header = Buffer.alloc(6);
        await handle.read(header, 0, 6, 0);
        if (!header.equals(magic)) throw new Error("log_archive_xz_invalid");
        await handle.sync();
      } finally { await handle.close(); }
      const encoded = await plain(temporary);
      if (!sameBytes(await this.decoded(archive, temporary, metadata), before.fingerprint)) throw new Error("log_archive_content_mismatch");
      if (!sameIdentity(encoded, await plain(temporary)) || !sameIdentity(before.identity, (await sourceFingerprint(pending)).identity)) throw new Error("log_archive_source_changed");
      await fs.link(temporary, final);
      await syncDirectory(this.logDir);
      if (!sameBytes(await this.verifiedFinal(archive, metadata), before.fingerprint) ||
          !sameIdentity(before.identity, (await sourceFingerprint(pending)).identity)) throw new Error("log_archive_conflict");
      await fs.unlink(pending); await syncDirectory(this.logDir);
      await this.cleanupPublishedAttempt(archive, path.basename(temporary));
    } catch (error) {
      // Failed encoders may leave an output whose identity was never confirmed.
      const tmp = await stat(temporary).catch(() => null);
      if (temporaryIdentity && tmp?.isFile() && tmp.nlink === 1n && sameIdentity(temporaryIdentity, tmp)) {
        await fs.unlink(temporary).catch(() => undefined);
      }
      throw error;
    }
  }
  async flush(): Promise<void> {
    await this.queue;
    const failures = this.failures.splice(0);
    if (failures.length) throw new AggregateError(failures, "log_archive_failed");
  }
  close(): Promise<void> {
    return this.closing ??= this.finish();
  }
  private async finish(): Promise<void> {
    this.stopped = true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 5000); });
    try {
      if (await Promise.race([this.queue.then(() => "done"), timeout]) === "timeout") {
        this.cancelled = true;
        await this.codec.cancel();
        await this.options.legacyCodec?.cancel();
        await this.queue;
      }
    } finally { if (timer) clearTimeout(timer); }
  }
}
