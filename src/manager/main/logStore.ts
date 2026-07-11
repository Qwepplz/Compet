import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { type ActivityLogInput, type LogActor } from "../../shared/activityLog.js";
import type { LogEntry } from "../shared/types.js";
import { redactSensitiveText } from "./redact.js";

type LogContext = NonNullable<LogEntry["context"]>;

export class FileLogStore extends EventEmitter {
  private entries: LogEntry[] = [];
  private writeQueue = Promise.resolve();

  constructor(private readonly logDir: string, private readonly maxRecent = 2_000) {
    super();
  }

  append(input: ActivityLogInput): Promise<LogEntry> {
    const entry: LogEntry = {
      ...input,
      id: randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      message: redactSensitiveText(input.message.trim()),
      ...(input.context ? {
        context: Object.fromEntries(Object.entries(input.context).map(([key, value]) => [
          key,
          typeof value === "string" ? redactSensitiveText(value) : value,
        ])),
      } : {}),
    };
    const operation = this.writeQueue.then(async () => {
      await this.writeEntry(entry);
      this.entries = [...this.entries, entry].slice(-this.maxRecent);
      this.emit("entry", entry);
      return entry;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  recent(): LogEntry[] {
    return [...this.entries];
  }

  private async writeEntry(entry: LogEntry): Promise<void> {
    await mkdir(this.logDir, { recursive: true });
    const day = entry.timestamp.slice(0, 10);
    await appendFile(path.join(this.logDir, `${day}.log`), `${formatReadableEntry(entry)}\n`, "utf8");
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
