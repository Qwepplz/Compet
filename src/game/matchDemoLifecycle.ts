import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { archiveFile, sameArchiveIdentity } from "../archive/xzCodec.js";
import { inspectWindowsGameOwner, probeWindowsGameProcess, type WindowsGameProcessIdentity } from "./windowsProcess.js";
import path from "node:path";
import { z } from "zod";
import { assertPlainPath } from "../desktop/main/serverManagedFiles.js";
import { writeJsonFileAtomic } from "../storage/jsonFile.js";
import { readArchiveMetadata, type TarXzCodec } from "../archive/tarXzCodec.js";
import type { ArchiveInspection } from "../archive/singleFileTar.js";
import { inspectLinuxGameRoot, inspectLinuxUdpPort, probeLinuxGameProcess, readLinuxProcessIdentity, type GameProcessIdentity } from "./linuxProcess.js";
import type { readGet5DemoEvidence } from "./get5MatchResult.js";

const matchIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const decimal = z.string().regex(/^\d+$/);
const windowsOwnerSchema = z.object({
  platform: z.literal("win32"), pid: z.number().int().positive(), createdAtUtc: z.string().min(1),
  executable: z.string().min(1), port: z.number().int().min(1).max(65535),
});
const ownerSchema = z.discriminatedUnion("platform", [
  windowsOwnerSchema,
  z.object({ platform: z.literal("linux"), port: z.number().int().min(1).max(65535), identity: z.object({
    pid: z.number().int().positive(), startTimeTicks: decimal, executable: z.string().min(1),
    serverRoot: z.string().min(1), processGroupId: z.number().int().positive(),
  }) }),
]);
export type DemoOwner = { platform: "linux"; identity: GameProcessIdentity; port: number } | (WindowsGameProcessIdentity & { port: number });
export async function probeDemoRoot(serverRoot: string, port: number): Promise<"gone" | "unknown"> {
  if (process.platform === "linux") {
    const [root, udp] = await Promise.all([inspectLinuxGameRoot(serverRoot), inspectLinuxUdpPort(port)]);
    return root === "gone" && udp === "free" ? "gone" : "unknown";
  }
  if (process.platform === "win32") return (await inspectWindowsGameOwner(serverRoot, port)).state === "gone" ? "gone" : "unknown";
  return "unknown";
}
export async function probeDemoOwner(owner: DemoOwner): Promise<"alive" | "gone" | "unknown"> {
  if (owner.platform !== process.platform) return "unknown";
  if (owner.platform === "linux") {
    try {
      const current = await readLinuxProcessIdentity(owner.identity.pid, owner.identity.serverRoot);
      if (current.startTimeTicks !== owner.identity.startTimeTicks) return "unknown";
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return "unknown";
    }
    const state = await probeLinuxGameProcess(owner.identity);
    return state === "gone" ? probeDemoRoot(owner.identity.serverRoot, owner.port) : state;
  }
  const state = await probeWindowsGameProcess(owner);
  return state === "gone" ? probeDemoRoot(path.dirname(owner.executable), owner.port) : state;
}
const snapshotSchema = z.object({
  name: z.string().min(1), dev: decimal, ino: decimal, size: decimal,
  mtimeNs: z.string().regex(/^-?\d+$/), ctimeNs: z.string().regex(/^-?\d+$/),
}).strict();
export type DemoSnapshotFile = z.infer<typeof snapshotSchema>;
const fileSchema = snapshotSchema.extend({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(["pending", "deleting", "deleted", "archived"]),
  metadata: z.object({ birthtimeNs: z.string().regex(/^-?\d+$/), mtimeNs: z.string().regex(/^-?\d+$/) }).optional(),
  attempt: z.object({ name: z.string().min(1), dev: decimal.optional(), ino: decimal.optional(), verified: z.boolean().optional() }).optional(),
}).strict();
type DemoFile = z.infer<typeof fileSchema>;
const jobSchema = z.object({
  schemaVersion: z.literal(1), matchId: matchIdSchema, dev: z.boolean(), serverRoot: z.string().min(1),
  sourceDirectory: z.object({ dev: decimal, ino: decimal }), baseline: z.array(snapshotSchema),
  stage: z.enum(["prepared", "attached", "frozen", "complete"]), owner: ownerSchema.optional(),
  disposition: z.enum(["keep", "delete"]).optional(),
  evidence: z.object({ normal: z.boolean(), reason: z.string().optional() }).optional(),
  files: z.array(fileSchema).optional(),
}).strict();
type DemoJob = z.infer<typeof jobSchema>;
export type DemoSettlement = "kept" | "deleted" | "no_demo" | "unmanaged" | "blocked";
export type DemoDisposition = "keep" | "delete";
export function decideDemoDisposition(dev: boolean, normal: boolean): DemoDisposition {
  if (typeof dev !== "boolean") throw new Error("demo_dev_invalid");
  return dev || !normal ? "delete" : "keep";
}
export interface MatchDemoLifecycleOptions {
  serverRoot: string; jobDirectory: string; codec: TarXzCodec;
  readEvidence(matchId: string): ReturnType<typeof readGet5DemoEvidence>;
  probeOwner(owner: DemoOwner): Promise<"alive" | "gone" | "unknown">;
  probePrepared?(): Promise<"gone" | "unknown">;
  onError(matchId: string, error: unknown): void;
}
function matchId(value: string): void { if (!matchIdSchema.safeParse(value).success) throw new Error("demo_match_id_invalid"); }
async function maybeStat(file: string) {
  await assertPlainPath(file);
  try { return await fs.lstat(file, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
  }
}
export class MatchDemoLifecycle {
  private queue: Promise<unknown> = Promise.resolve();
  private failures: unknown[] = [];
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private readonly pendingSettlements = new Set<string>();
  private stopped = false;
  private cancelled = false;
  private closing?: Promise<void>;
  constructor(private readonly options: MatchDemoLifecycleOptions) {
    if (!path.isAbsolute(options.serverRoot) || !path.isAbsolute(options.jobDirectory)) throw new Error("demo_root_invalid");
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation); this.queue = task.catch(() => undefined); return task;
  }
  private jobFile(id: string): string { matchId(id); return path.join(this.options.jobDirectory, id + ".json"); }
  private async root(): Promise<string> {
    await assertPlainPath(this.options.serverRoot);
    const root = await fs.realpath(this.options.serverRoot);
    if (!(await fs.lstat(root)).isDirectory()) throw new Error("demo_root_invalid");
    return root;
  }
  private directory(job: DemoJob): string { return path.join(job.serverRoot, "csgo"); }
  private async read(id: string): Promise<DemoJob | null> {
    const file = this.jobFile(id), info = await maybeStat(file);
    if (!info) return null;
    if (!info.isFile() || info.nlink !== 1n) throw new Error("demo_job_invalid");
    let job: DemoJob;
    try { job = jobSchema.parse(JSON.parse(await fs.readFile(file, "utf8"))); } catch (error) { throw new Error("demo_job_invalid", { cause: error }); }
    if (job.matchId !== id || job.serverRoot !== await this.root()) throw new Error("demo_job_conflict");
    if (job.owner) {
      const expected = path.join(job.serverRoot, job.owner.platform === "linux" ? "srcds_linux" : "srcds.exe");
      if ((job.owner.platform === "linux" ? job.owner.identity.executable : job.owner.executable) !== expected ||
          job.owner.platform === "linux" && job.owner.identity.serverRoot !== job.serverRoot) throw new Error("demo_owner_conflict");
    }
    const directory = await maybeStat(this.directory(job));
    if (!directory?.isDirectory() || directory.dev.toString() !== job.sourceDirectory.dev || directory.ino.toString() !== job.sourceDirectory.ino) throw new Error("demo_directory_conflict");
    if ((job.stage === "frozen" || job.stage === "complete") && (!job.disposition || !job.files || !job.evidence)) throw new Error("demo_job_invalid");
    if (job.files?.some(file => !this.validName(file.name))) throw new Error("demo_job_invalid");
    const names = job.baseline.map(file => file.name);
    if (names.some(name => !this.safeName(name)) || new Set(names).size !== names.length || names.join("\n") !== [...names].sort().join("\n")) throw new Error("demo_job_invalid");
    if (job.files && new Set(job.files.map(file => file.name)).size !== job.files.length) throw new Error("demo_job_invalid");
    return job;
  }
  private async save(job: DemoJob): Promise<void> {
    jobSchema.parse(job); const file = this.jobFile(job.matchId), existing = await maybeStat(file);
    if (existing && (!existing.isFile() || existing.nlink !== 1n)) throw new Error("demo_job_invalid");
    await writeJsonFileAtomic(file, job, { durable: true });
  }
  private safeName(name: string): boolean {
    return path.basename(name) === name && name.endsWith(".dem") && !/[\/\\:\x00-\x1f]/.test(name);
  }
  private async snapshot(directory: string): Promise<DemoSnapshotFile[]> {
    const before = await maybeStat(directory);
    if (!before?.isDirectory()) throw new Error("demo_directory_conflict");
    const files: DemoSnapshotFile[] = [];
    for (const name of (await fs.readdir(directory)).filter(name => name.endsWith(".dem")).sort()) {
      if (!this.safeName(name)) throw new Error("demo_file_unmanaged");
      const info = await archiveFile(path.join(directory, name));
      files.push({ name, dev: info.dev.toString(), ino: info.ino.toString(), size: info.size.toString(),
        mtimeNs: info.mtimeNs.toString(), ctimeNs: info.ctimeNs.toString() });
    }
    const after = await maybeStat(directory);
    if (!after?.isDirectory() || before.dev !== after.dev || before.ino !== after.ino ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("demo_directory_changed");
    return files;
  }
  private changed(job: DemoJob, files: DemoSnapshotFile[]): DemoSnapshotFile[] {
    return files.filter(file => {
      const previous = job.baseline.find(old => old.name === file.name);
      return !previous || previous.dev !== file.dev || previous.ino !== file.ino || previous.size !== file.size ||
        previous.mtimeNs !== file.mtimeNs || previous.ctimeNs !== file.ctimeNs;
    });
  }
  prepare(input: { matchId: string; dev: boolean }): Promise<void> {
    return this.mutate(async () => {
      if (this.stopped) throw new Error("demo_lifecycle_closed");
      matchId(input.matchId); if (typeof input.dev !== "boolean") throw new Error("demo_dev_invalid");
      const root = await this.root();
      if (await maybeStat(this.options.jobDirectory)) await this.sync(this.options.jobDirectory);
      for (const entry of await fs.readdir(this.options.jobDirectory).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
        if (!entry.endsWith(".json") || entry === input.matchId + ".json") continue;
        const other = await this.read(entry.slice(0, -5));
        if (other) throw new Error("demo_jobs_pending");
      }
      const existing = await this.read(input.matchId);
      if (existing) {
        if (existing.dev !== input.dev || existing.stage !== "prepared" || existing.owner) throw new Error("demo_job_conflict");
        if (this.changed(existing, await this.snapshot(this.directory(existing))).length) throw new Error("demo_owner_unconfirmed");
        await this.save(existing); return;
      }
      const directory = path.join(root, "csgo"), identity = await maybeStat(directory);
      if (!identity?.isDirectory()) throw new Error("demo_directory_conflict");
      const baseline = await this.snapshot(directory);
      await assertPlainPath(this.options.jobDirectory);
      await fs.mkdir(this.options.jobDirectory, { recursive: true, mode: 0o700 });
      await this.save({ schemaVersion: 1, matchId: input.matchId, dev: input.dev, serverRoot: root,
        sourceDirectory: { dev: identity.dev.toString(), ino: identity.ino.toString() }, baseline, stage: "prepared" });
    });
  }
  attachServer(id: string, owner: DemoOwner): Promise<void> {
    return this.mutate(async () => {
      if (this.stopped) throw new Error("demo_lifecycle_closed");
      const job = await this.read(id); if (!job) throw new Error("demo_job_missing");
      const parsed = ownerSchema.safeParse(owner); if (!parsed.success) throw new Error("demo_owner_invalid");
      const expected = path.join(job.serverRoot, owner.platform === "linux" ? "srcds_linux" : "srcds.exe");
      if ((owner.platform === "linux" ? owner.identity.executable : owner.executable) !== expected ||
          owner.platform === "linux" && owner.identity.serverRoot !== job.serverRoot) throw new Error("demo_owner_invalid");
      if (job.owner && JSON.stringify(job.owner) !== JSON.stringify(parsed.data)) throw new Error("demo_owner_conflict");
      if (!["prepared", "attached"].includes(job.stage)) return;
      job.owner = parsed.data; job.stage = "attached"; await this.save(job);
    });
  }

  private validName(name: string): boolean {
    return this.safeName(name) && /^pug_\d{4}-\d{2}-\d{2}_\d{4}_[A-Za-z0-9_-]+[.]dem$/.test(name);
  }
  private archiveDirectory(job: DemoJob): string { return path.join(this.directory(job), "demos"); }
  private report(id: string, error: unknown): void {
    try { this.options.onError(id, error); } catch { /* Diagnostics do not change ownership. */ }
  }
  private async fingerprint(file: string): Promise<Omit<DemoFile, "name" | "state">> {
    const before = await archiveFile(file), handle = await fs.open(file, constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
    try {
      if (!sameArchiveIdentity(before, await handle.stat({ bigint: true }))) throw new Error("demo_file_changed");
      const hash = createHash("sha256"); let size = 0n;
      for await (const bytes of handle.createReadStream({ autoClose: false })) { hash.update(bytes); size += BigInt(bytes.length); }
      if (size !== before.size || !sameArchiveIdentity(before, await handle.stat({ bigint: true })) || !sameArchiveIdentity(before, await archiveFile(file))) throw new Error("demo_file_changed");
      return { dev: before.dev.toString(), ino: before.ino.toString(), size: before.size.toString(),
        mtimeNs: before.mtimeNs.toString(), ctimeNs: before.ctimeNs.toString(), sha256: hash.digest("hex") };
    } finally { await handle.close(); }
  }
  private sameFile(a: Omit<DemoFile, "name" | "state">, b: Omit<DemoFile, "name" | "state">): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.sha256 === b.sha256;
  }
  private async sync(directory: string): Promise<void> {
    if (process.platform !== "linux") return;
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private async complete(job: DemoJob): Promise<void> {
    if (this.cancelled) throw new Error("demo_archive_cancelled");
    job.stage = "complete"; await this.save(job);
    try {
      await fs.unlink(this.jobFile(job.matchId)); await this.sync(this.options.jobDirectory);
    } catch (error) {
      await this.save(job).catch(recoveryError => this.report(job.matchId, recoveryError));
      throw error;
    }
  }
  settle(id: string): Promise<DemoSettlement> {
    this.pendingSettlements.add(id);
    return this.mutate(async () => {
      try {
        const job = await this.read(id);
        if (!job) {
          if (await maybeStat(this.options.jobDirectory)) await this.sync(this.options.jobDirectory);
          return "unmanaged";
        }
        if (this.stopped) throw new Error("demo_lifecycle_closed");
        if (job.stage === "complete") { await this.complete(job); return job.files?.length ? job.disposition === "keep" ? "kept" : "deleted" : "no_demo"; }
        if (job.owner) {
          if (await this.options.probeOwner(job.owner) !== "gone") return "blocked";
        } else if (await this.options.probePrepared?.() !== "gone") return "blocked";
        const candidates = job.stage === "frozen" ? job.files! : this.changed(job, await this.snapshot(this.directory(job)));
        const names = candidates.map(file => file.name);
        if (job.stage !== "frozen") {
          if (names.some(name => !this.validName(name))) throw new Error("demo_file_unmanaged");
          const evidence = job.dev ? undefined : await this.options.readEvidence(id);
          const normal = evidence?.get5Result.status === "normal";
          for (const input of evidence?.demoFiles ?? []) {
            const normalized = input.replaceAll("\\", "/");
            const withExtension = normalized.endsWith(".dem") ? normalized : normalized + ".dem";
            const name = path.posix.basename(withExtension);
            if (!this.validName(name) || withExtension !== name || !names.includes(name)) throw new Error("demo_evidence_conflict");
          }
          job.disposition = decideDemoDisposition(job.dev, normal);
          job.evidence = { normal, ...(evidence?.get5Result.status === "abnormal" ? { reason: evidence.get5Result.reason } : {}) };
          job.files = [];
          for (const name of names.sort()) job.files.push({ name, ...await this.fingerprint(path.join(this.directory(job), name)), state: "pending" });
          job.stage = "frozen"; await this.save(job);
        }
        if (!job.files?.length) { await this.complete(job); return "no_demo"; }
        if (job.disposition === "keep") { await this.archive(id); return "kept"; }
        for (const file of job.files) {
          if (file.state === "deleted") continue;
          const source = path.join(this.directory(job), file.name);
          const current = await maybeStat(source);
          if (!current && file.state === "deleting") { await this.sync(this.directory(job)); file.state = "deleted"; await this.save(job); continue; }
          if (!current || !this.sameFile(file, await this.fingerprint(source))) throw new Error("demo_file_changed");
          if (this.cancelled) throw new Error("demo_archive_cancelled");
          if (job.owner && await this.options.probeOwner(job.owner) !== "gone") return "blocked";
          file.state = "deleting"; await this.save(job);
          if (!this.sameFile(file, await this.fingerprint(source))) throw new Error("demo_file_changed");
          if (this.cancelled) throw new Error("demo_archive_cancelled");
          await fs.unlink(source); await this.sync(this.directory(job));
          file.state = "deleted"; await this.save(job);
        }
        await this.complete(job); return "deleted";
      } catch (error) { this.failures.push(error); this.report(id, error); return "blocked"; }
    }).then(result => {
      if (result === "blocked") this.scheduleRetry(id);
      else {
        this.pendingSettlements.delete(id);
        clearTimeout(this.retries.get(id));
        this.retries.delete(id);
      }
      return result;
    });
  }
  async pendingMatchIds(): Promise<string[]> {
    await assertPlainPath(this.options.jobDirectory);
    const names = await fs.readdir(this.options.jobDirectory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const ids = names.filter(name => name.endsWith(".json")).map(name => {
      const id = name.slice(0, -5); matchId(id); return id;
    });
    return [...new Set([...ids, ...this.pendingSettlements])].sort();
  }
  async recover(): Promise<void> {
    for (const id of await this.pendingMatchIds()) {
      if (await this.settle(id) === "blocked") this.report(id, new Error("demo_recovery_blocked"));
    }
  }

  private scheduleRetry(id: string): void {
    if (this.stopped || this.retries.has(id)) return;
    const timer = setTimeout(() => {
      this.retries.delete(id);
      if (this.stopped) return;
      void this.settle(id).catch(error => {
        this.report(id, error); this.scheduleRetry(id);
      });
    }, 60000);
    timer.unref(); this.retries.set(id, timer);
  }
  private matches(view: ArchiveInspection, file: DemoFile): boolean {
    return view.memberName === file.name && String(view.size) === file.size && view.sha256 === file.sha256 &&
      view.metadata.birthtimeNs === file.metadata?.birthtimeNs && view.metadata.mtimeNs === file.metadata?.mtimeNs;
  }
  private attemptPath(job: DemoJob, file: DemoFile): string {
    const name = file.attempt?.name;
    const prefix = "." + file.name + ".attempt-";
    if (!name || path.basename(name) !== name || !name.startsWith(prefix) || !/^[0-9a-f-]{36}[.]tmp$/.test(name.slice(prefix.length))) throw new Error("demo_attempt_invalid");
    return path.join(this.archiveDirectory(job), name);
  }
  private async published(job: DemoJob, file: DemoFile): Promise<boolean> {
    const final = path.join(this.archiveDirectory(job), file.name + ".tar.xz"), info = await maybeStat(final);
    if (!info) return false;
    if (!info.isFile() || ![1n, 2n].includes(info.nlink)) throw new Error("demo_archive_conflict");
    if (info.nlink === 2n) {
      const attempt = file.attempt && await maybeStat(this.attemptPath(job, file));
      if (!attempt || info.dev.toString() !== file.attempt?.dev || info.ino.toString() !== file.attempt?.ino ||
          attempt.dev !== info.dev || attempt.ino !== info.ino) throw new Error("demo_archive_conflict");
    }
    if (!this.matches(await this.options.codec.inspect(final), file)) throw new Error("demo_archive_conflict");
    return true;
  }
  private async cleanupAttempt(job: DemoJob, file: DemoFile): Promise<void> {
    if (!file.attempt) return;
    const temporary = this.attemptPath(job, file), info = await maybeStat(temporary);
    if (info) {
      if (info.dev.toString() !== file.attempt.dev || info.ino.toString() !== file.attempt.ino ||
          !info.isFile() || !this.matches(await this.options.codec.inspect(temporary), file)) throw new Error("demo_attempt_conflict");
      await fs.unlink(temporary); await this.sync(this.archiveDirectory(job));
    }
    delete file.attempt; await this.save(job);
  }
  private async archive(id: string): Promise<void> {
    const job = await this.read(id); if (!job) return;
    if (job.disposition !== "keep" || job.stage !== "frozen" || !job.files) return;
    await assertPlainPath(this.archiveDirectory(job));
    await fs.mkdir(this.archiveDirectory(job), { recursive: true, mode: 0o700 });
    for (const file of job.files) {
      if (this.cancelled) throw new Error("demo_archive_cancelled");
      const source = path.join(this.directory(job), file.name);
      if (!this.sameFile(file, await this.fingerprint(source))) throw new Error("demo_file_changed");
      if (!file.metadata) { file.metadata = await readArchiveMetadata(source); await this.save(job); }
      if (!await this.published(job, file)) {
        let reuse = false;
        if (file.attempt) {
          const temporary = this.attemptPath(job, file), previous = await maybeStat(temporary);
          if (previous) {
            if (file.attempt.dev === undefined && file.attempt.ino === undefined && !file.attempt.verified) {
              // The durable job reserved this exact UUID path before creation. Encoding
              // cannot start before identity registration succeeds, so only an empty slot is recoverable.
              if (!previous.isFile() || previous.nlink !== 1n || previous.size !== 0n) throw new Error("demo_attempt_conflict");
              const handle = await fs.open(temporary, constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
              try {
                if (!sameArchiveIdentity(previous, await handle.stat({ bigint: true }))) throw new Error("demo_attempt_conflict");
                file.attempt.dev = previous.dev.toString(); file.attempt.ino = previous.ino.toString();
                await this.save(job);
                if (!sameArchiveIdentity(previous, await archiveFile(temporary))) throw new Error("demo_attempt_conflict");
              } finally { await handle.close(); }
            }
            if (!previous.isFile() || previous.nlink !== 1n || previous.dev.toString() !== file.attempt.dev ||
                previous.ino.toString() !== file.attempt.ino) throw new Error("demo_attempt_conflict");
            if (file.attempt.verified) {
              if (!this.matches(await this.options.codec.inspect(temporary), file)) throw new Error("demo_attempt_conflict");
              reuse = true;
            } else {
              await fs.unlink(temporary); await this.sync(this.archiveDirectory(job));
              delete file.attempt; await this.save(job);
            }
          } else { delete file.attempt; await this.save(job); }
        }
        if (!reuse) {
          file.attempt = { name: "." + file.name + ".attempt-" + randomUUID() + ".tmp" }; await this.save(job);
          await this.options.codec.encode({ sourcePath: source, memberName: file.name, metadata: file.metadata }, this.attemptPath(job, file), async () => {
            const created = await archiveFile(this.attemptPath(job, file));
            file.attempt!.dev = created.dev.toString(); file.attempt!.ino = created.ino.toString();
            await this.save(job);
          });
          const encoded = await archiveFile(this.attemptPath(job, file));
          if (file.attempt.dev && (file.attempt.dev !== encoded.dev.toString() || file.attempt.ino !== encoded.ino.toString())) throw new Error("demo_attempt_conflict");
          file.attempt.dev = encoded.dev.toString(); file.attempt.ino = encoded.ino.toString(); await this.save(job);
          if (!this.matches(await this.options.codec.inspect(this.attemptPath(job, file)), file)) throw new Error("demo_archive_mismatch");
          file.attempt.verified = true; await this.save(job);
        }
        if (this.cancelled || !this.sameFile(file, await this.fingerprint(source))) throw new Error("demo_file_changed");
        const temporary = this.attemptPath(job, file), current = await archiveFile(temporary);
        if (current.dev.toString() !== file.attempt!.dev || current.ino.toString() !== file.attempt!.ino) throw new Error("demo_attempt_conflict");
        await fs.link(temporary, path.join(this.archiveDirectory(job), file.name + ".tar.xz")); await this.sync(this.archiveDirectory(job));
        if (!await this.published(job, file)) throw new Error("demo_archive_conflict");
      }
      if (!this.sameFile(file, await this.fingerprint(source))) throw new Error("demo_file_changed");
      await this.cleanupAttempt(job, file);
      await this.sync(this.archiveDirectory(job));
      file.state = "archived"; await this.save(job);
    }
    await this.complete(job);
  }
  async flush(): Promise<void> {
    await this.queue;
    const errors = this.failures.splice(0);
    if (errors.length) throw new AggregateError(errors, "demo_archive_failed");
  }
  close(): Promise<void> { return this.closing ??= this.finish(); }
  private async finish(): Promise<void> {
    this.stopped = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 5000); });
      if (await Promise.race([this.queue.then(() => "done"), timeout]) === "timeout") {
        this.cancelled = true; await this.options.codec.cancel();
      }
      await this.flush();
    } finally { if (timer) clearTimeout(timer); await this.options.codec.cancel(); }
  }
}
