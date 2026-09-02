import path from "node:path";
import { rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { MatchPlan, MatchSeriesResult } from "../matchmaking/types.js";
import { withDatabaseTransaction } from "../storage/competDatabase.js";
import { pathExists, readJsonFile, writeJsonFileAtomic } from "../storage/jsonFile.js";

interface EventsFile {
  events: unknown[];
}

export interface CompletedMatchRecord {
  matchId: string;
  plan: MatchPlan;
  result: MatchSeriesResult;
  completionEventPublished?: true;
}

const SAFE_MATCH_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class MatchRecordStore {
  constructor(
    private readonly recordsDir: string,
    private readonly database: DatabaseSync,
  ) {}

  async saveMatchPlan(plan: MatchPlan): Promise<void> {
    this.assertSafeMatchId(plan.id);
    if (this.readMatchRow(plan.id)) return;
    await writeJsonFileAtomic(this.matchFile(plan.id, "plan.json"), plan);
  }

  async readMatchPlan(matchId: string): Promise<MatchPlan> {
    const row = this.readMatchRow(matchId);
    if (row) return parseJson<MatchPlan>(row.plan_json, `matches.plan_json for ${matchId}`);
    return readJsonFile<MatchPlan>(this.matchFile(matchId, "plan.json"));
  }

  async completeMatch(
    matchId: string,
    result: MatchSeriesResult,
    status: unknown,
  ): Promise<void> {
    this.assertSafeMatchId(matchId);
    const existing = this.readMatchRow(matchId);
    if (existing) {
      const existingResult = parseJson<MatchSeriesResult>(existing.result_json, `matches.result_json for ${matchId}`);
      const existingStatus = existing.status_json === null
        ? null
        : parseJson<unknown>(existing.status_json, `matches.status_json for ${matchId}`);
      if (stableJson(existingResult) !== stableJson(result) || stableJson(existingStatus) !== stableJson(status)) {
        throw new Error(`completed match content conflict: ${matchId}`);
      }
      return;
    }

    const plan = await this.readMatchPlan(matchId);
    if (plan.id !== matchId) throw new Error(`match plan id does not match matchId: ${matchId}`);
    const server = await this.readOptionalMatchFile(matchId, "server.json");
    const events = await this.readOptionalMatchFile(matchId, "events.json");
    const statusJson = status === undefined || status === null ? null : serializeJson(status);
    const resultJson = serializeJson(result);
    const completedAt = result.completedAt;

    withDatabaseTransaction(this.database, (database) => {
      database.prepare(`
        INSERT INTO matches (
          id, map, created_at, completed_at, plan_json, result_json, status_json, server_json, events_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        matchId,
        plan.map,
        plan.createdAt,
        completedAt,
        serializeJson(plan),
        resultJson,
        statusJson,
        server,
        events,
      );

      if (plan.dev === true) return;

      const participantStatement = database.prepare(`
        INSERT INTO match_participants (match_id, steam64, side)
        VALUES (?, ?, ?)
      `);
      for (const [side, team] of [["teamA", plan.teamA], ["teamB", plan.teamB]] as const) {
        for (const participant of team.participants) {
          const steam64 = participant.kind === "human" ? participant.steam64?.trim() : undefined;
          if (!steam64) continue;
          participantStatement.run(matchId, steam64, side);
        }
      }
    });
  }

  async readCompletedMatch(matchId: string): Promise<CompletedMatchRecord | null> {
    const row = this.readMatchRow(matchId);
    if (!row) return null;
    const completed: CompletedMatchRecord = {
      matchId,
      plan: parseJson<MatchPlan>(row.plan_json, `matches.plan_json for ${matchId}`),
      result: parseJson<MatchSeriesResult>(row.result_json, `matches.result_json for ${matchId}`),
    };
    return this.hasCompletionEvent(row.events_json, matchId)
      ? { ...completed, completionEventPublished: true }
      : completed;
  }

  async listPlayerCompletedMatches(
    steam64: string,
    pagination: { page: number; pageSize: number },
  ): Promise<{ matches: CompletedMatchRecord[]; total: number }> {
    const normalizedSteam64 = steam64.trim();
    if (pagination.page <= 0 || pagination.pageSize <= 0 || !normalizedSteam64) {
      return { matches: [], total: 0 };
    }

    const totalRow = this.database.prepare(`
      SELECT COUNT(*) AS total
      FROM match_participants
      WHERE steam64 = ?
    `).get(normalizedSteam64);
    const total = Number(totalRow?.total ?? 0);
    const offset = (pagination.page - 1) * pagination.pageSize;
    const rows = this.database.prepare(`
      SELECT m.id, m.plan_json, m.result_json
      FROM matches AS m
      WHERE EXISTS (
        SELECT 1
        FROM match_participants AS p
        WHERE p.match_id = m.id AND p.steam64 = ?
      )
      ORDER BY m.completed_at DESC, m.id DESC
      LIMIT ? OFFSET ?
    `).all(normalizedSteam64, pagination.pageSize, offset);

    return {
      matches: rows.map((row) => this.completedMatchFromRow(row)),
      total,
    };
  }

  async readPlayerCompletedMatch(steam64: string, matchId: string): Promise<CompletedMatchRecord | null> {
    this.assertSafeMatchId(matchId);
    const normalizedSteam64 = steam64.trim();
    if (!normalizedSteam64) return null;
    const row = this.database.prepare(`
      SELECT m.id, m.plan_json, m.result_json
      FROM matches AS m
      INNER JOIN match_participants AS p ON p.match_id = m.id
      WHERE m.id = ? AND p.steam64 = ?
    `).get(matchId, normalizedSteam64);
    return row ? this.completedMatchFromRow(row) : null;
  }

  async listRecentMatchMaps(limit: number): Promise<string[]> {
    if (limit <= 0) return [];
    const rows = this.database.prepare(`
      SELECT m.map
      FROM matches AS m
      WHERE trim(m.map) <> ''
        AND EXISTS (
          SELECT 1
          FROM match_participants AS p
          WHERE p.match_id = m.id
        )
      ORDER BY m.created_at ASC, m.id ASC
    `).all();
    return rows
      .slice(-limit)
      .map((row) => String(row.map).trim())
      .filter((map) => map.length > 0);
  }

  async saveServer(matchId: string, server: unknown): Promise<void> {
    this.assertSafeMatchId(matchId);
    await this.saveMatchFile(matchId, "server.json", server);
  }

  async saveStatus(matchId: string, status: unknown): Promise<void> {
    this.assertSafeMatchId(matchId);
    await this.saveMatchFile(matchId, "status.json", status, { pretty: false });
  }

  async deleteMatch(matchId: string): Promise<void> {
    this.assertSafeMatchId(matchId);
    withDatabaseTransaction(this.database, (database) => {
      database.prepare("DELETE FROM matches WHERE id = ?").run(matchId);
    });
    await rm(path.join(this.recordsDir, "matches", matchId), { recursive: true, force: true });
  }

  async cleanupCompletedMatchFiles(matchId: string): Promise<void> {
    this.assertSafeMatchId(matchId);
    await rm(path.join(this.recordsDir, "matches", matchId), { recursive: true, force: true });
  }

  async appendEvent(matchId: string, event: unknown): Promise<void> {
    this.assertSafeMatchId(matchId);
    if (this.readMatchRow(matchId)) {
      const appended = withDatabaseTransaction(this.database, (database) => {
        const row = database.prepare("SELECT events_json FROM matches WHERE id = ?").get(matchId) as Record<string, unknown> | undefined;
        if (!row) return false;
        const events = row.events_json === null || row.events_json === undefined
          ? []
          : parseJson<EventsFile>(row.events_json, `matches.events_json for ${matchId}`).events;
        database.prepare("UPDATE matches SET events_json = ? WHERE id = ?").run(
          serializeJson({ events: [...events, event] }),
          matchId,
        );
        return true;
      });
      if (appended) return;
    }

    const filePath = this.matchFile(matchId, "events.json");
    if (!(await pathExists(path.dirname(filePath)))) return;
    try {
      const current = await readJsonFile<EventsFile>(filePath, { events: [] });
      await writeJsonFileAtomic(filePath, { events: [...current.events, event] }, { pretty: false, createParent: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async saveMatchFile(
    matchId: string,
    fileName: string,
    value: unknown,
    options: { pretty?: boolean } = {},
  ): Promise<void> {
    if (this.readMatchRow(matchId)) return;
    const filePath = this.matchFile(matchId, fileName);
    await writeJsonFileAtomic(filePath, value, options);
  }

  private async readOptionalMatchFile(matchId: string, fileName: string): Promise<string | null> {
    try {
      const value = await readJsonFile<unknown>(this.matchFile(matchId, fileName));
      return serializeJson(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error instanceof Error && error.message.startsWith("JSON file does not exist:"))) return null;
      throw error;
    }
  }

  private readMatchRow(matchId: string): Record<string, unknown> | undefined {
    this.assertSafeMatchId(matchId);
    return this.database.prepare(`
      SELECT id, map, created_at, completed_at, plan_json, result_json, status_json, server_json, events_json
      FROM matches WHERE id = ?
    `).get(matchId) as Record<string, unknown> | undefined;
  }

  private completedMatchFromRow(row: Record<string, unknown>): CompletedMatchRecord {
    const matchId = String(row.id);
    const completed: CompletedMatchRecord = {
      matchId,
      plan: parseJson<MatchPlan>(row.plan_json, `matches.plan_json for ${matchId}`),
      result: parseJson<MatchSeriesResult>(row.result_json, `matches.result_json for ${matchId}`),
    };
    return this.hasCompletionEvent(row.events_json, matchId)
      ? { ...completed, completionEventPublished: true }
      : completed;
  }

  private hasCompletionEvent(eventsJson: unknown, matchId: string): boolean {
    if (eventsJson === null || eventsJson === undefined) return false;
    const events = parseJson<EventsFile>(eventsJson, `matches.events_json for ${matchId}`).events;
    return events.some((event) => (
      typeof event === "object"
      && event !== null
      && (event as { type?: unknown }).type === "match_completed"
    ));
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
}

function parseJson<T>(value: unknown, field: string): T {
  if (typeof value !== "string") throw new Error(`Invalid JSON value in ${field}`);
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Invalid JSON value in ${field}`, { cause: error });
  }
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value)) ?? "null";
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}
