import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DAILY_LOG_PATTERN = /^(\d{4}-\d{2}-\d{2})\.log$/u;

export class SevenZipLogArchiver {
  constructor(
    private readonly logDir: string,
    private readonly sevenZipPath: string,
  ) {}

  async archiveBefore(utcDay: string): Promise<void> {
    await mkdir(this.logDir, { recursive: true });
    const entries = await readdir(this.logDir, { withFileTypes: true });
    const expiredFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, match: DAILY_LOG_PATTERN.exec(entry.name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => Boolean(entry.match?.[1] && entry.match[1] < utcDay))
      .map((entry) => entry.name)
      .sort();

    let firstError: unknown;
    for (const fileName of expiredFiles) {
      try {
        await this.archiveFile(fileName);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  private async archiveFile(fileName: string): Promise<void> {
    const sourcePath = path.join(this.logDir, fileName);
    const archivePath = `${sourcePath}.7z`;
    const backupPath = `${archivePath}.previous`;
    const temporaryPath = path.join(this.logDir, `.${fileName}.${randomUUID()}.tmp.7z`);
    const mergeDir = path.join(this.logDir, `.${fileName}.${randomUUID()}.merge`);
    let archiveCwd = this.logDir;

    try {
      await this.recoverArchive(archivePath, backupPath);
      if (await fileExists(archivePath)) {
        await mkdir(mergeDir);
        const mergedSourcePath = path.join(mergeDir, fileName);
        await this.run(["e", archivePath, fileName, `-o${mergeDir}`, "-bb0", "-bd", "-y"]);
        await access(mergedSourcePath);
        await pipeline(createReadStream(sourcePath), createWriteStream(mergedSourcePath, { flags: "a" }));
        archiveCwd = mergeDir;
      }
      await this.run([
        "a", "-t7z", temporaryPath, fileName,
        "-mx=5", "-m0=LZMA2", "-mmt=on", "-bb0", "-bd", "-y",
      ], archiveCwd);
      await this.run(["t", temporaryPath, "-bb0", "-bd", "-y"]);
      await this.replaceArchive(temporaryPath, archivePath, backupPath);
      await rm(sourcePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw new Error(`Failed to archive log ${fileName}`, { cause: error });
    } finally {
      await rm(mergeDir, { recursive: true, force: true });
    }
  }

  private async recoverArchive(archivePath: string, backupPath: string): Promise<void> {
    const archiveExists = await fileExists(archivePath);
    const backupExists = await fileExists(backupPath);
    if (!archiveExists && backupExists) {
      await rename(backupPath, archivePath);
    } else if (archiveExists && backupExists) {
      await rm(backupPath);
    }
  }

  private async replaceArchive(temporaryPath: string, archivePath: string, backupPath: string): Promise<void> {
    const hadArchive = await fileExists(archivePath);
    if (hadArchive) await rename(archivePath, backupPath);
    try {
      await rename(temporaryPath, archivePath);
    } catch (error) {
      if (hadArchive) await rename(backupPath, archivePath);
      throw error;
    }
    await rm(backupPath, { force: true });
  }

  private async run(args: string[], cwd = this.logDir): Promise<void> {
    await execFileAsync(this.sevenZipPath, args, {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
