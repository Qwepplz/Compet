import { z } from "zod";
import type { AccountRecord } from "../accounts/accountTypes.js";
import type { MatchPlayerResult, MatchPlan } from "../matchmaking/types.js";
import type { CompletedMatchRecord } from "./matchRecordStore.js";

export const MATCH_HISTORY_PAGE_SIZE = 20;
export const matchHistoryPageSchema = z.coerce.number().int().positive().default(1);
export const matchHistoryMatchIdSchema = z.string().min(1);

export interface MatchHistoryEntry {
  matchId: string;
  completedAt: string;
  mapName: string;
  winner: "teamA" | "teamB";
  score: { team1: number; team2: number };
  selfTeam: "teamA" | "teamB";
  selfWon: boolean;
  self: Pick<MatchPlayerResult, "kills" | "deaths" | "assists" | "damage" | "headshots" | "rating2" | "rankmeScore" | "rankmeScoreDelta">;
}

function accountTeam(plan: MatchPlan, steam64: string): "teamA" | "teamB" | null {
  if (plan.teamA.participants.some((participant) => participant.kind === "human" && participant.steam64?.trim() === steam64)) return "teamA";
  if (plan.teamB.participants.some((participant) => participant.kind === "human" && participant.steam64?.trim() === steam64)) return "teamB";
  return null;
}

function resultPlayer(record: CompletedMatchRecord, steam64: string): MatchPlayerResult | null {
  return record.result.players.find((player) => player.steam64.trim() === steam64) ?? null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function rankmeScore(plan: MatchPlan, self: MatchPlayerResult): number | undefined {
  const before = plan.rankmeScoresBefore?.[self.steam64.trim()];
  if (finiteNumber(before)) return before;
  return finiteNumber(self.rankmeScore) && finiteNumber(self.rankmeScoreDelta)
    ? self.rankmeScore - self.rankmeScoreDelta
    : undefined;
}

export function toMatchHistoryEntry(record: CompletedMatchRecord, account: AccountRecord): MatchHistoryEntry | null {
  const steam64 = account.steam64.trim();
  const selfTeam = accountTeam(record.plan, steam64);
  if (!selfTeam) return null;
  const self = resultPlayer(record, steam64);
  if (!self) return null;
  return {
    matchId: record.matchId,
    completedAt: record.result.completedAt,
    mapName: record.result.mapName,
    winner: record.result.winner,
    score: { team1: record.result.team1Score, team2: record.result.team2Score },
    selfTeam,
    selfWon: record.result.winner === selfTeam,
    self: {
      kills: self.kills,
      deaths: self.deaths,
      assists: self.assists,
      damage: self.damage,
      headshots: self.headshots,
      rating2: self.rating2,
      rankmeScore: rankmeScore(record.plan, self),
      rankmeScoreDelta: self.rankmeScoreDelta,
    },
  };
}
