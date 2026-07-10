import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityLogInput } from "../../shared/activityLog.js";
import type { LogEntry } from "../shared/types.js";
import { redactSensitiveText } from "./redact.js";

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
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line) as Partial<LogEntry>;
          return typeof entry.id === "string"
            && typeof entry.timestamp === "string"
            && typeof entry.source === "string"
            && typeof entry.level === "string"
            && typeof entry.message === "string"
            ? [entry as LogEntry]
            : [];
        } catch {
          return [];
        }
      });
  }

  private async writeEntry(entry: LogEntry): Promise<void> {
    await mkdir(this.logDir, { recursive: true });
    const day = entry.timestamp.slice(0, 10);
    await appendFile(path.join(this.logDir, `${day}.log`), `${JSON.stringify(entry)}\n`, "utf8");
  }
}
