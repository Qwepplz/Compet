import type { PlayerLiveMatchStateDto, PlayerMatchmakingStateDto, PlayerMatchTeamDto } from "../../shared/types.js";

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
  if (room.phase === "ready") return room;
  const phase = room.phase === "match_room" ? "match_room" : room.phase;
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

export function getSelectedMap(room: PlayerLiveMatchStateDto | null, nowMs: number): string | undefined {
  const revealMs = Date.parse(room?.mapSelection?.revealAt ?? "");
  const revealedRandomMap = room?.mapSelection && Number.isFinite(revealMs) && nowMs >= revealMs
    ? room.mapSelection.finalMap
    : undefined;
  return revealedRandomMap ?? room?.connect?.map;
}
