import type { AccountView } from "../../manager/shared/types.js";
import type { UpdateCheckResult, UpdateInstallResult } from "../../desktop/updateTypes.js";
import type { RestoreSessionResult, SavedPlayerLogin } from "../main/ipc.js";
import type { PlayerLoginResult } from "../main/playerApiClient.js";
import type {
  PlayerFriendListDto,
  PlayerFriendRequestDto,
  PlayerFriendSearchResultDto,
  PlayerLiveMatchStateDto,
  PlayerMatchHistoryDto,
  PlayerMatchResultDto,
  PlayerMatchmakingStateDto,
  PlayerMatchStageDto,
  PlayerPartyDto,
  PlayerPartyInvitationDto,
  PlayerRealtimeEvent,
  PlayerRealtimeSnapshotDto,
  PlayerRealtimeStatusDto,
  PlayerServerTimedDto,
} from "../shared/types.js";

const createdAt = "2026-05-04T09:00:00.000Z";
const previewSteam64 = "76561198000000001";

const previewAccount: AccountView = {
  id: "preview-player",
  username: "preview",
  displayName: "Steam 预览账号",
  steam64: previewSteam64,
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

const previewMatchResult: PlayerMatchResultDto = {
  winner: "teamA",
  team1SeriesScore: 1,
  team2SeriesScore: 0,
  mapName: "de_mirage",
  team1Name: "Alpha",
  team2Name: "Bravo",
  team1Score: 13,
  team2Score: 8,
  completedAt: createdAt,
  players: [
    { steam64: previewSteam64, name: previewAccount.displayName, kind: "human", team: "teamA", kills: 21, deaths: 9, assists: 5, damage: 2400, headshots: 10, rating2: 1.46 },
    { steam64: "76561198000000002", name: "Bravo", kind: "human", team: "teamB", kills: 9, deaths: 21, assists: 1, damage: 900, headshots: 2, rating2: 0.66 },
  ],
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
    ready: [{ accountId: previewAccount.id, ready: false }],
    stageBarrier: {
      stage: "room_entered",
      acknowledgedAccountIds: [],
    },
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
    occupancy: { activeCount: room || party?.matchmakingPendingAt ? 1 : 0 },
    baseSeq: 0,
  });

  const snapshot = (): PlayerRealtimeSnapshotDto => ({
    friends: previewFriends,
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
    restoreSession: async (_timeoutMs?: number): Promise<RestoreSessionResult> => ({
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
      const normalized = query.trim();
      return previewFriends.friends
        .filter((friend) => !normalized || friend.displayName.includes(normalized))
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
    getRankmeScore: async (): Promise<number> => 4017,
    listMatchHistory: async (_accountId?: string, page = 1): Promise<PlayerMatchHistoryDto> => ({
      rankmeScore: 4017,
      matches: [{
        matchId: "preview-match",
        completedAt: createdAt,
        mapName: "de_mirage",
        winner: "teamA",
        score: { team1: 13, team2: 8 },
        selfTeam: "teamA",
        selfWon: true,
        self: { kills: 21, deaths: 9, assists: 5, damage: 2400, headshots: 10, rating2: 1.46, rankmeScore: 4017, rankmeScoreDelta: 25 },
      }],
      page,
      pageSize: 20,
      total: 1,
    }),
    getMatchHistoryResult: async (_matchId?: string, _accountId?: string): Promise<PlayerMatchResultDto> => previewMatchResult,
    reenrichFriends: async (results: PlayerFriendSearchResultDto[]): Promise<PlayerFriendSearchResultDto[]> => results,
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
    removeFriend: async (): Promise<void> => undefined,
    getParty: async (): Promise<PlayerServerTimedDto<PlayerPartyDto> | null> => party,
    createParty: async (): Promise<PlayerServerTimedDto<PlayerPartyDto>> => {
      const next = ensureParty();
      publishSnapshot();
      return next;
    },
    inviteToParty: async (accountId: string): Promise<PlayerServerTimedDto<PlayerPartyInvitationDto>> => ({
      id: `preview-invite-${accountId}`,
      partyId: ensureParty().id,
      fromAccountId: previewAccount.id,
      toAccountId: accountId,
      fromDisplayName: previewAccount.steamPersonaName ?? previewAccount.steam64 ?? previewAccount.displayName,
      toDisplayName: accountId,
      status: "pending",
      createdAt,
    }),
    acceptPartyInvite: async (): Promise<PlayerServerTimedDto<PlayerPartyDto>> => {
      const next = ensureParty();
      publishSnapshot();
      return next;
    },
    declinePartyInvite: async (): Promise<void> => undefined,
    ignorePartyInvite: async (): Promise<void> => undefined,
    leaveParty: async (): Promise<void> => {
      party = null;
      room = null;
      publishSnapshot();
    },
    beginPartyMatchmaking: async (_options?: { dev?: boolean }): Promise<PlayerServerTimedDto<PlayerPartyDto>> => {
      const now = new Date().toISOString();
      const nextParty = { ...ensureParty(), matchmakingPendingAt: now, updatedAt: now };
      party = nextParty;
      publishSnapshot();
      return nextParty;
    },
    cancelPartyMatchmaking: async (): Promise<PlayerServerTimedDto<PlayerPartyDto> | undefined> => {
      if (!party) return undefined;
      party = { ...party, matchmakingPendingAt: undefined, updatedAt: new Date().toISOString() };
      publishSnapshot();
      return party;
    },
    startPartyMatchmaking: async (_options?: { dev?: boolean }): Promise<PlayerServerTimedDto<PlayerLiveMatchStateDto>> => {
      const nextParty = ensureParty();
      room = makeReadyRoom(nextParty);
      publishSnapshot();
      return room;
    },
    getMatchmakingState: async (): Promise<PlayerMatchmakingStateDto> => matchmaking(),
    ackMatchStage: async (_roomId: string, stage: PlayerMatchStageDto): Promise<PlayerServerTimedDto<PlayerLiveMatchStateDto>> => {
      const nextParty = ensureParty();
      room = room ?? makeReadyRoom(nextParty);
      if (stage === "room_entered") {
        room = { ...room, stageBarrier: undefined, readyDeadlineAt: new Date(Date.now() + 45_000).toISOString() };
      } else if (stage === "map_stage_entered") {
        const startedAt = new Date().toISOString();
        room = {
          ...room,
          mapSelection: {
            mapPool: ["de_mirage", "de_inferno", "de_nuke"],
            reel: ["de_inferno", "de_nuke", "de_mirage"],
            finalMap: "de_mirage",
            startedAt,
            revealAt: new Date(Date.now() + 7_000).toISOString(),
          },
          stageBarrier: {
            stage: "map_revealed",
            acknowledgedAccountIds: [],
          },
        };
      } else {
        room = { ...room, stageBarrier: undefined, phase: "server_prepare" };
      }
      publishSnapshot();
      return room;
    },
    acceptReady: async (): Promise<PlayerServerTimedDto<PlayerLiveMatchStateDto>> => {
      const nextParty = ensureParty();
      room = room ?? makeReadyRoom(nextParty);
      room = {
        ...room,
        phase: "map_randomizing",
        ready: [{ accountId: previewAccount.id, ready: true }],
        readyDeadlineAt: undefined,
        stageBarrier: {
          stage: "map_stage_entered",
          acknowledgedAccountIds: [],
        },
      };
      publishSnapshot();
      return room;
    },
    declineReady: async (): Promise<PlayerServerTimedDto<PlayerLiveMatchStateDto>> => {
      const nextParty = ensureParty();
      room = room ?? makeReadyRoom(nextParty);
      publishSnapshot();
      return room;
    },
    refreshRealtimeSnapshot: async (): Promise<void> => publishSnapshot(),
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
    onAccountUpdated: (_listener: (account: AccountView) => void): (() => void) => {
      return () => undefined;
    },
    onProfilesUpdated: (_listener: () => void): (() => void) => {
      return () => undefined;
    },
    copyText: async (): Promise<void> => undefined,
    openConnectUrl: async (): Promise<void> => undefined,
    getVersion: async (): Promise<string> => "preview",
    checkUpdate: async (_timeoutMs?: number): Promise<UpdateCheckResult> => ({
      currentVersion: "preview",
      latestVersion: "preview",
      updateAvailable: false,
      changedFiles: 0,
      changedBytes: 0,
      manifestUrl: "",
    }),
    installUpdate: async (): Promise<UpdateInstallResult> => ({
      currentVersion: "preview",
      latestVersion: "preview",
      updateAvailable: false,
      changedFiles: 0,
      changedBytes: 0,
      manifestUrl: "",
      installing: false,
    }),
  };
}
