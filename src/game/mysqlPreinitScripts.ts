import { createHash, randomUUID } from "node:crypto";
import { fstat, type Stats } from "node:fs";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { ServerPlatform } from "../shared/serverPackageLayout.js";
import { assertPlainPath, fingerprintFile, sameFingerprint, type FileFingerprint } from "../desktop/main/serverManagedFiles.js";

export const MYSQL_PREINIT_SCRIPT_FILES = [
  "compet_mysql_preinit.ps1",
  "compet_mysql_preinit.cmd",
] as const;

export interface MysqlPreinitPublishResult {
  created: string[];
  unchanged: string[];
  preserved: string[];
}

function fail(code: string, file: string): never {
  throw Object.assign(new Error(code + ": " + file), { code, path: file });
}

async function inspect(file: string) {
  try {
    await assertPlainPath(file);
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof Error && !(error as NodeJS.ErrnoException).path) {
      Object.assign(error, { path: file });
    }
    throw error;
  }
}

interface StagedScript {
  name: string;
  temporary: string;
  fingerprint: FileFingerprint;
  dev?: number;
  ino?: number;
}

export async function publishMysqlPreinitScripts(input: {
  sourceRoot: string;
  serverRoot: string;
  platform?: ServerPlatform;
}): Promise<MysqlPreinitPublishResult> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const serverRoot = path.resolve(input.serverRoot);
  for (const root of [sourceRoot, serverRoot]) {
    if (!(await inspect(root))?.isDirectory()) fail("mysql_preinit_root_invalid", root);
  }
  const sources: Array<{ name: string; bytes: Buffer; fingerprint: FileFingerprint }> = [];
  const scriptFiles: readonly string[] = (input.platform ?? process.platform + "-" + process.arch) === "linux-x64"
    ? ["compet_mysql_preinit.sh"] : MYSQL_PREINIT_SCRIPT_FILES;
  for (const name of scriptFiles) {
    const file = path.join(sourceRoot, name);
    await inspect(file);
    const fingerprint = await fingerprintFile(file);
    if (!fingerprint) fail("mysql_preinit_source_missing", file);
    const bytes = await readFile(file);
    const readFingerprint = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    if (!sameFingerprint(fingerprint, readFingerprint) ||
        !sameFingerprint(fingerprint, await fingerprintFile(file))) fail("mysql_preinit_source_changed", file);
    sources.push({ name, bytes, fingerprint });
  }

  const result: MysqlPreinitPublishResult = { created: [], unchanged: [], preserved: [] };
  const missing: typeof sources = [];
  for (const source of sources) {
    const target = path.join(serverRoot, source.name);
    const info = await inspect(target);
    if (!info) missing.push(source);
    else if (!info.isFile() || !sameFingerprint(await fingerprintFile(target), source.fingerprint) ||
        (source.name.endsWith(".sh") && (info.mode & 0o111) === 0)) {
      result.preserved.push(source.name);
    } else result.unchanged.push(source.name);
  }
  if (result.preserved.length) return result;

  const stages: StagedScript[] = [];
  const published: StagedScript[] = [];
  async function checkSources(): Promise<void> {
    for (const source of sources) {
      const file = path.join(sourceRoot, source.name);
      if (!sameFingerprint(await fingerprintFile(file), source.fingerprint)) fail("mysql_preinit_source_changed", file);
    }
  }
  async function removeTemporary(stage: StagedScript): Promise<void> {
    const info = await inspect(stage.temporary);
    if (info && (stage.dev === undefined || stage.ino === undefined)) {
      fail("mysql_preinit_temporary_identity_unknown", stage.temporary);
    }
    if (info?.isFile() && info.dev === stage.dev && info.ino === stage.ino) await unlink(stage.temporary);
  }
  try {
    for (const source of missing) {
      await assertPlainPath(serverRoot);
      const temporary = path.join(serverRoot, "." + source.name + "." + randomUUID() + ".tmp");
      const handle = await open(temporary, "wx", 0o600);
      const stage: StagedScript = { name: source.name, temporary, fingerprint: source.fingerprint };
      stages.push(stage);
      let stagingError: unknown;
      try {
        const info = await handle.stat();
        stage.dev = info.dev;
        stage.ino = info.ino;
        await handle.writeFile(source.bytes);
        if (source.name.endsWith(".sh")) await handle.chmod(0o755);
        await handle.sync();
      } catch (error) {
        stagingError = error;
        if (error instanceof Error) Object.assign(error, { path: temporary });
        if (stage.dev === undefined || stage.ino === undefined) {
          try {
            const info = await new Promise<Stats>((resolve, reject) => {
              fstat(handle.fd, (identityError, value) => identityError ? reject(identityError) : resolve(value));
            });
            stage.dev = info.dev;
            stage.ino = info.ino;
          } catch (identityError) {
            if (error instanceof Error) Object.assign(error, { identityError });
          }
        }
        throw error;
      } finally {
        try { await handle.close(); }
        catch (closeError) {
          if (stagingError instanceof Error) Object.assign(stagingError, { closeError });
          else {
            if (closeError instanceof Error) Object.assign(closeError, { path: temporary });
            throw closeError;
          }
        }
      }
      if (!sameFingerprint(await fingerprintFile(temporary), source.fingerprint)) fail("mysql_preinit_staging_changed", temporary);
    }
    await checkSources();
    for (const stage of stages) {
      const target = path.join(serverRoot, stage.name);
      if (await inspect(target)) fail("mysql_preinit_target_changed", target);
      if (!sameFingerprint(await fingerprintFile(stage.temporary), stage.fingerprint)) fail("mysql_preinit_staging_changed", stage.temporary);
      await link(stage.temporary, target);
      published.push(stage);
      if (!sameFingerprint(await fingerprintFile(target), stage.fingerprint)) fail("mysql_preinit_target_changed", target);
      result.created.push(stage.name);
    }
    await checkSources();
    for (const source of sources) {
      const target = path.join(serverRoot, source.name);
      if (!sameFingerprint(await fingerprintFile(target), source.fingerprint)) fail("mysql_preinit_target_changed", target);
    }
    for (const stage of stages) await removeTemporary(stage);
    return result;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const stage of published.slice().reverse()) {
      const target = path.join(serverRoot, stage.name);
      try {
        const info = await inspect(target);
        if (info?.isFile() && info.dev === stage.dev && info.ino === stage.ino &&
            sameFingerprint(await fingerprintFile(target), stage.fingerprint)) await unlink(target);
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    for (const stage of stages) {
      try { await removeTemporary(stage); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length && error instanceof Error) Object.assign(error, { cleanupErrors });
    throw error;
  }
}
