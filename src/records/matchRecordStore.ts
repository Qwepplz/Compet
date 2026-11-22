import path from "node:path";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import type { MatchServerExitObservation, MatchServerExitReport } from "../game/matchExecutor.js";
import { gameServerAttemptSchema, gameServerRecordKey, type GameServerAttempt } from "../game/gameServerAttempt.js";
import { z } from "zod";
import { isValidMr12FinalScore } from "../game/get5MatchResult.js";
import { shutdownEvidenceSchema, type ShutdownEvidence } from "../game/shutdownEvidence.js";
import { assertPlainPath } from "../shared/managedFiles.js";
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
const scoreSchema = z.number().int().nonnegative();
const resultHalfSchema = z.object({ team1Score: scoreSchema, team2Score: scoreSchema });
const get5ResultSchema = z.object({
  winner: z.enum(["teamA", "teamB"]),
  team1SeriesScore: scoreSchema, team2SeriesScore: scoreSchema,
  mapName: z.string(), team1Score: scoreSchema, team2Score: scoreSchema,
  team1StartingSide: z.enum(["t", "ct"]), team2StartingSide: z.enum(["t", "ct"]),
  players: z.array(z.object({ steam64: z.string(), team: z.enum(["teamA", "teamB"]) })),
  completedAt: z.iso.datetime({ offset: true }),
  firstHalfScore: resultHalfSchema.optional(), secondHalfScore: resultHalfSchema.optional(),
}).refine((result) => (
  result.team1StartingSide !== result.team2StartingSide
  && result.team1SeriesScore === (result.winner === "teamA" ? 1 : 0)
  && result.team2SeriesScore === (result.winner === "teamB" ? 1 : 0)
  && isValidMr12FinalScore(result.team1Score, result.team2Score, result.winner)
));
const sideHalfSchema = z.object({ t: scoreSchema, ct: scoreSchema });
const exitInfoSchema = z.object({
  code: z.number().int().nullable(),
  signal: z.custom<NodeJS.Signals>((value) => typeof value === "string" && /^SIG[A-Z0-9]+$/.test(value)).nullable(),
  signalNumber: z.number().int().positive().optional(),
  wrapperExitUnconfirmed: z.literal(true).optional(),
  startupFailure: z.enum(["before_engine_exec", "invalid_configuration"]).optional(),
  get5TakeoverLogged: z.boolean().optional(),
  output: z.array(z.string()),
});
const serverExitObservationSchema = z.strictObject({
  matchId: z.string().regex(SAFE_MATCH_ID_PATTERN),
  observedAt: z.iso.datetime({ offset: true }),
  exitInfo: exitInfoSchema,
});
const serverExitReportSchema = z.object({
  exitInfo: exitInfoSchema,
  get5Result: z.union([
    z.object({ status: z.literal("normal"), result: get5ResultSchema }),
    z.object({ status: z.literal("abnormal"), reason: z.string().min(1) }),
  ]),
  competStats: z.array(z.object({
    steam64: z.string(), name: z.string(), kills: scoreSchema, deaths: scoreSchema,
    assists: scoreSchema, damage: scoreSchema, headshots: scoreSchema,
    kastRounds: scoreSchema.optional(), roundsPlayed: scoreSchema.optional(),
  })),
  competHalfScores: z.object({
    firstHalfScore: sideHalfSchema.optional(), secondHalfScore: sideHalfSchema.optional(),
  }).optional(),
});

export class MatchRecordStore {
  private readonly attemptExitWrites = new Map<string, Promise<void>>();

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
    attempt?: GameServerAttempt,
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
    const server = await this.readOptionalMatchFile(matchId, "server.json", attempt);
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

