import type { PlayerLiveMatchStateDto, PlayerMatchmakingStateDto } from "../../shared/types.js";
import { isMapRandomizingRevealed } from "./randomMapAnimation.js";

export function isTerminalMatchPhase(phase: PlayerLiveMatchStateDto["phase"] | undefined): boolean {
  return phase === "completed" || phase === "failed";
}

const MATCH_PHASE_ORDER: Record<PlayerLiveMatchStateDto["phase"], number> = {
  queue: 0,
  ready: 1,
  match_room: 2,
  map_randomizing: 3,
  server_prepare: 4,
  connect: 5,
  live: 6,
  completed: 7,
  failed: 7,
};

export function isMatchPhaseRegression(
  previous: PlayerLiveMatchStateDto["phase"] | undefined,
  next: PlayerLiveMatchStateDto["phase"] | undefined,
): boolean {
  if (!previous || !next || isTerminalMatchPhase(next)) return false;
  if (isTerminalMatchPhase(previous)) return true;
  return MATCH_PHASE_ORDER[next] < MATCH_PHASE_ORDER[previous];
}

export function getActiveMatchRoom(matchmaking: PlayerMatchmakingStateDto): PlayerLiveMatchStateDto | null {
  if (matchmaking.room && !isTerminalMatchPhase(matchmaking.room.phase)) {
    return matchmaking.room;
  }
  return [...matchmaking.rooms].reverse().find((room) => !isTerminalMatchPhase(room.phase)) ?? null;
}

export function getDisplayedMatchRoom(matchmaking: PlayerMatchmakingStateDto): PlayerLiveMatchStateDto | null {
  return getActiveMatchRoom(matchmaking);
}

export function upsertRoom(rooms: PlayerLiveMatchStateDto[], nextRoom: PlayerLiveMatchStateDto): PlayerLiveMatchStateDto[] {
  const index = rooms.findIndex((room) => room.id === nextRoom.id);
  if (index === -1) return [...rooms, nextRoom];
  return rooms.map((room, roomIndex) => (roomIndex === index ? nextRoom : room));
}

export function mergeMatchmakingSnapshotRooms(
  current: PlayerMatchmakingStateDto,
  snapshot: PlayerMatchmakingStateDto,
): Pick<PlayerMatchmakingStateDto, "rooms" | "room"> {
  const mergeSnapshotRoomProgress = (room: PlayerLiveMatchStateDto): PlayerLiveMatchStateDto => {
    const currentRoom = current.room?.id === room.id ? current.room : current.rooms.find((candidate) => candidate.id === room.id);
    if (currentRoom && isTerminalMatchPhase(currentRoom.phase) && !isTerminalMatchPhase(room.phase)) {
      return currentRoom;
    }
    if (currentRoom && isMatchPhaseRegression(currentRoom.phase, room.phase)) {
      return currentRoom;
    }
    return currentRoom ? mergeReadyRoomProgress(currentRoom, room) : room;
  };
  const snapshotRooms = snapshot.rooms.map(mergeSnapshotRoomProgress);
  const snapshotRoom = snapshot.room
    ? mergeSnapshotRoomProgress(snapshot.room)
    : snapshotRooms.at(-1) ?? null;
  const currentActiveRoom = getActiveMatchRoom(current);
  const snapshotMentionsCurrentActiveRoom = currentActiveRoom
    ? snapshotRooms.some((room) => room.id === currentActiveRoom.id) || snapshotRoom?.id === currentActiveRoom.id
    : false;
  const preservedCurrentRoom = currentActiveRoom && !snapshotMentionsCurrentActiveRoom
    ? currentActiveRoom
    : null;
  return {
    rooms: preservedCurrentRoom ? upsertRoom(snapshotRooms, preservedCurrentRoom) : snapshotRooms,
    room: snapshotRoom ?? preservedCurrentRoom,
  };
}

export function mergeMatchmakingSnapshotState(
  current: PlayerMatchmakingStateDto,
  snapshot: PlayerMatchmakingStateDto,
  latestRealtimeSeq = 0,
  source: "request" | "realtime-sync" = "request",
): PlayerMatchmakingStateDto {
  // The main process pauses events, serializes this refresh and replays later events.
  // Its snapshot establishes a new cursor, including after a server sequence reset.
  if (source === "realtime-sync") return snapshot;
  const snapshotIsBehindRealtime = snapshot.baseSeq < Math.max(current.baseSeq, latestRealtimeSeq);
  const { rooms, room } = snapshotIsBehindRealtime ? current : mergeMatchmakingSnapshotRooms(current, snapshot);
  return {
    ...(snapshotIsBehindRealtime ? current : snapshot),
    rooms,
    room,
    baseSeq: Math.max(current.baseSeq, snapshot.baseSeq, latestRealtimeSeq),
  };
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
  if (!room || isTerminalMatchPhase(room.phase)) return undefined;
  return isMapRandomizingRevealed(room.mapSelection, nowMs) ? room.mapSelection!.finalMap : undefined;
}

export function getMatchPresentationPhase(room: PlayerLiveMatchStateDto | null, nowMs: number): PlayerLiveMatchStateDto["phase"] | undefined {
  if (!room || isTerminalMatchPhase(room.phase)) return room?.phase;
  const selection = room.mapSelection;
  if (!selection) return room.phase;
  const start = Date.parse(selection.startedAt ?? "");
  const end = Date.parse(selection.revealAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || nowMs < start) return "ready";
  if (nowMs < end) return "map_randomizing";
  return room.phase === "map_randomizing" ? "server_prepare" : room.phase;
}
