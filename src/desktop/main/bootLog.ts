import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function candidateLogPaths(fileName: string): string[] {
  const paths: string[] = [];
  if (process.execPath) {
    paths.push(path.join(path.dirname(process.execPath), fileName));
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    paths.push(path.join(localAppData, "Compet", fileName));
  }
  paths.push(path.join(os.tmpdir(), fileName));
  return paths;
}

export function appendBootLog(fileName: string, message: string, error?: unknown): void {
  const line = `[${new Date().toISOString()}] ${message}${error === undefined ? "" : `\n${normalizeError(error)}`}\n`;
  for (const logPath of candidateLogPaths(fileName)) {
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      appendFileSync(logPath, line, "utf8");
      return;
    } catch {
      // Try the next location; boot logging must never block app startup.
    }
  }
}

export function describeBootEnvironment(): string {
  return [
    `execPath=${process.execPath}`,
    `cwd=${process.cwd()}`,
    `platform=${process.platform}`,
    `arch=${process.arch}`,
    `electron=${process.versions.electron ?? "unknown"}`,
    `chrome=${process.versions.chrome ?? "unknown"}`,
    `node=${process.versions.node}`,
  ].join("; ");
}
