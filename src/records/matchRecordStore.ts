import path from "node:path";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import type { MatchPlan } from "../matchmaking/types.js";
import { readJsonFile, writeJsonFileAtomic } from "../storage/jsonFile.js";

interface EventsFile {
  events: unknown[];
}

const SAFE_MATCH_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const eventAppendQueues = new Map<string, Promise<void>>();

export class MatchRecordStore {
  constructor(private readonly recordsDir: string) {}

  async saveMatchPlan(plan: MatchPlan): Promise<void> {
    await writeJsonFileAtomic(this.matchFile(plan.id, "plan.json"), plan);
  }

  async readMatchPlan(matchId: string): Promise<MatchPlan> {
    return readJsonFile<MatchPlan>(this.matchFile(matchId, "plan.json"));
  }

  async listRecentMatchMaps(limit: number): Promise<string[]> {
    if (limit <= 0) return [];
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(this.recordsDir, "matches"), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const plans = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const plan = await this.readMatchPlan(entry.name);
            const map = plan.map.trim();
            if (!map) return undefined;
            return { map, createdAt: plan.createdAt };
          } catch {
            return undefined;
          }
        }),
    );

    return plans
      .filter((plan): plan is { map: string; createdAt: string } => Boolean(plan))
      .sort((a, b) => this.timestampOf(a.createdAt) - this.timestampOf(b.createdAt))
      .slice(-limit)
      .map((plan) => plan.map);
  }

  async saveServer(matchId: string, server: unknown): Promise<void> {
    await this.saveMatchFile(matchId, "server.json", server);
  }

  async saveStatus(matchId: string, status: unknown): Promise<void> {
    await writeJsonFileAtomic(this.matchFile(matchId, "status.json"), status, { pretty: false });
  }

  async saveResult(matchId: string, result: unknown): Promise<void> {
    await this.saveMatchFile(matchId, "result.json", result);
  }

  async readResult<T = unknown>(matchId: string): Promise<T> {
    return readJsonFile<T>(this.matchFile(matchId, "result.json"));
  }

  async appendEvent(matchId: string, event: unknown): Promise<void> {
    const filePath = this.matchFile(matchId, "events.json");
    const previousAppend = eventAppendQueues.get(filePath) ?? Promise.resolve();
    const nextAppend = previousAppend.then(async () => {
      const current = await readJsonFile<EventsFile>(filePath, { events: [] });
      await writeJsonFileAtomic(filePath, { events: [...current.events, event] }, { pretty: false });
    });

    let queuedAppend: Promise<void>;
    queuedAppend = nextAppend
      .finally(() => {
        if (eventAppendQueues.get(filePath) === queuedAppend) {
          eventAppendQueues.delete(filePath);
        }
      })
      .catch(() => undefined);

    eventAppendQueues.set(filePath, queuedAppend);
    await nextAppend;
  }

  async readEvents(matchId: string): Promise<unknown[]> {
    const eventsFile = await readJsonFile<EventsFile>(this.matchFile(matchId, "events.json"), { events: [] });
    return eventsFile.events;
  }

  private async saveMatchFile(matchId: string, fileName: string, value: unknown): Promise<void> {
    await writeJsonFileAtomic(this.matchFile(matchId, fileName), value);
  }

  private matchFile(matchId: string, fileName: string): string {
    this.assertSafeMatchId(matchId);
    return path.join(this.recordsDir, "matches", matchId, fileName);
  }

  private assertSafeMatchId(matchId: string): void {
    if (!SAFE_MATCH_ID_PATTERN.test(matchId)) {
      throw new Error(`Invalid matchId: ${matchId}`);
    }
  }

  private timestampOf(value: string): number {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
}
