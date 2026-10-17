import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { assertPlainPath, fingerprintFile, sameFingerprint } from "../desktop/main/serverManagedFiles.js";
import type { ServerPlatform } from "../shared/serverPackageLayout.js";
import { sameServerImage, syncDirectory } from "./serverTransaction.js";
import { updateFailure, type ServerBeforeImage } from "./serverUpdateTypes.js";

export async function readServerImage(file: string, platform: ServerPlatform): Promise<ServerBeforeImage | null> {
  const fingerprint = await fingerprintFile(file);
  if (!fingerprint) return null;
  const info = await fs.lstat(file);
  return { ...fingerprint, ...(platform === "linux-x64" ? { mode: info.mode & 0o7777, uid: info.uid, gid: info.gid } : {}) };
}
export async function durableCopy(source: string, target: string, mode?: number, ownership?: { uid: number; gid: number }): Promise<void> {
  await assertPlainPath(source); await assertPlainPath(target);
  await fs.copyFile(source, target, constants.COPYFILE_EXCL);
  if (mode !== undefined) await fs.chmod(target, mode);
  const handle = await fs.open(target, "r+");
  try {
    if (ownership && process.platform === "linux") {
      const stat = await handle.stat();
      if (stat.uid !== ownership.uid || stat.gid !== ownership.gid) await handle.chown(ownership.uid, ownership.gid);
    }
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(path.dirname(target));
}
export interface FileMutation {
  platform: ServerPlatform;
  target: string;
  temporary: string;
  before: ServerBeforeImage | null;
  after: ServerBeforeImage | null;
  source?: string;
  backup?: string;
  assertCanWrite?: () => Promise<void>;
}
async function clearRegisteredTemporary(input: FileMutation): Promise<void> {
  const actual = await fingerprintFile(input.temporary);
  if (!actual) return;
  if (!sameFingerprint(actual, input.before) && !sameFingerprint(actual, input.after)) {
    const bytes = await fs.readFile(input.temporary); let prefix = false;
    for (const source of [input.source, input.backup].filter((value): value is string => !!value)) {
      const expected = source === input.source ? input.after : input.before;
      if (!sameFingerprint(await fingerprintFile(source), expected)) updateFailure("maintenance_source_invalid");
      const contents = await fs.readFile(source);
      if (bytes.length <= contents.length && bytes.equals(contents.subarray(0, bytes.length))) prefix = true;
    }
    if (!prefix) updateFailure("maintenance_recovery_conflict");
  }
  await fs.unlink(input.temporary); await syncDirectory(path.dirname(input.temporary));
}
export async function applyFileMutation(input: FileMutation, ownership?: { uid: number; gid: number }): Promise<void> {
  await input.assertCanWrite?.();
  if (!sameServerImage(await readServerImage(input.target, input.platform), input.before)) updateFailure("maintenance_before_changed");
  if (!input.after) await fs.unlink(input.target);
  else {
    if (!input.source || !sameFingerprint(await fingerprintFile(input.source), input.after)) updateFailure("maintenance_source_invalid");
    await fs.mkdir(path.dirname(input.target), { recursive: true });
    await durableCopy(input.source, input.temporary, input.after.mode, ownership);
    if (!sameServerImage(await readServerImage(input.temporary, input.platform), input.after, false)) updateFailure("update_file_hash_mismatch");
    await input.assertCanWrite?.();
    if (!sameServerImage(await readServerImage(input.target, input.platform), input.before)) updateFailure("maintenance_before_changed");
    await fs.rename(input.temporary, input.target);
  }
  await syncDirectory(path.dirname(input.target));
}
export async function rollbackFileMutation(input: FileMutation): Promise<void> {
  await input.assertCanWrite?.();
  const actual = await readServerImage(input.target, input.platform);
  await clearRegisteredTemporary(input);
  if (sameServerImage(actual, input.before)) return;
  if (!sameServerImage(actual, input.after, false)) updateFailure("maintenance_recovery_conflict");
  if (input.before) {
    if (!input.backup || !sameFingerprint(await fingerprintFile(input.backup), input.before)) updateFailure("maintenance_backup_invalid");
    await fs.mkdir(path.dirname(input.target), { recursive: true });
    await durableCopy(input.backup, input.temporary, input.before.mode,
      input.before.uid === undefined ? undefined : { uid: input.before.uid, gid: input.before.gid! });
    if (!sameServerImage(await readServerImage(input.temporary, input.platform), input.before)) updateFailure("maintenance_backup_invalid");
    await input.assertCanWrite?.();
    if (!sameServerImage(await readServerImage(input.target, input.platform), input.after, false)) updateFailure("maintenance_recovery_conflict");
    await fs.rename(input.temporary, input.target); await syncDirectory(path.dirname(input.target));
  } else if (actual) {
    await fs.unlink(input.target); await syncDirectory(path.dirname(input.target));
  }
}
