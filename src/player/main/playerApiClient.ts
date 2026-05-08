import type { AccountView } from "../../manager/shared/types.js";
import type { VetoAction } from "../../matchmaking/vetoService.js";
import { requestJson } from "../../shared/httpJsonClient.js";
import type {
  PlayerFriendDto,
  PlayerFriendListDto,
  PlayerFriendRequestDto,
  PlayerFriendSearchResultDto,
  PlayerLiveMatchStateDto,
  PlayerMatchChatMessageDto,
  PlayerMatchParticipantDto,
  PlayerMatchmakingStateDto,
  PlayerMatchTeamDto,
  PlayerPartyDto,
  PlayerPartyInvitationDto,
  PlayerRealtimeEvent,
  PlayerRealtimeSnapshotDto,
  PlayerRealtimeSnapshotReason,
} from "../shared/types.js";
import { SteamProfileService, type SteamProfileResolver } from "./steamProfileService.js";

const REQUEST_TIMEOUT_MS = 4_000;

export interface PlayerLoginResult {
  token: string;
  account: AccountView;
}

export type PlayerMatchmakingState = PlayerMatchmakingStateDto;

export interface PlayerLoginCredentials {
  username: string;
  password: string;
}

export interface RestoredPlayerSession {
  account: AccountView;
  matchmaking: PlayerMatchmakingStateDto;
}

export class PlayerApiError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "PlayerApiError";
  }
}

export function isSessionInvalidError(error: unknown): boolean {
  return error instanceof PlayerApiError && error.statusCode === 401;
}

export class PlayerApiClient {
  private loginCredentials?: PlayerLoginCredentials;

  constructor(
    private readonly baseUrl: string,
    private token?: string,
    private readonly steamProfiles: SteamProfileResolver = new SteamProfileService(),
  ) {}

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getToken(): string | undefined {
    return this.token;
  }

  getLoginCredentials(): PlayerLoginCredentials | undefined {
    return this.loginCredentials;
  }

  setLoginCredentials(username: string, password: string): void {
    this.loginCredentials = { username, password };
  }

  async login(username: string, password: string): Promise<PlayerLoginResult> {
    this.token = undefined;
    const response = await this.request<PlayerLoginResult>("POST", "/auth/login", { username, password });
    this.token = response.token;
    this.setLoginCredentials(username, password);
    return { ...response, account: await this.enrichAccount(response.account) };
  }

  async logout(): Promise<void> {
    try {
      await this.request("POST", "/auth/logout", {});
    } finally {
      this.token = undefined;
    }
  }

  changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.request("POST", "/auth/change-password", { currentPassword, newPassword });
  }

  async me(): Promise<AccountView> {
    return this.enrichAccount(await this.request("GET", "/me"));
  }

  searchFriends(query: string): Promise<PlayerFriendSearchResultDto[]> {
    return this.request<{ results: PlayerFriendSearchResultDto[] }>("GET", `/friends/search?q=${encodeURIComponent(query)}`)
      .then((response) => this.enrichFriendSearchResults(response.results));
  }

  listFriends(): Promise<PlayerFriendListDto> {
    return this.request<PlayerFriendListDto>("GET", "/friends").then((friends) => this.enrichFriendList(friends));
  }

  sendFriendRequest(accountId: string): Promise<PlayerFriendRequestDto> {
    return this.request<{ request: PlayerFriendRequestDto }>("POST", "/friends/requests", { accountId })
      .then((response) => this.enrichFriendRequest(response.request));
  }

  acceptFriendRequest(requestId: string): Promise<PlayerFriendListDto> {
    return this.request<PlayerFriendListDto>("POST", `/friends/requests/${encodeURIComponent(requestId)}/accept`, {})
      .then((friends) => this.enrichFriendList(friends));
  }

  declineFriendRequest(requestId: string): Promise<void> {
    return this.request("POST", `/friends/requests/${encodeURIComponent(requestId)}/decline`, {});
  }

  getParty(): Promise<PlayerPartyDto | null> {
    return this.request<{ party: PlayerPartyDto | null }>("GET", "/party").then((response) => response.party);
  }

  createParty(): Promise<PlayerPartyDto> {
    return this.request<{ party: PlayerPartyDto }>("POST", "/party/create", {}).then((response) => response.party);
  }

  inviteToParty(accountId: string): Promise<PlayerPartyInvitationDto> {
    return this.request<{ invitation: PlayerPartyInvitationDto }>("POST", "/party/invite", { accountId })
      .then((response) => response.invitation);
  }

  acceptPartyInvite(invitationId: string): Promise<PlayerPartyDto> {
    return this.request<{ party: PlayerPartyDto }>("POST", `/party/invitations/${encodeURIComponent(invitationId)}/accept`, {})
      .then((response) => response.party);
  }

  declinePartyInvite(invitationId: string): Promise<void> {
    return this.request("POST", `/party/invitations/${encodeURIComponent(invitationId)}/decline`, {});
  }

  leaveParty(): Promise<void> {
    return this.request("POST", "/party/leave", {});
  }

  async startPartyMatchmaking(): Promise<PlayerLiveMatchStateDto> {
    const response = await this.request<{ room: PlayerLiveMatchStateDto }>("POST", "/party/matchmaking/start", {});
    return this.enrichRoom(response.room);
  }

  async getMatchmakingState(): Promise<PlayerMatchmakingStateDto> {
    return this.enrichMatchmakingState(await this.request("GET", "/matchmaking/state"));
  }

  matchmakingState(): Promise<PlayerMatchmakingStateDto> {
    return this.getMatchmakingState();
  }

  async ackMatchRoomEntered(roomId: string): Promise<PlayerLiveMatchStateDto> {
    const response = await this.request<{ room: PlayerLiveMatchStateDto }>("POST", `/match-room/${encodeURIComponent(roomId)}/entered`, {});
    return this.enrichRoom(response.room);
  }

  async acceptReady(): Promise<PlayerLiveMatchStateDto> {
    const response = await this.request<{ room: PlayerLiveMatchStateDto }>("POST", "/matchmaking/ready", {});
    return this.enrichRoom(response.room);
  }

  async declineReady(): Promise<PlayerLiveMatchStateDto> {
    const response = await this.request<{ room: PlayerLiveMatchStateDto }>("POST", "/matchmaking/ready/decline", {});
    return this.enrichRoom(response.room);
  }

  async applyVeto(roomId: string, action: VetoAction, map: string): Promise<PlayerLiveMatchStateDto> {
    const response = await this.request<{ room: PlayerLiveMatchStateDto }>("POST", `/match-room/${encodeURIComponent(roomId)}/veto`, {
      action,
      map,
    });
    return this.enrichRoom(response.room);
  }

  async sendMatchChatMessage(roomId: string, text: string): Promise<PlayerMatchChatMessageDto> {
    const response = await this.request<{ message: PlayerMatchChatMessageDto }>("POST", `/match-room/${encodeURIComponent(roomId)}/chat`, {
      text,
    });
    return response.message;
  }

  async fetchRealtimeSnapshot(reason: PlayerRealtimeSnapshotReason): Promise<PlayerRealtimeSnapshotDto> {
    const [friends, party, matchmaking] = await Promise.all([
      this.listFriends(),
      this.getParty(),
      this.getMatchmakingState(),
    ]);
    return { reason, friends, party, matchmaking };
  }

  async enrichRealtimeEvent(event: PlayerRealtimeEvent): Promise<PlayerRealtimeEvent> {
    switch (event.type) {
      case "friend_request_received":
      case "friend_request_resolved":
        return { ...event, request: await this.enrichFriendRequest(event.request) };
      case "match_room_created":
        return { ...event, room: await this.enrichRoom(event.room) };
      case "teams_assigned": {
        const { teamA, teamB } = await this.enrichTeams(event.teamA, event.teamB);
        return { ...event, teamA, teamB };
      }
      default:
        return event;
    }
  }

  async restoreSession(): Promise<RestoredPlayerSession> {
    try {
      const [account, matchmaking] = await Promise.all([this.me(), this.getMatchmakingState()]);
      return { account, matchmaking };
    } catch (error) {
      if (isSessionInvalidError(error)) this.token = undefined;
      throw error;
    }
  }

  private async enrichAccount(account: AccountView): Promise<AccountView> {
    const profile = await this.resolveSteamProfile(account.steam64);
    const fallbackName = account.steam64?.trim() || "玩家";
    if (!profile) return { ...account, username: "", displayName: fallbackName, steamPersonaName: undefined, steamAvatarUrl: undefined };
    return {
      ...account,
      username: "",
      displayName: profile.personaName,
      steamPersonaName: profile.personaName,
      steamAvatarUrl: profile.avatarUrl,
    };
  }

  private async enrichFriendList(friends: PlayerFriendListDto): Promise<PlayerFriendListDto> {
    const [friendRows, incomingRequests, outgoingRequests] = await Promise.all([
      this.enrichFriendSearchResults(friends.friends),
      this.enrichFriendSearchResults(friends.incomingRequests),
      this.enrichFriendSearchResults(friends.outgoingRequests),
    ]);
    return {
      friends: friendRows as PlayerFriendDto[],
      incomingRequests: incomingRequests as PlayerFriendRequestDto[],
      outgoingRequests: outgoingRequests as PlayerFriendRequestDto[],
    };
  }

  private async enrichFriendRequest(request: PlayerFriendRequestDto): Promise<PlayerFriendRequestDto> {
    return (await this.enrichFriendSearchResults([request]))[0] as PlayerFriendRequestDto;
  }

  private async enrichFriendSearchResults<T extends PlayerFriendSearchResultDto>(items: T[]): Promise<T[]> {
    const steam64s = items.flatMap((item) => {
      const steam64 = item.steam64?.trim();
      return steam64 ? [steam64] : [];
    });
    if (steam64s.length === 0) return items.map((item) => this.sanitizeFriendDisplay(item));
    const profiles = await this.steamProfiles.resolveMany(steam64s);
    return items.map((item) => {
      const steam64 = item.steam64?.trim();
      const profile = steam64 ? profiles.get(steam64) : undefined;
      if (!profile) return this.sanitizeFriendDisplay(item);
      return {
        ...item,
        displayName: profile.personaName,
        steamPersonaName: profile.personaName,
        steamAvatarUrl: profile.avatarUrl,
      };
    });
  }

  private sanitizeFriendDisplay<T extends PlayerFriendSearchResultDto>(item: T): T {
    return {
      ...item,
      displayName: item.steam64?.trim() || "玩家",
      steamPersonaName: undefined,
      steamAvatarUrl: undefined,
    };
  }

  private async enrichMatchmakingState(state: PlayerMatchmakingStateDto): Promise<PlayerMatchmakingStateDto> {
    const roomIds = new Set<string>();
    const rooms = await Promise.all((state.rooms ?? []).map(async (room) => {
      roomIds.add(room.id);
      return this.enrichRoom(room);
    }));
    const room = state.room ? (roomIds.has(state.room.id) ? rooms.find((item) => item.id === state.room?.id) ?? state.room : await this.enrichRoom(state.room)) : null;
    return { ...state, rooms, partyInvitations: state.partyInvitations ?? [], room };
  }

  private async enrichRoom(room: PlayerLiveMatchStateDto): Promise<PlayerLiveMatchStateDto> {
    const steam64s = collectRoomSteam64s(room);
    if (steam64s.length === 0) return room;
    const profiles = await this.steamProfiles.resolveMany(steam64s);
    if (profiles.size === 0) return room;
    return {
      ...room,
      teamA: room.teamA ? enrichTeam(room.teamA, profiles) : room.teamA,
      teamB: room.teamB ? enrichTeam(room.teamB, profiles) : room.teamB,
    };
  }

  private async enrichTeams(teamA: PlayerMatchTeamDto, teamB: PlayerMatchTeamDto): Promise<{ teamA: PlayerMatchTeamDto; teamB: PlayerMatchTeamDto }> {
    const steam64s = collectParticipantSteam64s([...teamA.participants, ...teamB.participants]);
    if (steam64s.length === 0) return { teamA, teamB };
    const profiles = await this.steamProfiles.resolveMany(steam64s);
    if (profiles.size === 0) return { teamA, teamB };
    return {
      teamA: enrichTeam(teamA, profiles),
      teamB: enrichTeam(teamB, profiles),
    };
  }

  private async resolveSteamProfile(steam64?: string) {
    const normalized = steam64?.trim();
    if (!normalized) return undefined;
    return (await this.steamProfiles.resolveMany([normalized])).get(normalized);
  }

  private request<T>(method: string, route: string, body?: unknown): Promise<T> {
    return requestJson<T>({
      baseUrl: this.baseUrl,
      method,
      route,
      body,
      token: this.token,
      timeoutMs: REQUEST_TIMEOUT_MS,
      createResponseError: (message, statusCode) => new PlayerApiError(message, statusCode),
    });
  }
}

function collectRoomSteam64s(room: PlayerLiveMatchStateDto): string[] {
  return collectParticipantSteam64s([room.teamA, room.teamB].flatMap((team) => team?.participants ?? []));
}

function collectParticipantSteam64s(participants: PlayerMatchParticipantDto[]): string[] {
  return participants.flatMap((participant) => {
    const steam64 = participant.steam64?.trim();
    return steam64 ? [steam64] : [];
  });
}

function enrichTeam(team: PlayerMatchTeamDto, profiles: Map<string, { personaName: string; avatarUrl: string }>): PlayerMatchTeamDto {
  return {
    ...team,
    participants: team.participants.map((participant) => enrichParticipant(participant, profiles)),
  };
}

function enrichParticipant(
  participant: PlayerMatchParticipantDto,
  profiles: Map<string, { personaName: string; avatarUrl: string }>,
): PlayerMatchParticipantDto {
  const steam64 = participant.steam64?.trim();
  const profile = steam64 ? profiles.get(steam64) : undefined;
  if (!profile) return participant;
  return {
    ...participant,
    displayName: profile.personaName,
    steamPersonaName: profile.personaName,
    steamAvatarUrl: profile.avatarUrl,
  };
}
