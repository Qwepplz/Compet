import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, lstat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { assertPlainPath } from "../../desktop/main/serverManagedFiles.js";
import path from "node:path";
import { type ActivityLogInput, type LogActor } from "../../shared/activityLog.js";
import type { LogEntry } from "../shared/types.js";
import { SevenZipLogArchiver } from "./logArchiver.js";
import { redactSensitiveText } from "../../shared/redactSensitiveText.js";

type LogContext = NonNullable<LogEntry["context"]>;

export interface LogArchiver {
  archiveBefore(utcDay: string): Promise<void>;
}

export interface FileLogStoreOptions {
  maxRecent?: number;
  sevenZipPath?: string;
  archiver?: LogArchiver;
  strictFiles?: boolean;
  now?: () => Date;
}

export class FileLogStore extends EventEmitter {
  private entries: LogEntry[] = [];
  private writeQueue = Promise.resolve();
  private readonly maxRecent: number;
  private readonly now: () => Date;
  private readonly archiver?: LogArchiver;
  private readonly strictFiles: boolean;
  private archiveAttemptedUtcDay?: string;

  constructor(private readonly logDir: string, options: FileLogStoreOptions = {}) {
    super();
    this.maxRecent = options.maxRecent ?? 2_000;
    this.now = options.now ?? (() => new Date());
    if (options.archiver && options.sevenZipPath) throw new Error("log_archiver_conflict");
    this.strictFiles = options.strictFiles ?? false;
    if (this.strictFiles && (process.platform !== "linux" || !constants.O_NOFOLLOW)) throw new Error("log_strict_files_unsupported");
    this.archiver = options.archiver ?? (options.sevenZipPath ? new SevenZipLogArchiver(logDir, options.sevenZipPath) : undefined);
  }

  append(input: ActivityLogInput, options: { preserveWhitespace?: boolean } = {}): Promise<LogEntry> {
    const entry: LogEntry = {
      ...input,
      id: randomUUID(),
      timestamp: input.timestamp ?? this.now().toISOString(),
      message: redactSensitiveText(options.preserveWhitespace ? input.message : input.message.trim()),
      ...(input.context ? {
        context: Object.fromEntries(Object.entries(input.context).map(([key, value]) => [
          key,
          typeof value === "string" ? redactSensitiveText(value) : value,
        ])),
      } : {}),
    };
    const operation = this.writeQueue.then(async () => {
      const currentUtcDay = this.currentUtcDay();
      if (this.archiveAttemptedUtcDay !== currentUtcDay) await this.archiveWithoutBlockingLogs(currentUtcDay);
      await this.writeEntry(entry);
      if (entry.timestamp.slice(0, 10) < currentUtcDay) await this.archiveWithoutBlockingLogs(currentUtcDay);
      this.entries = [...this.entries, entry].slice(-this.maxRecent);
      this.emit("entry", entry);
      return entry;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  archiveExpiredLogs(): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const currentUtcDay = this.currentUtcDay();
      try {
        await this.archiver?.archiveBefore(currentUtcDay);
      } finally {
        this.archiveAttemptedUtcDay = currentUtcDay;
      }
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  recent(): LogEntry[] {
    return [...this.entries];
  }

  private currentUtcDay(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private async archiveWithoutBlockingLogs(currentUtcDay: string): Promise<void> {
    try {
      await this.archiver?.archiveBefore(currentUtcDay);
    } catch (error) {
      console.error("Failed to archive expired logs", error);
    } finally {
      this.archiveAttemptedUtcDay = currentUtcDay;
    }
  }

  private async writeEntry(entry: LogEntry): Promise<void> {
    if (this.strictFiles) await assertPlainPath(this.logDir);
    await mkdir(this.logDir, { recursive: true, ...(this.strictFiles ? { mode: 0o700 } : {}) });
    const day = entry.timestamp.slice(0, 10);
    const target = path.join(this.logDir, `${day}.log`);
    if (!this.strictFiles) {
      await appendFile(target, `${formatReadableEntry(entry)}\n`, "utf8");
      return;
    }
    await assertPlainPath(target);
    const before = await lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (before && (!before.isFile() || before.nlink !== 1)) throw new Error("log_file_type_invalid");
    const handle = await open(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error("log_file_type_invalid");
      await handle.appendFile(`${formatReadableEntry(entry)}\n`, "utf8");
    } finally { await handle.close(); }
  }
}

function formatReadableEntry(entry: LogEntry): string {
  const context: LogContext = { ...(entry.context ?? {}) };
  if (entry.actor?.accountId) context.actorId = entry.actor.accountId;
  if (entry.actor?.steam64) context.actorSteam64 = entry.actor.steam64;
  const parts = [
    formatTimestamp(entry.timestamp),
    entry.level.toUpperCase(),
    entry.source,
    formatActor(entry.actor),
    entry.message,
  ];
  const formattedContext = formatContext(context);
  if (formattedContext) parts.push(formattedContext);
  return parts.map(encodeField).join("|");
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} ${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

function formatActor(actor: LogActor | undefined): string {
  if (!actor) return "-";
  return actor.role ? `${actor.username} (${actor.role})` : actor.username;
}

function formatContext(context: LogContext): string {
  return Object.entries(context)
    .map(([key, value]) => `${key}=${formatContextValue(value)}`)
    .join(" ");
}

function formatContextValue(value: LogContext[string]): string {
  if (typeof value !== "string") return String(value);
  return /^[A-Za-z0-9_./:@,+-]+$/u.test(value) && !/^(?:true|false|null|-?\d+(?:\.\d+)?)$/u.test(value)
    ? value
    : JSON.stringify(value);
}

function encodeField(value: string): string {
  return value
    .replace(/%/gu, "%25")
    .replace(/\|/gu, "%7C")
    .replace(/\r/gu, "%0D")
    .replace(/\n/gu, "%0A");
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}
