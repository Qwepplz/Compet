import type { AccountView } from "../../manager/shared/types.js";
import type { RestoreSessionResult, SavedPlayerLogin } from "../main/ipc.js";
import type { PlayerLoginResult } from "../main/playerApiClient.js";
import type {
  PlayerFriendListDto,
  PlayerFriendRequestDto,
  PlayerFriendSearchResultDto,
  PlayerLiveMatchStateDto,
  PlayerMatchmakingStateDto,
  PlayerPartyDto,
  PlayerPartyInvitationDto,
  PlayerRealtimeEvent,
  PlayerRealtimeSnapshotDto,
  PlayerRealtimeStatusDto,
} from "../shared/types.js";

const createdAt = "2026-05-04T09:00:00.000Z";

const previewAccount: AccountView = {
  id: "preview-player",
  username: "preview",
  displayName: "Steam 预览账号",
  steam64: "76561198000000001",
  steamPersonaName: "Steam 预览账号",
  role: "player",
  enabled: true,
  mustChangePassword: false,
  createdAt,
  updatedAt: createdAt,
};

const previewFriends: PlayerFriendListDto = {
  friends: [
    {
      friendshipId: "preview-friend-1",
      accountId: "preview-friend-alpha",
      displayName: "Alpha",
      steam64: "76561198000000011",
      steamPersonaName: "Alpha",
      online: true,
      createdAt,
    },
    {
      friendshipId: "preview-friend-2",
      accountId: "preview-friend-bravo",
      displayName: "Bravo",
      steam64: "76561198000000012",
      steamPersonaName: "Bravo",
      online: false,
      lastSeenAt: createdAt,
      createdAt,
    },
  ],
  incomingRequests: [],
  outgoingRequests: [],
};

function makeParty(): PlayerPartyDto {
  return {
    id: "preview-party",
    ownerAccountId: previewAccount.id,
    memberAccountIds: [previewAccount.id],
    createdAt,
    updatedAt: createdAt,
    status: "open",
  };
}

function makeReadyRoom(party: PlayerPartyDto): PlayerLiveMatchStateDto {
  return {
    id: "preview-room",
    phase: "ready",
    partyId: party.id,
    humanAccountIds: [previewAccount.id],
    botParticipantIds: ["preview-bot-1", "preview-bot-2"],
    readyDeadlineAt: "2026-05-04T09:01:00.000Z",
    ready: [{ accountId: previewAccount.id, ready: false }],
    teamA: {
      id: "teamA",
      gameSide: "t",
      name: "Team A",
      participants: [
        {
          id: "preview-human-1",
          kind: "human",
          displayName: previewAccount.steamPersonaName ?? previewAccount.displayName,
          steam64: previewAccount.steam64,
          steamPersonaName: previewAccount.steamPersonaName,
          accountId: previewAccount.id,
        },
        { id: "preview-bot-1", kind: "bot", displayName: "Bot Alpha" },
      ],
    },
    teamB: {
      id: "teamB",
      gameSide: "ct",
      name: "Team B",
      participants: [
        { id: "preview-bot-2", kind: "bot", displayName: "Bot Bravo" },
        { id: "preview-bot-3", kind: "bot", displayName: "Bot Charlie" },
      ],
    },
    createdAt,
  };
}

