import type {
  PlayerFriendListDto,
  PlayerPartyDto,
  PlayerPartyInvitationDto,
} from "../../shared/types.js";

export function mergeFriendListSnapshot(
  current: PlayerFriendListDto,
  snapshot: PlayerFriendListDto,
  resolvedRequestIds: ReadonlySet<string>,
): PlayerFriendListDto {
  return {
    friends: snapshot.friends,
    incomingRequests: mergePendingItems(current.incomingRequests, snapshot.incomingRequests, resolvedRequestIds),
    outgoingRequests: mergePendingItems(current.outgoingRequests, snapshot.outgoingRequests, resolvedRequestIds),
  };
}

export function mergePartyInvitationsSnapshot(
  current: PlayerPartyInvitationDto[],
  snapshot: PlayerPartyInvitationDto[],
  resolvedInvitationIds: ReadonlySet<string>,
): PlayerPartyInvitationDto[] {
  return mergePendingItems(current, snapshot, resolvedInvitationIds);
}

export function mergePartySnapshot(current: PlayerPartyDto | null, snapshot: PlayerPartyDto | null): PlayerPartyDto | null {
  if (!current) return snapshot;
  if (!snapshot) return null;
  if (current.id !== snapshot.id) return snapshot;

  const currentTime = partyTimestamp(current);
  const snapshotTime = partyTimestamp(snapshot);
  if (currentTime > snapshotTime) return current;
  if (currentTime === snapshotTime && current.memberAccountIds.length > snapshot.memberAccountIds.length) {
    return current;
  }
  return snapshot;
}

function mergePendingItems<T extends { id: string }>(
  current: T[],
  snapshot: T[],
  resolvedIds: ReadonlySet<string>,
): T[] {
  const next = snapshot.filter((item) => !resolvedIds.has(item.id));
  const nextIds = new Set(next.map((item) => item.id));
  for (const item of current) {
    if (!nextIds.has(item.id) && !resolvedIds.has(item.id)) {
      next.unshift(item);
    }
  }
  return next;
}

function partyTimestamp(party: PlayerPartyDto): number {
  return Date.parse(party.updatedAt ?? party.createdAt);
}
