import type { PlayerLiveMatchStateDto, PlayerMatchmakingStateDto } from "../../shared/types.js";

const VETO_STEP_MS = 30_000;
const BOT_AUTO_VETO_WINDOW_MS = 10_000;

export function isTerminalMatchPhase(phase: PlayerLiveMatchStateDto["phase"] | undefined): boolean {
  return phase === "completed" || phase === "failed";
}

export function getActiveMatchRoom(matchmaking: PlayerMatchmakingStateDto): PlayerLiveMatchStateDto | null {
  if (matchmaking.room && !isTerminalMatchPhase(matchmaking.room.phase)) {
    return matchmaking.room;
  }
  return [...matchmaking.rooms].reverse().find((room) => !isTerminalMatchPhase(room.phase)) ?? null;
}

export function getDisplayedMatchRoom(matchmaking: PlayerMatchmakingStateDto): PlayerLiveMatchStateDto | null {
  return matchmaking.room ?? matchmaking.rooms.at(-1) ?? null;
}

export function hasActiveMatchRoom(matchmaking: PlayerMatchmakingStateDto): boolean {
  return Boolean(getActiveMatchRoom(matchmaking));
}

export function getVetoDeadlineRefreshDelayMs(
  room: PlayerLiveMatchStateDto | null,
  nowMs: number,
  graceMs = 1_500,
): number | null {
  if (!room || room.phase !== "map_banpick" || room.veto?.finalMap || !room.veto?.current) {
    return null;
  }
  const deadlineMs = Date.parse(room.veto.current.deadlineAt);
  if (!Number.isFinite(deadlineMs)) {
    return null;
  }
  const refreshAtMs = room.veto.current.actorType === "bot"
    ? Math.min(deadlineMs, deadlineMs - VETO_STEP_MS + BOT_AUTO_VETO_WINDOW_MS)
    : deadlineMs;
  return Math.max(0, refreshAtMs + graceMs - nowMs);
}
