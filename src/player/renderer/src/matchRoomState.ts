import type { PlayerLiveMatchStateDto, PlayerMatchmakingStateDto } from "../../shared/types.js";

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
