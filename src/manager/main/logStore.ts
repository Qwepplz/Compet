import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { LOG_LEVELS, LOG_SOURCES, type ActivityLogInput, type LogActor } from "../../shared/activityLog.js";
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

  async listFiles(): Promise<string[]> {
    try {
      return (await readdir(this.logDir)).filter((name) => name.endsWith(".log")).sort().reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async readFile(name: string): Promise<LogEntry[]> {
    if (name.includes("..") || path.basename(name) !== name || !name.endsWith(".log")) {
      throw new Error("invalid log file name");
    }
    await this.writeQueue;
    const content = await readFile(path.join(this.logDir, name), "utf8");
    return content
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line, index) => {
        const entry = parseLegacyEntry(line) ?? parseReadableEntry(line, index);
        return entry ? [entry] : [];
      });
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

function parseLegacyEntry(line: string): LogEntry | undefined {
  try {
    const entry = JSON.parse(line) as Partial<LogEntry>;
    return typeof entry.id === "string"
      && typeof entry.timestamp === "string"
      && isLogLevel(entry.level)
      && isLogSource(entry.source)
      && typeof entry.message === "string"
      ? entry as LogEntry
      : undefined;
  } catch {
    return undefined;
  }
}

function parseReadableEntry(line: string, index: number): LogEntry | undefined {
  const parts = line.split("|").map(decodeField);
  if (parts.length < 5) return undefined;
  const [timestampText, levelText, sourceText, actorText, messageText, ...contextParts] = parts;
  const timestamp = parseTimestamp(timestampText);
  const level = levelText.toLowerCase();
  if (!timestamp || !isLogLevel(level) || !isLogSource(sourceText)) return undefined;

  const context = parseContext(contextParts.join("|"));
  const actor = parseActor(actorText, context);
  return {
    id: `history-${index}-${timestamp}`,
    timestamp,
    level,
    source: sourceText,
    message: messageText,
    ...(actor ? { actor } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} ${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

function parseTimestamp(value: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) ([+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return undefined;
  const date = new Date(`${match[1]}T${match[2]}${match[3]}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatActor(actor: LogActor | undefined): string {
  if (!actor) return "-";
  return actor.role ? `${actor.username} (${actor.role})` : actor.username;
}

function parseActor(value: string, context: LogContext): LogActor | undefined {
  const accountId = takeContextString(context, "actorId");
  const steam64 = takeContextString(context, "actorSteam64");
  if (value === "-") return undefined;
  const match = /^(.*?)(?: \((admin|player)\))?$/u.exec(value);
  const username = match?.[1] || value;
  const role = match?.[2];
  return {
    username,
    ...(role === "admin" || role === "player" ? { role } : {}),
    ...(accountId ? { accountId } : {}),
    ...(steam64 ? { steam64 } : {}),
  };
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

function parseContext(value: string): LogContext {
  const context: LogContext = {};
  const pattern = /([A-Za-z][A-Za-z0-9]*)=((?:"(?:\\.|[^"\\])*")|[^\s]+)/gu;
  for (const match of value.matchAll(pattern)) {
    context[match[1]] = parseContextValue(match[2]);
  }
  return context;
}

function parseContextValue(value: string): LogContext[string] {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  return value;
}

function takeContextString(context: LogContext, key: string): string | undefined {
  const value = context[key];
  delete context[key];
  return typeof value === "string" ? value : undefined;
}

function encodeField(value: string): string {
  return value
    .replace(/%/gu, "%25")
    .replace(/\|/gu, "%7C")
    .replace(/\r/gu, "%0D")
    .replace(/\n/gu, "%0A");
}

function decodeField(value: string): string {
  return value.replace(/%(25|7C|0D|0A)/gu, (encoded) => {
    if (encoded === "%25") return "%";
    if (encoded === "%7C") return "|";
    if (encoded === "%0D") return "\r";
    return "\n";
  });
}

function isLogLevel(value: unknown): value is LogEntry["level"] {
  return typeof value === "string" && LOG_LEVELS.includes(value as LogEntry["level"]);
}

function isLogSource(value: unknown): value is LogEntry["source"] {
  return typeof value === "string" && LOG_SOURCES.includes(value as LogEntry["source"]);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}
