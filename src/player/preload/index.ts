import { contextBridge, ipcRenderer } from "electron";
import type { PlayerLoginResult } from "../main/playerApiClient.js";
import type { RestoreSessionResult, SavedPlayerLogin } from "../main/ipc.js";
import type { AccountView } from "../../manager/shared/types.js";
import { createPreviewPlayerApi } from "./previewPlayerApi.js";
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
} from "../shared/types.js";

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args);

const subscribe = <T>(channel: string, listener: (payload: T) => void): (() => void) => {
  const handler = (_event: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
};

export const playerApi = {
  login: (baseUrl: string, username: string, password: string): Promise<PlayerLoginResult> =>
    invoke("auth:login", baseUrl, username, password),
  logout: (): Promise<void> => invoke("auth:logout"),
  changePassword: (currentPassword: string, newPassword: string): Promise<void> =>
    invoke("auth:changePassword", currentPassword, newPassword),
  restoreSession: (): Promise<RestoreSessionResult | null> => invoke("session:restore"),
  loadSavedLogin: (): Promise<SavedPlayerLogin | null> => invoke("session:credentials"),
  searchFriends: (query: string): Promise<PlayerFriendSearchResultDto[]> => invoke("friends:search", query),
  listFriends: (): Promise<PlayerFriendListDto> => invoke("friends:list"),
  sendFriendRequest: (accountId: string): Promise<PlayerFriendRequestDto> => invoke("friends:request", accountId),
  acceptFriendRequest: (requestId: string): Promise<PlayerFriendListDto> => invoke("friends:acceptRequest", requestId),
  declineFriendRequest: (requestId: string): Promise<void> => invoke("friends:declineRequest", requestId),
  getParty: (): Promise<PlayerPartyDto | null> => invoke("party:get"),
  createParty: (): Promise<PlayerPartyDto> => invoke("party:create"),
  inviteToParty: (accountId: string): Promise<PlayerPartyInvitationDto> => invoke("party:invite", accountId),
  acceptPartyInvite: (invitationId: string): Promise<PlayerPartyDto> => invoke("party:acceptInvite", invitationId),
  declinePartyInvite: (invitationId: string): Promise<void> => invoke("party:declineInvite", invitationId),
  leaveParty: (): Promise<void> => invoke("party:leave"),
  startPartyMatchmaking: (options?: { dev?: boolean }): Promise<PlayerLiveMatchStateDto> => invoke("party:startMatchmaking", options),
  getMatchmakingState: (): Promise<PlayerMatchmakingStateDto> => invoke("matchmaking:getState"),
  ackMatchRoomEntered: (roomId: string): Promise<PlayerLiveMatchStateDto> => invoke("matchmaking:roomEntered", roomId),
  acceptReady: (): Promise<PlayerLiveMatchStateDto> => invoke("matchmaking:acceptReady"),
  declineReady: (): Promise<PlayerLiveMatchStateDto> => invoke("matchmaking:declineReady"),
  refreshRealtimeSnapshot: (scope?: PlayerRealtimeSnapshotScope): Promise<PlayerRealtimeSnapshotDto> =>
    invoke("matchmaking:refreshSnapshot", scope),
  onRealtimeEvent: (listener: (event: PlayerRealtimeEvent) => void): (() => void) =>
    subscribe("player:realtime:event", listener),
  onRealtimeStatus: (listener: (status: PlayerRealtimeStatusDto) => void): (() => void) =>
    subscribe("player:realtime:status", listener),
  onRealtimeSnapshot: (listener: (snapshot: PlayerRealtimeSnapshotDto) => void): (() => void) =>
    subscribe("player:realtime:snapshot", listener),
  onAccountUpdated: (listener: (account: AccountView) => void): (() => void) =>
    subscribe("player:account:updated", listener),
  copyText: (text: string): Promise<void> => invoke("player:copyText", text),
  openConnectUrl: (connectUrl: string): Promise<void> => invoke("player:openConnectUrl", connectUrl),
};

contextBridge.exposeInMainWorld(
  "playerApi",
  process.env.COMPET_PLAYER_PREVIEW === "1" ? createPreviewPlayerApi() : playerApi,
);
