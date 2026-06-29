import { readFile } from "node:fs/promises";
import path from "node:path";

export interface CompetMatchPlayerStats {
  steam64: string;
  name: string;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  headshots: number;
  kastRounds?: number;
  roundsPlayed?: number;
}

export interface CompetSideHalfScore {
  t: number;
  ct: number;
}

export interface CompetMatchHalfScores {
  firstHalfScore?: CompetSideHalfScore;
  secondHalfScore?: CompetSideHalfScore;
}

export interface CompetMatchStatsReport extends CompetMatchHalfScores {
  players: CompetMatchPlayerStats[];
}

export const COMPET_MATCH_STATS_PATH_FORMAT = "addons/sourcemod/data/compet/matches/{MATCHID}/compet_matchstats.json";

const SAFE_MATCH_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function competMatchStatsPath(serverRoot: string, matchId: string): string {
  if (!SAFE_MATCH_ID_PATTERN.test(matchId)) {
    throw new Error(`Unsafe match id: ${matchId}`);
  }
  return path.join(
    serverRoot,
    "csgo",
    "addons",
    "sourcemod",
    "data",
    "compet",
    "matches",
    matchId,
    "compet_matchstats.json",
  );
}

export async function readCompetMatchStats(serverRoot: string, matchId: string): Promise<CompetMatchPlayerStats[]> {
  const report = await readCompetMatchStatsReport(serverRoot, matchId);
  return report.players;
}

export async function readCompetMatchStatsReport(serverRoot: string, matchId: string): Promise<CompetMatchStatsReport> {
  try {
    const raw = await readFile(competMatchStatsPath(serverRoot, matchId), "utf8");
    return classifyCompetMatchStatsReport(JSON.parse(raw) as unknown);
  } catch {
    return { players: [] };
  }
}

export function classifyCompetMatchStats(stats: unknown): CompetMatchPlayerStats[] {
  return classifyCompetMatchStatsReport(stats).players;
}

export function classifyCompetMatchStatsReport(stats: unknown): CompetMatchStatsReport {
  if (!isRecord(stats) || !Array.isArray(stats.players)) return { players: [] };
  const firstHalfScore = sideHalfScoreValue(stats.firstHalfScore);
  const secondHalfScore = sideHalfScoreValue(stats.secondHalfScore);
  const players = stats.players.flatMap((player) => {
    if (!isRecord(player)) return [];
    const kastRounds = optionalNumberValue(player.kastRounds);
    const roundsPlayed = optionalNumberValue(player.roundsPlayed);
    return [{
      name: stringValue(player.name),
      steam64: stringValue(player.steam64),
      kills: numberValue(player.kills),
      deaths: numberValue(player.deaths),
      assists: numberValue(player.assists),
      damage: numberValue(player.damage),
      headshots: numberValue(player.headshots),
      ...(kastRounds !== undefined ? { kastRounds } : {}),
      ...(roundsPlayed !== undefined ? { roundsPlayed } : {}),
    }];
  });
  return {
    ...(firstHalfScore ? { firstHalfScore } : {}),
    ...(secondHalfScore ? { secondHalfScore } : {}),
    players,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sideHalfScoreValue(value: unknown): CompetSideHalfScore | undefined {
  if (!isRecord(value)) return undefined;
  const t = optionalNumberValue(value.t);
  const ct = optionalNumberValue(value.ct);
  return t !== undefined && ct !== undefined ? { t, ct } : undefined;
}
