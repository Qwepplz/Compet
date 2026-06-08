import { clipboard, ipcMain, shell } from "electron";
import type { PlayerMatchmakingStateDto, PlayerRealtimeSnapshotDto, PlayerRealtimeSnapshotReason, PlayerRealtimeSnapshotScope } from "../shared/types.js";
import { isSessionInvalidError, PlayerApiClient, type RestoredPlayerSession } from "./playerApiClient.js";
import { RemoteProfileService } from "./remoteProfileService.js";
import { PROFILE_BASE_URL } from "./profileConfig.js";
import { withAuthRetry } from "./authRetry.js";
import { appendBootLog } from "../../desktop/main/bootLog.js";

export interface SavedPlayerLogin {
  baseUrl: string;
  username?: string;
  password?: string;
}

interface PersistedSession extends SavedPlayerLogin {
  token?: string;
}

const emptyMatchmakingState: PlayerMatchmakingStateDto = { queue: [], rooms: [], party: null, partyInvitations: [], room: null };

export function isSafeSteamConnectUrl(connectUrl: string): boolean {
  if (typeof connectUrl !== "string" || /[\r\n]/.test(connectUrl)) return false;
  try {
    const parsed = new URL(connectUrl);
    return parsed.protocol === "steam:" && parsed.hostname === "connect" && parsed.pathname.length > 1;
  } catch {
    return false;
  }
}

interface IpcDeps {
  clearSession: () => Promise<void>;
  connectRealtime: (baseUrl: string, token: string) => void;
  disconnectRealtime: () => void;
  getApiClient: () => PlayerApiClient;
  loadSession: () => Promise<PersistedSession | null>;
  refreshRealtimeSnapshot: (reason: PlayerRealtimeSnapshotReason, scope?: PlayerRealtimeSnapshotScope) => Promise<PlayerRealtimeSnapshotDto>;
  saveSession: (session: PersistedSession) => Promise<void>;
  sendRealtimeCommand: <T>(name: string, payload: unknown) => Promise<T>;
  setApiClient: (client: PlayerApiClient | undefined) => void;
}

export interface RestoreSessionResult extends RestoredPlayerSession {
  baseUrl: string;
}

const profileBootLogFile = "compet-player-client-boot.log";
let profilesUpdatedHandler: (() => void) | undefined;
const sharedProfileService = new RemoteProfileService({
  baseUrl: PROFILE_BASE_URL,
  onLog: (message) => appendBootLog(profileBootLogFile, `[profiles] ${message}`),
  onProfilesUpdated: () => profilesUpdatedHandler?.(),
});

export function warmUpProfiles(): void {
  sharedProfileService.warmUp();
}

export function setProfilesUpdatedHandler(handler: () => void): void {
  profilesUpdatedHandler = handler;
}

function createPlayerApiClient(baseUrl: string, token: string | undefined, deps: IpcDeps): PlayerApiClient {
  return new PlayerApiClient(baseUrl, token, sharedProfileService, deps.sendRealtimeCommand);
}

function withSavedAuth<T>(deps: IpcDeps, operation: (client: PlayerApiClient) => Promise<T>): Promise<T> {
  return withAuthRetry({
    ...deps,
    createPlayerApiClient: (baseUrl, token) => createPlayerApiClient(baseUrl, token, deps),
  }, operation);
}

