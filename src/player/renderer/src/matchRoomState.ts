import type { PlayerLiveMatchStateDto, PlayerMatchmakingStateDto, PlayerMatchTeamDto } from "../../shared/types.js";

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

export function mergeTeamsAssignedRoom(
  room: PlayerLiveMatchStateDto,
  teamA: PlayerMatchTeamDto,
  teamB: PlayerMatchTeamDto,
): PlayerLiveMatchStateDto {
  const phase = room.phase === "ready" || room.phase === "match_room" ? "match_room" : room.phase;
  return { ...room, phase, teamA, teamB };
}

export function mergeReadyRoomProgress(
  previous: PlayerLiveMatchStateDto,
  next: PlayerLiveMatchStateDto,
): PlayerLiveMatchStateDto {
  if (previous.id !== next.id || previous.phase !== "ready" || next.phase !== "ready") return next;
  const previousReadyByAccount = new Map((previous.ready ?? []).map((entry) => [entry.accountId, entry]));
  let changed = false;
  const ready = (next.ready ?? []).map((entry) => {
    const previousEntry = previousReadyByAccount.get(entry.accountId);
    if (!previousEntry?.ready || entry.ready) return entry;
    changed = true;
    return { ...entry, ready: true, respondedAt: entry.respondedAt ?? previousEntry.respondedAt };
  });
  return changed ? { ...next, ready } : next;
}

export function hasActiveMatchRoom(matchmaking: PlayerMatchmakingStateDto): boolean {
  return Boolean(getActiveMatchRoom(matchmaking));
}

export function isAccountInReadyRoom(room: PlayerLiveMatchStateDto | null, accountId: string | undefined): boolean {
  if (!room || room.phase !== "ready" || !accountId) return false;
  if (room.humanAccountIds?.includes(accountId)) return true;
  if (room.ready?.some((entry) => entry.accountId === accountId)) return true;
  return [...room.teamA.participants, ...room.teamB.participants]
    .some((participant) => participant.kind === "human" && participant.accountId === accountId);
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
