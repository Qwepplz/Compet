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
  PlayerRealtimeSnapshotScope,
  PlayerRealtimeStatusDto,
} from "../../../shared/types.js";
import type { AccountView } from "../../../../manager/shared/types.js";

export interface PlayerRealtimeApi {
  refreshRealtimeSnapshot(scope?: PlayerRealtimeSnapshotScope): Promise<PlayerRealtimeSnapshotDto>;
  onRealtimeEvent(listener: (event: PlayerRealtimeEvent) => void): () => void;
  onRealtimeStatus(listener: (status: PlayerRealtimeStatusDto) => void): () => void;
  onRealtimeSnapshot(listener: (snapshot: PlayerRealtimeSnapshotDto) => void): () => void;
  onAccountUpdated(listener: (account: AccountView) => void): () => void;
  onProfilesUpdated?(listener: () => void): () => void;
}

export interface PlayerSavedLoginApi {
  loadSavedLogin(): Promise<{ baseUrl: string; username?: string; password?: string } | null>;
}

export interface PlayerFriendsApi {
  searchFriends(query: string): Promise<PlayerFriendSearchResultDto[]>;
  reenrichFriends?(results: PlayerFriendSearchResultDto[]): Promise<PlayerFriendSearchResultDto[]>;
  listFriends(): Promise<PlayerFriendListDto>;
  sendFriendRequest(accountId: string): Promise<PlayerFriendRequestDto>;
  acceptFriendRequest(requestId: string): Promise<PlayerFriendListDto>;
  declineFriendRequest(requestId: string): Promise<void>;
}

export interface PlayerPartyApi {
  getParty(): Promise<PlayerPartyDto | null>;
  createParty(): Promise<PlayerPartyDto>;
  inviteToParty(accountId: string): Promise<PlayerPartyInvitationDto>;
  acceptPartyInvite(invitationId: string): Promise<PlayerPartyDto>;
  declinePartyInvite(invitationId: string): Promise<void>;
  ignorePartyInvite(invitationId: string): Promise<void>;
  leaveParty(): Promise<void>;
  beginPartyMatchmaking(): Promise<PlayerPartyDto>;
  cancelPartyMatchmaking(): Promise<PlayerPartyDto | undefined>;
  startPartyMatchmaking(options?: { dev?: boolean }): Promise<PlayerLiveMatchStateDto>;
}

export interface PlayerMatchRoomApi {
  getMatchmakingState(): Promise<PlayerMatchmakingStateDto>;
  ackMatchRoomEntered(roomId: string): Promise<PlayerLiveMatchStateDto>;
  acceptReady(): Promise<PlayerLiveMatchStateDto>;
  declineReady(): Promise<PlayerLiveMatchStateDto>;
  copyText(text: string): Promise<void>;
}

export type PlayerApiWithRealtime = Window["playerApi"] & Partial<PlayerRealtimeApi>;
export type PlayerApiWithSavedLogin = Window["playerApi"] & Partial<PlayerSavedLoginApi>;
export type PlayerApiWithFriends = Window["playerApi"] & Partial<PlayerFriendsApi>;
export type PlayerApiWithParty = Window["playerApi"] & Partial<PlayerPartyApi>;
export type PlayerApiWithMatchRoom = Window["playerApi"] & Partial<PlayerMatchRoomApi>;

function hasMethods(api: Window["playerApi"], methods: Array<keyof PlayerRealtimeApi | keyof PlayerSavedLoginApi | keyof PlayerFriendsApi | keyof PlayerPartyApi | keyof PlayerMatchRoomApi>): boolean {
  return methods.every((method) => typeof (api as Record<string, unknown>)[method] === "function");
}

export function hasSavedLoginApi(api: Window["playerApi"]): api is PlayerApiWithSavedLogin {
  return hasMethods(api, ["loadSavedLogin"]);
}

export function hasRealtimeApi(api: Window["playerApi"]): api is PlayerApiWithRealtime {
  return hasMethods(api, ["refreshRealtimeSnapshot", "onRealtimeEvent", "onRealtimeStatus", "onRealtimeSnapshot", "onAccountUpdated"]);
}

export function hasFriendsApi(api: Window["playerApi"]): api is PlayerApiWithFriends {
  return hasMethods(api, ["searchFriends", "listFriends", "sendFriendRequest", "acceptFriendRequest", "declineFriendRequest"]);
}

export function hasPartyApi(api: Window["playerApi"]): api is PlayerApiWithParty {
  return hasMethods(api, ["getParty", "createParty", "inviteToParty", "acceptPartyInvite", "declinePartyInvite", "ignorePartyInvite", "leaveParty", "beginPartyMatchmaking", "cancelPartyMatchmaking", "startPartyMatchmaking"]);
}

export function hasMatchRoomApi(api: Window["playerApi"]): api is PlayerApiWithMatchRoom {
  return hasMethods(api, ["getMatchmakingState", "ackMatchRoomEntered", "acceptReady", "declineReady", "copyText"]);
}
