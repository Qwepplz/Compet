import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GameSide, MatchSeriesResult, TeamSide } from "../matchmaking/types.js";

export interface Get5PlayerAlignment {
  steam64: string;
  team: TeamSide;
}

type CompetTeamDisplayResultFields = "team1Name" | "team1LogoImage" | "team2Name" | "team2LogoImage";

export type Get5MatchSeriesResult = Omit<MatchSeriesResult, "players" | CompetTeamDisplayResultFields> & {
  team1StartingSide: GameSide;
  team2StartingSide: GameSide;
  players: Get5PlayerAlignment[];
};

export type Get5MatchResultClassification =
  | { status: "normal"; result: Get5MatchSeriesResult }
  | { status: "abnormal"; reason: string };

const SAFE_MATCH_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function get5MatchStatsRelativePath(matchId: string): string {
  if (!SAFE_MATCH_ID_PATTERN.test(matchId)) {
    throw new Error(`Unsafe match id: ${matchId}`);
  }
  return `addons/sourcemod/data/compet/matches/${matchId}/get5_matchstats.cfg`;
}

export function get5MatchStatsPath(serverRoot: string, matchId: string): string {
  return path.join(
    serverRoot,
    "csgo",
    ...get5MatchStatsRelativePath(matchId).split("/"),
  );
}

export async function readGet5MatchResult(
  serverRoot: string,
  matchId: string,
  completedAt: string,
): Promise<Get5MatchResultClassification> {
  const candidates = [
    get5MatchStatsPath(serverRoot, matchId),
    path.join(serverRoot, "csgo", `get5_matchstats_${matchId}.cfg`),
    path.join(serverRoot, "csgo", "get5_matchstats_manual.cfg"),
  ];
  let sawStatsFile = false;

  for (const candidate of candidates) {
    const raw = await readStatsFile(candidate);
    if (raw === null) continue;
    sawStatsFile = true;
    const parsed = parseStatsFile(raw);
    if (parsed !== null) {
      return classifyGet5MatchStats(parsed, completedAt);
    }
  }

  return { status: "abnormal", reason: sawStatsFile ? "invalid_get5_stats" : "missing_get5_stats" };
}

async function readStatsFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseStatsFile(raw: string): unknown | null {
  return parseKeyValuesStats(raw);
}

export function classifyGet5MatchStats(stats: unknown, completedAt: string): Get5MatchResultClassification {
  if (!isRecord(stats)) return { status: "abnormal", reason: "invalid_get5_stats" };
  if (numberValue(stats.forfeit) !== 0) return { status: "abnormal", reason: "forfeit" };

  const winner = parseGet5Team(stats.winner);
  if (!winner) return { status: "abnormal", reason: "missing_winner" };

  const map = findFinalMap(stats);
  if (!map) return { status: "abnormal", reason: "missing_map_result" };

  const team1 = isRecord(map.team1) ? map.team1 : null;
  const team2 = isRecord(map.team2) ? map.team2 : null;
  if (!team1 || !team2) return { status: "abnormal", reason: "missing_team_scores" };

  const team1Score = numberValue(team1.score);
  const team2Score = numberValue(team2.score);
  if (!isValidMr12FinalScore(team1Score, team2Score, winner)) {
    return { status: "abnormal", reason: "invalid_mr12_score" };
  }
  const team1StartingSide = parseGet5Side(team1.starting_side);
  const team2StartingSide = parseGet5Side(team2.starting_side);
  if (!team1StartingSide || !team2StartingSide || team1StartingSide === team2StartingSide) {
    return { status: "abnormal", reason: "missing_starting_side" };
  }

  return {
    status: "normal",
    result: {
      winner,
      team1SeriesScore: winner === "teamA" ? 1 : 0,
      team2SeriesScore: winner === "teamB" ? 1 : 0,
      mapName: stringValue(map.mapname),
      team1Score,
      team2Score,
      team1StartingSide,
      team2StartingSide,
      players: [
        ...readPlayers(team1.players, "teamA"),
        ...readPlayers(team2.players, "teamB"),
      ],
      completedAt,
    },
  };
}

function findFinalMap(stats: Record<string, unknown>): Record<string, unknown> | null {
  let finalMap: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(stats)) {
    if (/^map\d+$/.test(key) && isRecord(value)) {
      finalMap = value;
    }
  }
  return finalMap;
}

function parseKeyValuesStats(raw: string): unknown | null {
  const tokens = tokenizeKeyValues(raw);
  if (tokens.length < 3) return null;
  let index = 0;
  const rootKey = tokens[index++];
  if (typeof rootKey !== "string" || tokens[index++] !== "{") return null;
  const root = parseKeyValuesObject(tokens, index);
  if (!root || tokens[root.nextIndex] !== undefined) return null;
  return rootKey === "Stats" ? root.value : { [rootKey]: root.value };
}

function parseKeyValuesObject(tokens: string[], startIndex: number): { value: Record<string, unknown>; nextIndex: number } | null {
  const value: Record<string, unknown> = {};
  let index = startIndex;
  while (index < tokens.length) {
    const key = tokens[index++];
    if (key === "}") {
      return { value, nextIndex: index };
    }
    if (!key || key === "{") return null;
    if (tokens[index] === "{") {
      index++;
      const child = parseKeyValuesObject(tokens, index);
      if (!child) return null;
      value[key] = child.value;
      index = child.nextIndex;
    } else {
      const scalar = tokens[index++];
      if (scalar === undefined || scalar === "}") return null;
      value[key] = scalar;
    }
  }
  return null;
}

function tokenizeKeyValues(raw: string): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < raw.length;) {
    const char = raw[index];
    if (char === undefined || /\s/.test(char)) {
      index++;
      continue;
    }
    if (char === "{" || char === "}") {
      tokens.push(char);
      index++;
      continue;
    }
    if (char !== "\"") return [];
    let token = "";
    index++;
    while (index < raw.length) {
      const current = raw[index++];
      if (current === undefined) return [];
      if (current === "\\") {
        const escaped = raw[index++];
        if (escaped === undefined) return [];
        token += escaped;
        continue;
      }
      if (current === "\"") break;
      token += current;
    }
    tokens.push(token);
  }
  return tokens;
}

function isValidMr12FinalScore(team1Score: number, team2Score: number, winner: TeamSide): boolean {
  if (!Number.isInteger(team1Score) || !Number.isInteger(team2Score) || team1Score === team2Score) return false;
  const winnerScore = winner === "teamA" ? team1Score : team2Score;
  const loserScore = winner === "teamA" ? team2Score : team1Score;
  if (winnerScore <= loserScore) return false;
  if (winnerScore === 13) return loserScore <= 11;
  if (winnerScore < 16 || (winnerScore - 16) % 3 !== 0) return false;
  return loserScore >= winnerScore - 4 && loserScore <= winnerScore - 2;
}

function readPlayers(players: unknown, team: TeamSide): Get5PlayerAlignment[] {
  if (!isRecord(players)) return [];
  return Object.entries(players).flatMap(([steam64, value]) => {
    if (!isRecord(value)) return [];
    return [{
      steam64,
      team,
    }];
  });
}

function parseGet5Team(value: unknown): TeamSide | null {
  if (value === "team1") return "teamA";
  if (value === "team2") return "teamB";
  return null;
}

function parseGet5Side(value: unknown): GameSide | null {
  if (value === "t" || value === "2" || value === 2) return "t";
  if (value === "ct" || value === "3" || value === 3) return "ct";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
