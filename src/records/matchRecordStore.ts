import path from "node:path";
import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import type { MatchPlan, MatchSeriesResult } from "../matchmaking/types.js";
import { readJsonFile, writeJsonFileAtomic } from "../storage/jsonFile.js";

interface EventsFile {
  events: unknown[];
}

export interface CompletedMatchRecord {
  matchId: string;
  plan: MatchPlan;
  result: MatchSeriesResult;
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

  async listPlayerCompletedMatches(
    steam64: string,
    pagination: { page: number; pageSize: number },
  ): Promise<{ matches: CompletedMatchRecord[]; total: number }> {
    const normalizedSteam64 = steam64.trim();
    if (pagination.page <= 0 || pagination.pageSize <= 0 || !normalizedSteam64) {
      return { matches: [], total: 0 };
    }
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(this.recordsDir, "matches"), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { matches: [], total: 0 };
      throw error;
    }

    const completedMatches = (await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readPlayerCompletedMatch(normalizedSteam64, entry.name)),
    ))
      .filter((match): match is CompletedMatchRecord => Boolean(match))
      .sort((a, b) => this.timestampOf(b.result.completedAt) - this.timestampOf(a.result.completedAt));
    const start = (pagination.page - 1) * pagination.pageSize;

    return {
      matches: completedMatches.slice(start, start + pagination.pageSize),
      total: completedMatches.length,
    };
  }

  async readPlayerCompletedMatch(steam64: string, matchId: string): Promise<CompletedMatchRecord | null> {
    const normalizedSteam64 = steam64.trim();
    if (!normalizedSteam64) return null;
    try {
      const plan = await this.readMatchPlan(matchId);
      if (!this.planIncludesSteam64(plan, normalizedSteam64)) return null;
      const result = await this.readResult<MatchSeriesResult>(matchId);
      return { matchId, plan, result };
    } catch {
      return null;
    }
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
            const result = await this.readResult<Partial<MatchSeriesResult>>(entry.name);
            if (typeof result.completedAt !== "string") return undefined;
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

  async deleteMatch(matchId: string): Promise<void> {
    this.assertSafeMatchId(matchId);
    await rm(path.join(this.recordsDir, "matches", matchId), { recursive: true, force: true });
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

  private planIncludesSteam64(plan: MatchPlan, steam64: string): boolean {
    return [...plan.teamA.participants, ...plan.teamB.participants].some((participant) =>
      participant.kind === "human" && participant.steam64?.trim() === steam64
    );
  }

  private timestampOf(value: string): number {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
}