  async readServer(matchId: string, attempt?: GameServerAttempt): Promise<unknown> {
    const file = this.matchFile(matchId, "server.json", attempt);
    if (attempt) await this.assertAttemptFile(file);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      process.stderr.write("Invalid server.json for match " + matchId + "\n");
      return null;
    }
  }

  async saveServer(matchId: string, server: unknown, attempt?: GameServerAttempt): Promise<void> {
    await this.saveMatchFile(matchId, "server.json", server, { durable: !!attempt }, attempt);
  }

  async readServerExitReport(matchId: string, attempt?: GameServerAttempt): Promise<MatchServerExitReport | undefined> {
    const file = this.matchFile(matchId, "server-exit.json", attempt);
    if (attempt) await this.assertAttemptFile(file);
    let raw: string;
    try { raw = await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const report = serverExitReportSchema.safeParse(JSON.parse(raw));
    if (!report.success) throw new Error("Invalid saved server exit report: " + matchId, { cause: report.error });
    return report.data;
  }

  async saveServerExitReport(matchId: string, report: MatchServerExitReport, attempt?: GameServerAttempt): Promise<void> {
    const options = { pretty: false, durable: true };
    if (attempt) {
      await this.saveFirstAttemptExit(matchId, "server-exit.json", attempt, options,
        serverExitReportSchema.parse(report), () => this.readServerExitReport(matchId, attempt));
      return;
    }
    await this.saveMatchFile(matchId, "server-exit.json", report, options);
  }

  async readServerExitObservation(matchId: string, attempt?: GameServerAttempt): Promise<MatchServerExitObservation | undefined> {
    return this.readShutdownCheckpoint(matchId, "server-exit-observed.json", serverExitObservationSchema, attempt);
  }

  async saveServerExitObservation(matchId: string, observation: MatchServerExitObservation, attempt?: GameServerAttempt): Promise<void> {
    await this.saveShutdownCheckpoint(matchId, "server-exit-observed.json", serverExitObservationSchema, observation, attempt);
  }

  async readShutdownEvidence(matchId: string, attempt?: GameServerAttempt): Promise<ShutdownEvidence | undefined> {
    return this.readShutdownCheckpoint(matchId, "shutdown-evidence.json", shutdownEvidenceSchema, attempt);
  }

  async saveShutdownEvidence(matchId: string, evidence: ShutdownEvidence, attempt?: GameServerAttempt): Promise<void> {
    await this.saveShutdownCheckpoint(matchId, "shutdown-evidence.json", shutdownEvidenceSchema, evidence, attempt);
  }

  gameServerEngineExecPath(matchId: string, attempt: GameServerAttempt): string {
    return this.matchFile(matchId, "engine-exec", attempt);
  }

  async listGameServerAttemptIds(matchId: string): Promise<string[]> {
    const directory = this.matchFile(matchId, "attempts");
    await assertPlainPath(directory);
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.filter(entry => gameServerAttemptSchema.shape.id.safeParse(entry.name).success).map(entry => {
        if (!entry.isDirectory()) throw new Error("Invalid game server attempt directory: " + entry.name);
        return entry.name;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
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

  private async readShutdownCheckpoint<T extends { matchId: string }>(
    matchId: string, fileName: string, schema: z.ZodType<T>, attempt?: GameServerAttempt,
  ): Promise<T | undefined> {
    const file = this.matchFile(matchId, fileName, attempt);
    if (attempt) await this.assertAttemptFile(file);
    else await assertPlainPath(file);
    let raw: string;
    try {
      if (!attempt && !(await lstat(file)).isFile()) throw new Error("Invalid checkpoint file: " + file);
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const checkpoint = schema.parse(JSON.parse(raw));
      if (checkpoint.matchId !== gameServerRecordKey(matchId, attempt)) throw new Error("matchId mismatch");
      return checkpoint;
    } catch (error) {
      throw new Error("Invalid " + fileName + " for " + matchId, { cause: error });
    }
  }

  private async saveShutdownCheckpoint<T extends { matchId: string }>(
    matchId: string, fileName: string, schema: z.ZodType<T>, input: T, attempt?: GameServerAttempt,
  ): Promise<void> {
    const checkpoint = schema.parse(input);
    if (checkpoint.matchId !== gameServerRecordKey(matchId, attempt)) {
      throw new Error("Invalid matchId for " + fileName + ": " + matchId);
    }
    const options = { pretty: false, durable: true, createParent: fileName === "shutdown-evidence.json" };
    if (attempt && fileName === "server-exit-observed.json") {
      await this.saveFirstAttemptExit(matchId, fileName, attempt, options, checkpoint,
        () => this.readShutdownCheckpoint(matchId, fileName, schema, attempt));
      return;
    }
    await this.saveMatchFile(matchId, fileName, checkpoint, options, attempt);
  }

  private async saveFirstAttemptExit<T>(
    matchId: string, fileName: string, attempt: GameServerAttempt,
    options: { pretty: boolean; durable: boolean; createParent?: boolean },
    value: T, read: () => Promise<T | undefined>,
  ): Promise<void> {
    const file = this.matchFile(matchId, fileName, attempt);
    const previous = this.attemptExitWrites.get(file) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      // Reconfirm durability if an earlier write renamed the file and failed during sync.
      const saved = await read();
      await this.saveMatchFile(matchId, fileName, saved ?? value, options, attempt);
    });
    this.attemptExitWrites.set(file, write);
    try {
      await write;
    } finally {
      if (this.attemptExitWrites.get(file) === write) this.attemptExitWrites.delete(file);
    }
  }

  private async assertAttemptFile(file: string): Promise<void> {
    await assertPlainPath(file);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.nlink !== 1) throw new Error("Invalid attempt record file: " + file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async saveMatchFile(
    matchId: string,
    fileName: string,
    value: unknown,
    options: { pretty?: boolean; durable?: boolean; createParent?: boolean } = {},
    attempt?: GameServerAttempt,
  ): Promise<void> {
    if (this.readMatchRow(matchId)) return;
    const filePath = this.matchFile(matchId, fileName, attempt);
    if (attempt) await this.assertAttemptFile(filePath);
    await writeJsonFileAtomic(filePath, value, options);
  }

  private async readOptionalMatchFile(matchId: string, fileName: string, attempt?: GameServerAttempt): Promise<string | null> {
    const file = this.matchFile(matchId, fileName, attempt);
    try {
      if (attempt) {
        await this.assertAttemptFile(file);
        return serializeJson(JSON.parse(await readFile(file, "utf8")));
      }
      return serializeJson(await readJsonFile<unknown>(file));
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

  private matchFile(matchId: string, fileName: string, attempt?: GameServerAttempt): string {
    this.assertSafeMatchId(matchId);
    const directory = path.join(this.recordsDir, "matches", matchId);
    return attempt
      ? path.join(directory, "attempts", gameServerRecordKey(matchId, attempt), fileName)
      : path.join(directory, fileName);
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
