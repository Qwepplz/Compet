import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { encodeSingleFileTar, inspectSingleFileTar, type ArchiveInspection, type ArchiveMetadata } from "./singleFileTar.js";
import { archiveFile, sameArchiveIdentity, XzProcess } from "./xzCodec.js";

export interface TarXzCodec {
  encode(input: { sourcePath: string; memberName: string; metadata: ArchiveMetadata }, targetPath: string, onCreated?: () => Promise<void>): Promise<void>;
  inspect(archivePath: string): Promise<ArchiveInspection>;
  cancel(): Promise<void>;
}
const execute = promisify(execFile);
export function parseGnuBirthtime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:[.](\d{1,9}))? ([+-])(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) throw new Error("archive_birthtime_unavailable");
  const local = match[1] + "T" + match[2], date = Date.parse(local + "Z");
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 19) !== local ||
      Number(match[5]) > 23 || Number(match[6]) > 59) throw new Error("archive_birthtime_unavailable");
  const offsetSeconds = BigInt(Number(match[5]) * 3600 + Number(match[6]) * 60) * (match[4] === "-" ? -1n : 1n);
  return ((BigInt(date) / 1000n - offsetSeconds) * 1000000000n + BigInt((match[3] ?? "").padEnd(9, "0"))).toString();
}
export async function readArchiveMetadata(sourcePath: string): Promise<ArchiveMetadata> {
  const before = await archiveFile(sourcePath);
  const handle = await fs.open(sourcePath, constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
  try {
    const held = await handle.stat({ bigint: true });
    if (!sameArchiveIdentity(before, held)) throw new Error("archive_source_changed");
    let birthtimeNs: string;
    if (process.platform === "linux") {
      try {
        const value = await execute("/usr/bin/stat", ["--printf=%w", "--", sourcePath], {
          env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, timeout: 10000, maxBuffer: 4096, windowsHide: true,
        });
        birthtimeNs = parseGnuBirthtime(value.stdout);
      } catch (error) { throw new Error("archive_birthtime_unavailable", { cause: error }); }
    } else if (process.platform === "win32" && held.birthtimeNs > 0n) {
      birthtimeNs = held.birthtimeNs.toString();
    } else { throw new Error("archive_birthtime_unavailable"); }
    if (!sameArchiveIdentity(held, await handle.stat({ bigint: true })) || !sameArchiveIdentity(held, await archiveFile(sourcePath))) throw new Error("archive_source_changed");
    return { birthtimeNs, mtimeNs: held.mtimeNs.toString() };
  } finally { await handle.close(); }
}
export class SevenZipTarXzCodec implements TarXzCodec {
  private readonly process: XzProcess;
  constructor(executable: string, options: { processTimeoutMs?: number } = {}) {
    this.process = new XzProcess(executable, options.processTimeoutMs ?? 120000);
  }
  async encode(input: { sourcePath: string; memberName: string; metadata: ArchiveMetadata }, targetPath: string, onCreated?: () => Promise<void>): Promise<void> {
    const before = await archiveFile(input.sourcePath);
    const current = await readArchiveMetadata(input.sourcePath);
    if (current.birthtimeNs !== input.metadata.birthtimeNs || current.mtimeNs !== input.metadata.mtimeNs) throw new Error("archive_source_changed");
    const handle = await fs.open(input.sourcePath, constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
    try {
      if (!sameArchiveIdentity(before, await handle.stat({ bigint: true }))) throw new Error("archive_source_changed");
      await this.process.encode(encodeSingleFileTar({
        memberName: input.memberName, size: Number(before.size), metadata: input.metadata,
        content: handle.createReadStream({ autoClose: false }),
      }), targetPath, onCreated);
      if (!sameArchiveIdentity(before, await handle.stat({ bigint: true })) || !sameArchiveIdentity(before, await archiveFile(input.sourcePath))) throw new Error("archive_source_changed");
    } finally { await handle.close(); }
  }
  inspect(archivePath: string): Promise<ArchiveInspection> { return this.process.decode(archivePath, inspectSingleFileTar); }
  cancel(): Promise<void> { return this.process.cancel(); }
}
