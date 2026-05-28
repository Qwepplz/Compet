import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface EmptyServerWatchdogConfig {
  enabled?: boolean;
  initialDelayMs?: number;
  intervalMs?: number;
  staleAfterMs?: number;
  emptyChecksBeforeShutdown?: number;
}

export interface EmptyServerStatus {
  matchId: string;
  generatedAtUnix: number;
  connectedCount: number;
  humanCount: number;
  botCount: number;
  humans: string[];
}

export interface EmptyServerWatchdogOptions {
  matchId: string;
  serverRoot: string;
  config?: EmptyServerWatchdogConfig;
  records?: { appendEvent(matchId: string, event: unknown): Promise<void> };
  nowMs?: () => number;
}

const DEFAULT_INITIAL_DELAY_MS = 60_000;
const DEFAULT_INTERVAL_MS = 120_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_EMPTY_CHECKS_BEFORE_SHUTDOWN = 5;

export class EmptyServerWatchdog {
  private emptyChecks = 0;
  private checking = false;
  private shutdownRequested = false;
  private startTimer?: ReturnType<typeof setTimeout>;
  private intervalTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: EmptyServerWatchdogOptions) {}

  start(): void {
    if (this.options.config?.enabled === false || this.startTimer || this.intervalTimer || this.shutdownRequested) {
      return;
    }

    const delayMs = this.options.config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      void this.checkOnce();
      this.intervalTimer = setInterval(() => {
        void this.checkOnce();
      }, this.options.config?.intervalMs ?? DEFAULT_INTERVAL_MS);
      unrefTimer(this.intervalTimer);
    }, delayMs);
    unrefTimer(this.startTimer);
  }

  stop(): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = undefined;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
  }

  async checkOnce(): Promise<void> {
    if (this.checking || this.shutdownRequested) return;
    this.checking = true;
    try {
      const status = await readCurrentStatus(this.options.serverRoot, this.options.matchId, {
        staleAfterMs: this.options.config?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
        nowMs: this.options.nowMs ?? Date.now,
      });
      if (!status) return;

      if (status.humanCount > 0) {
        this.emptyChecks = 0;
        return;
      }

      this.emptyChecks += 1;
      const limit = this.options.config?.emptyChecksBeforeShutdown ?? DEFAULT_EMPTY_CHECKS_BEFORE_SHUTDOWN;
      if (this.emptyChecks < limit) return;

      this.shutdownRequested = true;
      this.stop();
      await requestSourceModShutdown(this.options.serverRoot, this.options.matchId);
      await this.options.records?.appendEvent(this.options.matchId, {
        type: "empty_server_shutdown_requested",
        at: new Date(this.options.nowMs?.() ?? Date.now()).toISOString(),
        emptyChecks: this.emptyChecks,
        humanCount: status.humanCount,
        botCount: status.botCount,
      });
    } finally {
      this.checking = false;
    }
  }
}

export async function readCurrentStatus(
  serverRoot: string,
  matchId: string,
  options: { staleAfterMs: number; nowMs: () => number },
): Promise<EmptyServerStatus | undefined> {
  let raw: string;
  try {
    raw = await readFile(sourceModStatusPath(serverRoot), "utf8");
  } catch {
    return undefined;
  }

  const status = parseEmptyServerStatus(raw);
  if (!status || status.matchId !== matchId) return undefined;
  if (options.nowMs() - status.generatedAtUnix * 1000 > options.staleAfterMs) return undefined;
  return status;
}

export async function requestSourceModShutdown(serverRoot: string, matchId: string): Promise<void> {
  const flagPath = sourceModShutdownFlagPath(serverRoot);
  await mkdir(path.dirname(flagPath), { recursive: true });
  await writeFile(flagPath, `${matchId}\n`, "utf8");
}

export function sourceModStatusPath(serverRoot: string): string {
  return path.join(sourceModCompetDataDir(serverRoot), "server_status.json");
}

export function sourceModShutdownFlagPath(serverRoot: string): string {
  return path.join(sourceModCompetDataDir(serverRoot), "shutdown.flag");
}

export function parseEmptyServerStatus(raw: string): EmptyServerStatus | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  if (typeof record.matchId !== "string" || record.matchId.length === 0) return undefined;
  if (!isNonNegativeFinite(record.generatedAtUnix)) return undefined;
  if (!isNonNegativeInteger(record.connectedCount)) return undefined;
  if (!isNonNegativeInteger(record.humanCount)) return undefined;
  if (!isNonNegativeInteger(record.botCount)) return undefined;
  if (!Array.isArray(record.humans) || !record.humans.every((human) => typeof human === "string")) {
    return undefined;
  }

  return {
    matchId: record.matchId,
    generatedAtUnix: record.generatedAtUnix,
    connectedCount: record.connectedCount,
    humanCount: record.humanCount,
    botCount: record.botCount,
    humans: record.humans,
  };
}

function sourceModCompetDataDir(serverRoot: string): string {
  return path.join(serverRoot, "csgo", "addons", "sourcemod", "data", "compet");
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  timer.unref?.();
}
