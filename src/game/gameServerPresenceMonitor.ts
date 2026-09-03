import { readCurrentStatus, type EmptyServerStatus } from "./emptyServerWatchdog.js";

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_STALE_AFTER_MS = 90_000;

export interface GameServerPresenceMonitorOptions {
  serverRoot: string;
  matchId: string;
  onChange: (steam64s: readonly string[]) => Promise<void> | void;
  intervalMs?: number;
  staleAfterMs?: number;
  nowMs?: () => number;
}

export class GameServerPresenceMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private pendingCheck?: Promise<void>;
  private stopping?: Promise<void>;
  private running = false;
  private stopped = false;
  private currentSteam64s: string[] = [];
  private lastStatusGeneratedAtMs?: number;

  constructor(private readonly options: GameServerPresenceMonitorOptions) {}

  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
    void this.poll();
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.stopped) return;
    this.running = false;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.stopping = (async () => {
      await this.pendingCheck;
      await this.publishIfChanged([]);
    })();
    await this.stopping;
  }

  private poll(): Promise<void> {
    if (!this.running || this.pendingCheck) return Promise.resolve();
    const pending = this.readAndApply().catch(() => undefined);
    const tracked = pending.finally(() => {
      if (this.pendingCheck === tracked) this.pendingCheck = undefined;
    });
    this.pendingCheck = tracked;
    return tracked;
  }

  private async readAndApply(): Promise<void> {
    const status = await readCurrentStatus(this.options.serverRoot, this.options.matchId, {
      staleAfterMs: this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      nowMs: this.options.nowMs ?? Date.now,
    });
    if (!this.running) return;
    if (status) {
      this.lastStatusGeneratedAtMs = status.generatedAtUnix * 1_000;
      await this.publishIfChanged(normalizeSteam64s(status));
      return;
    }
    const nowMs = (this.options.nowMs ?? Date.now)();
    if (
      this.lastStatusGeneratedAtMs !== undefined
      && nowMs - this.lastStatusGeneratedAtMs > (this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)
    ) {
      await this.publishIfChanged([]);
    }
  }

  private async publishIfChanged(nextSteam64s: string[]): Promise<void> {
    if (sameSteam64s(this.currentSteam64s, nextSteam64s)) return;
    await this.options.onChange(nextSteam64s);
    this.currentSteam64s = nextSteam64s;
  }
}

function normalizeSteam64s(status: EmptyServerStatus): string[] {
  return [...new Set(status.humans.filter((steam64) => steam64.trim().length > 0))].sort();
}

function sameSteam64s(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((steam64, index) => steam64 === right[index]);
}
