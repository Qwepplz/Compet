import { randomUUID } from "node:crypto";
import { readdir, rename, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { USERNAME_PATTERN, type AccountRecord } from "../accounts/accountTypes.js";
import type { SessionRecord } from "../auth/sessionRepository.js";
import type { FriendRequestRecord, FriendshipRecord } from "../friends/friendStore.js";
import type { MatchHalfScore, MatchPlan, MatchPlayerResult, MatchSeriesResult } from "../matchmaking/types.js";
import { pathExists, readJsonFile } from "./jsonFile.js";
import { configureCompetDatabase, withDatabaseTransaction } from "./competDatabase.js";
import { assertSqliteIntegrity, applySqliteMigrations } from "./sqliteMigrations.js";

const SAFE_MATCH_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MATCH_PHASES = ["queue", "ready", "match_room", "map_randomizing", "server_prepare", "connect", "live", "completed", "failed"];

interface LegacyImportReport {
  accounts: number;
  sessions: number;
  skippedRevokedSessions: number;
  skippedExpiredSessions: number;
  skippedOrphanSessions: number;
  friendships: number;
  friendRequests: number;
  matches: number;
  skippedIncompleteMatches: number;
}

interface LegacyData {
  accounts: AccountRecord[];
  sessions: SessionRecord[];
  friendships: FriendshipRecord[];
  requests: FriendRequestRecord[];
  matches: LegacyMatch[];
  skippedIncompleteMatches: number;
}

interface LegacyMatch {
  id: string;
  plan: MatchPlan;
  result: MatchSeriesResult;
  statusJson: string | null;
  serverJson: string | null;
  eventsJson: string | null;
}

export async function hasLegacyPersistence(recordsDir: string): Promise<boolean> {
  const legacyFiles = [
    path.join(recordsDir, "accounts.json"),
    path.join(recordsDir, "sessions.json"),
    path.join(recordsDir, "friends", "friendships.json"),
    path.join(recordsDir, "friends", "requests.json"),
  ];
  for (const filePath of legacyFiles) {
    if (await pathExists(filePath)) return true;
  }

  try {
    const entries = await readdir(path.join(recordsDir, "matches"), { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function importLegacyJsonData(
  recordsDir: string,
  databasePath: string,
  options: { now?: Date } = {},
): Promise<LegacyImportReport> {
  const temporaryPath = `${databasePath}.migrating-${randomUUID()}`;
  let database: DatabaseSync | undefined;

  try {
    const legacy = await readLegacyData(recordsDir);
    database = new DatabaseSync(temporaryPath);
    configureCompetDatabase(database);
    applySqliteMigrations(database);

    const now = options.now?.getTime() ?? Date.now();
    const report = withDatabaseTransaction(database, (connection) => importIntoDatabase(connection, legacy, now));
    assertSqliteIntegrity(database);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.close();
    database = undefined;

    if (await pathExists(`${temporaryPath}-wal`) || await pathExists(`${temporaryPath}-shm`)) {
      throw new Error("SQLite migration left unmerged temporary sidecar files");
    }
    await rename(temporaryPath, databasePath);
    await cleanupLegacyPersistence(recordsDir);
    return report;
  } catch (error) {
    if (database?.isOpen) database.close();
    await rm(temporaryPath, { force: true });
    await rm(`${temporaryPath}-wal`, { force: true });
    await rm(`${temporaryPath}-shm`, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Legacy data migration failed: ${message}`, { cause: error });
  }
}

export async function cleanupLegacyPersistence(recordsDir: string): Promise<void> {
  for (const filePath of [
    path.join(recordsDir, "accounts.json"),
    path.join(recordsDir, "sessions.json"),
    path.join(recordsDir, "friends", "friendships.json"),
    path.join(recordsDir, "friends", "requests.json"),
  ]) {
    await rm(filePath, { force: true });
  }

  const matchesDir = path.join(recordsDir, "matches");
  try {
    const entries = await readdir(matchesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_MATCH_ID_PATTERN.test(entry.name)) continue;
      const directory = path.join(matchesDir, entry.name);
      if (!await pathExists(path.join(directory, "plan.json"))) continue;
      if (!await pathExists(path.join(directory, "result.json"))) continue;
      await rm(directory, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await removeDirectoryIfEmpty(matchesDir);
  await removeDirectoryIfEmpty(path.join(recordsDir, "friends"));
}

async function removeDirectoryIfEmpty(directory: string): Promise<void> {
  try {
    if ((await readdir(directory)).length === 0) await rm(directory, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readLegacyData(recordsDir: string): Promise<LegacyData> {
  const accounts = parseAccounts(await readOptionalJson(path.join(recordsDir, "accounts.json"), { accounts: [] }));
  const sessions = parseSessions(await readOptionalJson(path.join(recordsDir, "sessions.json"), { sessions: [] }));
  const friendships = parseFriendships(await readOptionalJson(path.join(recordsDir, "friends", "friendships.json"), { friendships: [] }));
  const requests = parseRequests(await readOptionalJson(path.join(recordsDir, "friends", "requests.json"), { requests: [] }));
  const matchData = await readLegacyMatches(path.join(recordsDir, "matches"));
  return { accounts, sessions, friendships, requests, matches: matchData.matches, skippedIncompleteMatches: matchData.skippedIncompleteMatches };
}

async function readOptionalJson(filePath: string, fallback: unknown): Promise<unknown> {
  return (await pathExists(filePath)) ? readJsonFile<unknown>(filePath) : fallback;
}

function importIntoDatabase(database: DatabaseSync, legacy: LegacyData, now: number): LegacyImportReport {
  const accountIds = new Set<string>();
  const accountInsert = database.prepare(`
    INSERT INTO accounts (
      id, username, display_name, steam64, role, enabled, dev,
      password_hash, must_change_password, created_at, updated_at, last_login_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const account of legacy.accounts) {
    if (accountIds.has(account.id)) throw new Error(`duplicate account id: ${account.id}`);
    accountIds.add(account.id);
    accountInsert.run(
      account.id,
      account.username,
      account.displayName,
      account.steam64.trim(),
      account.role,
      account.enabled ? 1 : 0,
      account.dev ? 1 : 0,
      account.passwordHash,
      account.mustChangePassword ? 1 : 0,
      account.createdAt,
      account.updatedAt,
      account.lastLoginAt,
    );
  }

  const sessionInsert = database.prepare(`
    INSERT INTO sessions (id, account_id, token_hash, created_at, expires_at, revoked_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let sessions = 0;
  let skippedRevokedSessions = 0;
  let skippedExpiredSessions = 0;
  let skippedOrphanSessions = 0;
  for (const session of legacy.sessions) {
    if (session.revokedAt) {
      skippedRevokedSessions += 1;
      continue;
    }
    if (Date.parse(session.expiresAt) <= now) {
      skippedExpiredSessions += 1;
      continue;
    }
    if (!accountIds.has(session.accountId)) {
      skippedOrphanSessions += 1;
      continue;
    }
    sessionInsert.run(
      session.id,
      session.accountId,
      session.tokenHash,
      session.createdAt,
      session.expiresAt,
      null,
      session.lastSeenAt,
    );
    sessions += 1;
  }

  const friendshipInsert = database.prepare(`
    INSERT INTO friendships (id, account_a_id, account_b_id, created_at) VALUES (?, ?, ?, ?)
  `);
  for (const friendship of legacy.friendships) {
    assertAccountPair(accountIds, friendship.accountAId, friendship.accountBId, friendship.id);
    friendshipInsert.run(friendship.id, friendship.accountAId, friendship.accountBId, friendship.createdAt);
  }

  const requestInsert = database.prepare(`
    INSERT INTO friend_requests (id, from_account_id, to_account_id, status, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const request of legacy.requests) {
    assertAccountPair(accountIds, request.fromAccountId, request.toAccountId, request.id);
    requestInsert.run(
      request.id,
      request.fromAccountId,
      request.toAccountId,
      request.status,
      request.createdAt,
      request.resolvedAt ?? null,
    );
  }

  const matchInsert = database.prepare(`
    INSERT INTO matches (
      id, map, created_at, completed_at, plan_json, result_json, status_json, server_json, events_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const participantInsert = database.prepare(
    "INSERT INTO match_participants (match_id, steam64, side) VALUES (?, ?, ?)",
  );
  for (const match of legacy.matches) {
    matchInsert.run(
      match.id,
      match.plan.map,
      match.plan.createdAt,
      match.result.completedAt,
      JSON.stringify(match.plan),
      JSON.stringify(match.result),
      match.statusJson,
      match.serverJson,
      match.eventsJson,
    );
    for (const participant of participantsForMatch(match.plan)) {
      participantInsert.run(match.id, participant.steam64, participant.side);
    }
  }

  assertImportedMatchParticipants(database, legacy.matches);
  assertSqliteIntegrity(database);
  return {
    accounts: legacy.accounts.length,
    sessions,
    skippedRevokedSessions,
    skippedExpiredSessions,
    skippedOrphanSessions,
    friendships: legacy.friendships.length,
    friendRequests: legacy.requests.length,
    matches: legacy.matches.length,
    skippedIncompleteMatches: legacy.skippedIncompleteMatches,
  };
}

function assertImportedMatchParticipants(database: DatabaseSync, matches: LegacyMatch[]): void {
  for (const match of matches) {
    const expected = new Set(participantsForMatch(match.plan).map((participant) => `${participant.side}:${participant.steam64}`));
    const actual = new Set(
      database.prepare("SELECT side, steam64 FROM match_participants WHERE match_id = ?").all(match.id)
        .map((row) => `${String(row.side)}:${String(row.steam64)}`),
    );
    if (expected.size !== actual.size || [...expected].some((participant) => !actual.has(participant))) {
      throw new Error(`match participant index mismatch: ${match.id}`);
    }
  }
}

function assertAccountPair(accountIds: Set<string>, accountAId: string, accountBId: string, recordId: string): void {
  if (!accountIds.has(accountAId) || !accountIds.has(accountBId)) {
    throw new Error(`friend record ${recordId} references a missing account`);
  }
  if (accountAId === accountBId) throw new Error(`friend record ${recordId} references the same account twice`);
}

function participantsForMatch(plan: MatchPlan): Array<{ steam64: string; side: "teamA" | "teamB" }> {
  const participants: Array<{ steam64: string; side: "teamA" | "teamB" }> = [];
  const seen = new Set<string>();
  for (const [side, team] of [["teamA", plan.teamA], ["teamB", plan.teamB]] as const) {
    for (const participant of team.participants) {
      if (participant.kind !== "human") continue;
      const steam64 = participant.steam64?.trim();
      if (!steam64) continue;
      if (seen.has(steam64)) throw new Error(`duplicate match participant Steam64: ${plan.id}`);
      seen.add(steam64);
      participants.push({ steam64, side });
    }
  }
  return participants;
}

async function readLegacyMatches(matchesDir: string): Promise<{ matches: LegacyMatch[]; skippedIncompleteMatches: number }> {
  let entries;
  try {
    entries = await readdir(matchesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { matches: [], skippedIncompleteMatches: 0 };
    throw error;
  }

  const matches: LegacyMatch[] = [];
  let skippedIncompleteMatches = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!SAFE_MATCH_ID_PATTERN.test(id)) throw new Error(`Invalid legacy matchId: ${id}`);
    const directory = path.join(matchesDir, id);
    const planPath = path.join(directory, "plan.json");
    const resultPath = path.join(directory, "result.json");
    const hasPlan = await pathExists(planPath);
    const hasResult = await pathExists(resultPath);
    if (!hasPlan || !hasResult) {
      skippedIncompleteMatches += 1;
      continue;
    }
    const plan = parseMatchPlan(await readJsonFile<unknown>(planPath), id);
    const result = parseMatchResult(await readJsonFile<unknown>(resultPath), id);
    const statusJson = await readOptionalSerializedJson(path.join(directory, "status.json"));
    const serverJson = await readOptionalSerializedJson(path.join(directory, "server.json"));
    const eventsJson = await readOptionalEventsJson(path.join(directory, "events.json"));
    matches.push({ id, plan, result, statusJson, serverJson, eventsJson });
  }
  return { matches, skippedIncompleteMatches };
}

async function readOptionalSerializedJson(filePath: string): Promise<string | null> {
  if (!(await pathExists(filePath))) return null;
  return JSON.stringify(await readJsonFile<unknown>(filePath));
}

async function readOptionalEventsJson(filePath: string): Promise<string | null> {
  if (!(await pathExists(filePath))) return null;
  const value = await readJsonFile<unknown>(filePath);
  const object = requireObject(value, filePath);
  if (!Array.isArray(object.events)) throw new Error(`Invalid events file: ${filePath}`);
  return JSON.stringify(value);
}

function parseAccounts(value: unknown): AccountRecord[] {
  const object = requireObject(value, "accounts.json");
  if (!Array.isArray(object.accounts)) throw new Error("Invalid accounts.json: accounts must be an array");
  return object.accounts.map((item, index) => {
    const account = requireObject(item, `accounts.json[${index}]`);
    const role = requireString(account, "role", `accounts.json[${index}]`);
    if (role !== "admin" && role !== "player") throw new Error(`Invalid account role at accounts.json[${index}]`);
    const username = requireString(account, "username", `accounts.json[${index}]`);
    if (!USERNAME_PATTERN.test(username)) throw new Error(`Invalid account username at accounts.json[${index}]`);
    return {
      id: requireString(account, "id", `accounts.json[${index}]`),
      username,
      displayName: requireString(account, "displayName", `accounts.json[${index}]`),
      steam64: requireString(account, "steam64", `accounts.json[${index}]`).trim(),
      role,
      enabled: requireBoolean(account, "enabled", `accounts.json[${index}]`),
      dev: optionalBoolean(account, "dev", `accounts.json[${index}]`) ?? false,
      passwordHash: requireString(account, "passwordHash", `accounts.json[${index}]`),
      mustChangePassword: requireBoolean(account, "mustChangePassword", `accounts.json[${index}]`),
      createdAt: requireTimestamp(account, "createdAt", `accounts.json[${index}]`),
      updatedAt: requireTimestamp(account, "updatedAt", `accounts.json[${index}]`),
      lastLoginAt: optionalTimestamp(account, "lastLoginAt", `accounts.json[${index}]`),
    };
  });
}

function parseSessions(value: unknown): SessionRecord[] {
  const object = requireObject(value, "sessions.json");
  if (!Array.isArray(object.sessions)) throw new Error("Invalid sessions.json: sessions must be an array");
  return object.sessions.map((item, index) => {
    const session = requireObject(item, `sessions.json[${index}]`);
    const revokedAt = optionalTimestamp(session, "revokedAt", `sessions.json[${index}]`);
    return {
      id: requireString(session, "id", `sessions.json[${index}]`),
      accountId: requireString(session, "accountId", `sessions.json[${index}]`),
      tokenHash: requireString(session, "tokenHash", `sessions.json[${index}]`),
      createdAt: requireTimestamp(session, "createdAt", `sessions.json[${index}]`),
      expiresAt: requireTimestamp(session, "expiresAt", `sessions.json[${index}]`),
      revokedAt,
      lastSeenAt: requireTimestamp(session, "lastSeenAt", `sessions.json[${index}]`),
    };
  });
}

function parseFriendships(value: unknown): FriendshipRecord[] {
  const object = requireObject(value, "friends/friendships.json");
  if (!Array.isArray(object.friendships)) throw new Error("Invalid friendships.json: friendships must be an array");
  return object.friendships.map((item, index) => {
    const friendship = requireObject(item, `friendships.json[${index}]`);
    return {
      id: requireString(friendship, "id", `friendships.json[${index}]`),
      accountAId: requireString(friendship, "accountAId", `friendships.json[${index}]`),
      accountBId: requireString(friendship, "accountBId", `friendships.json[${index}]`),
      createdAt: requireTimestamp(friendship, "createdAt", `friendships.json[${index}]`),
    };
  });
}

function parseRequests(value: unknown): FriendRequestRecord[] {
  const object = requireObject(value, "friends/requests.json");
  if (!Array.isArray(object.requests)) throw new Error("Invalid requests.json: requests must be an array");
  return object.requests.map((item, index) => {
    const request = requireObject(item, `requests.json[${index}]`);
    const status = requireString(request, "status", `requests.json[${index}]`);
    if (!["pending", "accepted", "declined", "expired"].includes(status)) {
      throw new Error(`Invalid friend request status at requests.json[${index}]`);
    }
    const resolvedAt = optionalTimestamp(request, "resolvedAt", `requests.json[${index}]`);
    return {
      id: requireString(request, "id", `requests.json[${index}]`),
      fromAccountId: requireString(request, "fromAccountId", `requests.json[${index}]`),
      toAccountId: requireString(request, "toAccountId", `requests.json[${index}]`),
      status: status as FriendRequestRecord["status"],
      createdAt: requireTimestamp(request, "createdAt", `requests.json[${index}]`),
      ...(resolvedAt ? { resolvedAt } : {}),
    };
  });
}

function parseMatchPlan(value: unknown, matchId: string): MatchPlan {
  const plan = requireObject(value, `matches/${matchId}/plan.json`);
  if (plan.id !== matchId) throw new Error(`Match plan id does not match directory: ${matchId}`);
  if (typeof plan.phase !== "string" || !MATCH_PHASES.includes(plan.phase) || typeof plan.map !== "string") {
    throw new Error(`Invalid match plan: ${matchId}`);
  }
  const teamA = parseMatchTeam(plan.teamA, `matches/${matchId}/plan.json teamA`, "teamA");
  const teamB = parseMatchTeam(plan.teamB, `matches/${matchId}/plan.json teamB`, "teamB");
  if (teamA.gameSide === teamB.gameSide) throw new Error(`Match teams use the same game side: ${matchId}`);
  const map = plan.map.trim();
  if (!map) throw new Error(`Invalid match map: ${matchId}`);
  if (plan.rankmeScoresBefore !== undefined) {
    const scores = requireObject(plan.rankmeScoresBefore, `matches/${matchId}/plan.json rankmeScoresBefore`);
    for (const [steam64, score] of Object.entries(scores)) {
      if (!steam64.trim() || typeof score !== "number" || !Number.isFinite(score)) {
        throw new Error(`Invalid RankMe score: ${matchId}`);
      }
    }
  }
  return {
    ...plan,
    id: matchId,
    phase: plan.phase as MatchPlan["phase"],
    map,
    teamA,
    teamB,
    connectPassword: requireString(plan, "connectPassword", `matches/${matchId}/plan.json`),
    createdAt: requireTimestamp(plan, "createdAt", `matches/${matchId}/plan.json`),
  } as MatchPlan;
}

function parseMatchTeam(value: unknown, label: string, expectedId: "teamA" | "teamB"): MatchPlan["teamA"] {
  const team = requireObject(value, label);
  if (team.id !== expectedId) throw new Error(`Invalid team id: ${label}`);
  if (team.gameSide !== "t" && team.gameSide !== "ct") throw new Error(`Invalid game side: ${label}`);
  if (typeof team.name !== "string" || !Array.isArray(team.participants)) throw new Error(`Invalid team: ${label}`);
  const participants = team.participants.map((value, index) => {
    const participant = requireObject(value, `${label} participant ${index}`);
    if (participant.kind !== "human" && participant.kind !== "bot") throw new Error(`Invalid participant kind: ${label}`);
    if (typeof participant.steam64 !== "undefined" && typeof participant.steam64 !== "string") {
      throw new Error(`Invalid participant Steam64: ${label}`);
    }
    if (participant.kind === "human" && !participant.steam64?.trim()) {
      throw new Error(`Human participant is missing Steam64: ${label}`);
    }
    if (typeof participant.id !== "string" || typeof participant.displayName !== "string") {
      throw new Error(`Invalid participant: ${label}`);
    }
    return participant;
  });
  return { ...team, id: team.id, gameSide: team.gameSide, name: team.name, participants } as MatchPlan["teamA"];
}

function parseMatchResult(value: unknown, matchId: string): MatchSeriesResult {
  const result = requireObject(value, `matches/${matchId}/result.json`);
  if (result.winner !== "teamA" && result.winner !== "teamB") throw new Error(`Invalid match result winner: ${matchId}`);
  for (const field of ["team1SeriesScore", "team2SeriesScore", "team1Score", "team2Score"]) {
    if (typeof result[field] !== "number" || !Number.isFinite(result[field])) throw new Error(`Invalid match result ${field}: ${matchId}`);
  }
  const mapName = requireString(result, "mapName", `matches/${matchId}/result.json`).trim();
  const team1Name = requireString(result, "team1Name", `matches/${matchId}/result.json`);
  const team2Name = requireString(result, "team2Name", `matches/${matchId}/result.json`);
  if (!mapName || !team1Name.trim() || !team2Name.trim() || !Array.isArray(result.players)) {
    throw new Error(`Invalid match result: ${matchId}`);
  }
  const firstHalfScore = parseOptionalMatchHalfScore(result, "firstHalfScore", `matches/${matchId}/result.json`);
  const secondHalfScore = parseOptionalMatchHalfScore(result, "secondHalfScore", `matches/${matchId}/result.json`);
  if (result.team1LogoImage !== undefined && typeof result.team1LogoImage !== "string") throw new Error(`Invalid team1 logo: ${matchId}`);
  if (result.team2LogoImage !== undefined && typeof result.team2LogoImage !== "string") throw new Error(`Invalid team2 logo: ${matchId}`);
  const players = result.players.map((player: unknown, index: number) => parseMatchPlayerResult(player, `matches/${matchId}/result.json players[${index}]`));
  return {
    ...result,
    mapName,
    team1Name,
    team2Name,
    ...(firstHalfScore ? { firstHalfScore } : {}),
    ...(secondHalfScore ? { secondHalfScore } : {}),
    players,
    completedAt: requireTimestamp(result, "completedAt", `matches/${matchId}/result.json`),
  } as MatchSeriesResult;
}

function parseOptionalMatchHalfScore(
  object: Record<string, any>,
  key: string,
  label: string,
): MatchHalfScore | undefined {
  if (object[key] === undefined) return undefined;
  const score = requireObject(object[key], `${label} ${key}`);
  return {
    team1Score: requireFiniteNumber(score, "team1Score", `${label} ${key}`),
    team2Score: requireFiniteNumber(score, "team2Score", `${label} ${key}`),
  };
}

function parseMatchPlayerResult(value: unknown, label: string): MatchPlayerResult {
  const player = requireObject(value, label);
  const team = requireString(player, "team", label);
  if (team !== "teamA" && team !== "teamB") throw new Error(`Invalid player team: ${label}`);
  const kind = player.kind;
  if (kind !== undefined && kind !== "human" && kind !== "bot") throw new Error(`Invalid player kind: ${label}`);
  const botCategory = player.botCategory;
  if (botCategory !== undefined && botCategory !== "pro") throw new Error(`Invalid player bot category: ${label}`);
  for (const field of ["kills", "deaths", "assists", "damage", "headshots"]) {
    requireFiniteNumber(player, field, label);
  }
  for (const field of ["rating2", "rankmeScore", "rankmeScoreDelta"]) {
    if (player[field] !== undefined) requireFiniteNumber(player, field, label);
  }
  const steam64 = requireString(player, "steam64", label).trim();
  const name = requireString(player, "name", label);
  if ((kind === "human" && !steam64) || !name.trim()) throw new Error(`Invalid player identity: ${label}`);
  if (player.avatarUrl !== undefined && typeof player.avatarUrl !== "string") throw new Error(`Invalid player avatar: ${label}`);
  return { ...player, steam64, name, team, ...(kind === undefined ? {} : { kind }), ...(botCategory === undefined ? {} : { botCategory }) } as MatchPlayerResult;
}

function requireObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid JSON object: ${label}`);
  return value as Record<string, any>;
}

function requireString(object: Record<string, any>, key: string, label: string): string {
  if (typeof object[key] !== "string") throw new Error(`Invalid ${key} at ${label}`);
  return object[key];
}

function requireBoolean(object: Record<string, any>, key: string, label: string): boolean {
  if (typeof object[key] !== "boolean") throw new Error(`Invalid ${key} at ${label}`);
  return object[key];
}

function requireFiniteNumber(object: Record<string, any>, key: string, label: string): number {
  if (typeof object[key] !== "number" || !Number.isFinite(object[key])) throw new Error(`Invalid ${key} at ${label}`);
  return object[key];
}

function optionalBoolean(object: Record<string, any>, key: string, label: string): boolean | undefined {
  if (typeof object[key] === "undefined") return undefined;
  return requireBoolean(object, key, label);
}

function requireTimestamp(object: Record<string, any>, key: string, label: string): string {
  const value = requireString(object, key, label);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid timestamp ${key} at ${label}`);
  return value;
}

function optionalTimestamp(object: Record<string, any>, key: string, label: string): string | null {
  if (object[key] === undefined || object[key] === null) return null;
  return requireTimestamp(object, key, label);
}