export function createPreviewPlayerApi() {
  let party: PlayerPartyDto | null = null;
  let room: PlayerLiveMatchStateDto | null = null;
  const eventListeners = new Set<(event: PlayerRealtimeEvent) => void>();
  const statusListeners = new Set<(status: PlayerRealtimeStatusDto) => void>();
  const snapshotListeners = new Set<(snapshot: PlayerRealtimeSnapshotDto) => void>();

  const matchmaking = (): PlayerMatchmakingStateDto => ({
    queue: [],
    rooms: room ? [room] : [],
    party,
    partyInvitations: [],
    room,
  });

  const snapshot = (): PlayerRealtimeSnapshotDto => ({
    reason: "manual",
    friends: previewFriends,
    party,
    matchmaking: matchmaking(),
  });

  const publishSnapshot = () => {
    const next = snapshot();
    for (const listener of snapshotListeners) listener(next);
  };

  const ensureParty = (): PlayerPartyDto => {
    party ??= makeParty();
    return party;
  };

  return {
    login: async (): Promise<PlayerLoginResult> => ({ token: "preview-token", account: previewAccount }),
    logout: async (): Promise<void> => undefined,
    changePassword: async (): Promise<void> => undefined,
    restoreSession: async (): Promise<RestoreSessionResult> => ({
      baseUrl: "preview://offline",
      account: previewAccount,
      matchmaking: matchmaking(),
    }),
    loadSavedLogin: async (): Promise<SavedPlayerLogin> => ({
      baseUrl: "preview://offline",
      username: "preview",
      password: "preview",
    }),
    searchFriends: async (query: string): Promise<PlayerFriendSearchResultDto[]> => {
      const normalized = query.trim().toLowerCase();
      return previewFriends.friends
        .filter((friend) => !normalized || friend.displayName.toLowerCase().includes(normalized))
        .map(({ accountId, displayName, steam64, steamPersonaName, steamAvatarUrl, online, lastSeenAt }) => ({
          accountId,
          displayName,
          steam64,
          steamPersonaName,
          steamAvatarUrl,
          online,
          lastSeenAt,
        }));
    },
    listFriends: async (): Promise<PlayerFriendListDto> => previewFriends,
    sendFriendRequest: async (accountId: string): Promise<PlayerFriendRequestDto> => ({
      id: `preview-request-${accountId}`,
      accountId,
      displayName: accountId,
      steam64: accountId,
      online: true,
      fromAccountId: previewAccount.id,
      toAccountId: accountId,
      status: "pending",
      createdAt,
    }),
    acceptFriendRequest: async (): Promise<PlayerFriendListDto> => previewFriends,
    declineFriendRequest: async (): Promise<void> => undefined,
    getParty: async (): Promise<PlayerPartyDto | null> => party,
    createParty: async (): Promise<PlayerPartyDto> => {
      const next = ensureParty();
      publishSnapshot();
      return next;
    },
    inviteToParty: async (accountId: string): Promise<PlayerPartyInvitationDto> => ({
      id: `preview-invite-${accountId}`,
      partyId: ensureParty().id,
      fromAccountId: previewAccount.id,
      toAccountId: accountId,
      status: "pending",
      createdAt,
    }),
    acceptPartyInvite: async (): Promise<PlayerPartyDto> => {
      const next = ensureParty();
      publishSnapshot();
      return next;
    },
    declinePartyInvite: async (): Promise<void> => undefined,
    leaveParty: async (): Promise<void> => {
      party = null;
      room = null;
      publishSnapshot();
    },
    startPartyMatchmaking: async (): Promise<PlayerLiveMatchStateDto> => {
      const nextParty = ensureParty();
      room = makeReadyRoom(nextParty);
      publishSnapshot();
      return room;
    },
    getMatchmakingState: async (): Promise<PlayerMatchmakingStateDto> => matchmaking(),
    acceptReady: async (): Promise<PlayerLiveMatchStateDto> => {
      const nextParty = ensureParty();
      room = room ?? makeReadyRoom(nextParty);
      room = { ...room, phase: "match_room", ready: [{ accountId: previewAccount.id, ready: true }] };
      publishSnapshot();
      return room;
    },
    declineReady: async (): Promise<PlayerLiveMatchStateDto> => {
      const nextParty = ensureParty();
      room = room ?? makeReadyRoom(nextParty);
      publishSnapshot();
      return room;
    },
    applyVeto: async (): Promise<PlayerLiveMatchStateDto> => {
      const nextParty = ensureParty();
      room = room ?? makeReadyRoom(nextParty);
      return room;
    },
    refreshRealtimeSnapshot: async (): Promise<PlayerRealtimeSnapshotDto> => snapshot(),
    onRealtimeEvent: (listener: (event: PlayerRealtimeEvent) => void): (() => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onRealtimeStatus: (listener: (status: PlayerRealtimeStatusDto) => void): (() => void) => {
      statusListeners.add(listener);
      listener({ connection: "connected", stale: false });
      return () => statusListeners.delete(listener);
    },
    onRealtimeSnapshot: (listener: (snapshot: PlayerRealtimeSnapshotDto) => void): (() => void) => {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    copyText: async (): Promise<void> => undefined,
    openConnectUrl: async (): Promise<void> => undefined,
  };
}
