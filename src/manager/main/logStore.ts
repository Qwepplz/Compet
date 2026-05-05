import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type { LogEntry, LogLevel } from "../shared/types.js";
import { redactSensitiveText } from "./redact.js";

export class FileLogStore {
  private entries: LogEntry[] = [];

  constructor(private readonly logDir: string, private readonly maxRecent = 500) {}

  async append(source: LogEntry["source"], level: LogLevel, message: string): Promise<LogEntry> {
    const entry: LogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      source,
      level,
      message: redactSensitiveText(message),
    };
    await this.writeEntry(entry);
    this.entries = [...this.entries, entry].slice(-this.maxRecent);
    return entry;
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

  async readFile(name: string): Promise<string> {
    if (name.includes("..") || path.basename(name) !== name || !name.endsWith(".log")) {
      throw new Error("invalid log file name");
    }
    return readFile(path.join(this.logDir, name), "utf8");
  }

  private async writeEntry(entry: LogEntry): Promise<void> {
    await mkdir(this.logDir, { recursive: true });
    const day = entry.timestamp.slice(0, 10);
    await appendFile(path.join(this.logDir, `${day}.log`), `${JSON.stringify(entry)}\n`, "utf8");
  }
}