export function registerPlayerIpc(deps: IpcDeps): void {
  ipcMain.handle("auth:login", async (_event, baseUrl: string, username: string, password: string) => {
    const client = createPlayerApiClient(baseUrl, undefined, deps);
    const result = await client.login(username, password);
    deps.setApiClient(client);
    await deps.saveSession({ baseUrl, token: result.token, username, password });
    if (result.account.mustChangePassword) deps.disconnectRealtime();
    else deps.connectRealtime(baseUrl, result.token);
    return result;
  });

  ipcMain.handle("auth:logout", async () => {
    try {
      await deps.getApiClient().logout();
    } finally {
      deps.disconnectRealtime();
      deps.setApiClient(undefined);
      await deps.clearSession();
    }
  });

  ipcMain.handle("auth:changePassword", async (_event, currentPassword: string, newPassword: string) => {
    await deps.getApiClient().changePassword(currentPassword, newPassword);
    const persisted = await deps.loadSession();
    if (persisted) {
      await deps.saveSession({ ...persisted, password: newPassword });
    }
  });

  ipcMain.handle("friends:search", (_event, query: string) => withSavedAuth(deps, (client) => client.searchFriends(query)));
  ipcMain.handle("friends:list", () => withSavedAuth(deps, (client) => client.listFriends()));
  ipcMain.handle("friends:request", (_event, accountId: string) => withSavedAuth(deps, (client) => client.sendFriendRequest(accountId)));
  ipcMain.handle("friends:acceptRequest", (_event, requestId: string) => withSavedAuth(deps, (client) => client.acceptFriendRequest(requestId)));
  ipcMain.handle("friends:declineRequest", (_event, requestId: string) => withSavedAuth(deps, (client) => client.declineFriendRequest(requestId)));

  ipcMain.handle("party:get", () => withSavedAuth(deps, (client) => client.getParty()));
  ipcMain.handle("party:create", () => withSavedAuth(deps, (client) => client.createParty()));
  ipcMain.handle("party:invite", (_event, accountId: string) => withSavedAuth(deps, (client) => client.inviteToParty(accountId)));
  ipcMain.handle("party:acceptInvite", (_event, invitationId: string) => withSavedAuth(deps, (client) => client.acceptPartyInvite(invitationId)));
  ipcMain.handle("party:declineInvite", (_event, invitationId: string) => withSavedAuth(deps, (client) => client.declinePartyInvite(invitationId)));
  ipcMain.handle("party:leave", () => withSavedAuth(deps, (client) => client.leaveParty()));
  ipcMain.handle("party:startMatchmaking", (_event, options?: { dev?: boolean }) => withSavedAuth(deps, (client) => client.startPartyMatchmaking(options ?? {})));

  ipcMain.handle("matchmaking:getState", () => withSavedAuth(deps, (client) => client.getMatchmakingState()));
  ipcMain.handle("matchmaking:roomEntered", (_event, roomId: string) => withSavedAuth(deps, (client) => client.ackMatchRoomEntered(roomId)));
  ipcMain.handle("matchmaking:acceptReady", () => withSavedAuth(deps, (client) => client.acceptReady()));
  ipcMain.handle("matchmaking:declineReady", () => withSavedAuth(deps, (client) => client.declineReady()));
  ipcMain.handle("matchmaking:refreshSnapshot", (_event, scope?: PlayerRealtimeSnapshotScope) =>
    withSavedAuth(deps, () => deps.refreshRealtimeSnapshot("manual", scope)));

  ipcMain.handle("player:copyText", (_event, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle("player:openConnectUrl", (_event, connectUrl: string) => {
    if (!isSafeSteamConnectUrl(connectUrl)) throw new Error("Invalid Steam connect URL");
    return shell.openExternal(connectUrl);
  });

  ipcMain.handle("session:restore", async (): Promise<RestoreSessionResult | null> => {
    const persisted = await deps.loadSession();
    if (!persisted?.baseUrl) return null;

    if (persisted.token) {
      const client = createPlayerApiClient(persisted.baseUrl, persisted.token, deps);
      if (persisted.username && persisted.password) {
        client.setLoginCredentials(persisted.username, persisted.password);
      }
      try {
        const restored = await client.restoreSession();
        deps.setApiClient(client);
        deps.connectRealtime(persisted.baseUrl, persisted.token);
        return { baseUrl: persisted.baseUrl, ...restored };
      } catch (error) {
        if (!isSessionInvalidError(error)) throw error;
      }
    }

    if (!persisted.username || !persisted.password) {
      deps.disconnectRealtime();
      deps.setApiClient(undefined);
      await deps.clearSession();
      return null;
    }

    const client = createPlayerApiClient(persisted.baseUrl, undefined, deps);
    try {
      const loginResult = await client.login(persisted.username, persisted.password);
      deps.setApiClient(client);
      await deps.saveSession({ ...persisted, token: loginResult.token });
      if (loginResult.account.mustChangePassword) {
        deps.disconnectRealtime();
        return { baseUrl: persisted.baseUrl, account: loginResult.account, matchmaking: emptyMatchmakingState };
      }
      const restored = await client.restoreSession();
      deps.connectRealtime(persisted.baseUrl, loginResult.token);
      return { baseUrl: persisted.baseUrl, ...restored };
    } catch (error) {
      if (!isSessionInvalidError(error)) throw error;
      deps.disconnectRealtime();
      deps.setApiClient(undefined);
      await deps.clearSession();
      return null;
    }
  });

  ipcMain.handle("session:credentials", async (): Promise<SavedPlayerLogin | null> => {
    const persisted = await deps.loadSession();
    if (!persisted?.baseUrl) return null;
    return {
      baseUrl: persisted.baseUrl,
      username: persisted.username,
      password: persisted.password,
    };
  });
}
