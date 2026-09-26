import { clipboard, ipcMain, shell } from "electron";
import type { PlayerFriendSearchResultDto, PlayerLoginIpcResult, PlayerMatchmakingStateDto, PlayerRealtimeEvent, PlayerPartyDto, PlayerLiveMatchStateDto } from "../shared/types.js";
import { isSessionInvalidError, PlayerApiError, PlayerApiClient, type RestoredPlayerSession } from "./playerApiClient.js";
import { RemoteProfileService } from "./remoteProfileService.js";
import { createAuthRetry, type AuthRetryController } from "./authRetry.js";
import { revokePlayerSession } from "./sessionShutdown.js";
import { appendBootLog } from "../../desktop/main/bootLog.js";
import { cancelClientMaintenance, checkForUpdates, getCurrentVersion, getMaintenanceResult,
  installUpdate, isClientMaintenanceActive, repairClientIntegrity, verifyClientIntegrity } from "../../desktop/main/updateCheck.js";
import type { MaintenanceStartResult } from "../../desktop/updateTypes.js";
import type { LanguagePreferenceStore } from "../../desktop/main/languagePreferenceStore.js";
import { isSupportedLanguage } from "../../language/translate.js";
import { DEFAULT_PROFILE_BASE_URL } from "../../profiles/humanProfileIndex.js";

export interface SavedPlayerLogin {
  baseUrl: string;
  username?: string;
  password?: string;
}

interface PersistedSession extends SavedPlayerLogin {
  token?: string;
}

const emptyMatchmakingState: PlayerMatchmakingStateDto = { queue: [], rooms: [], party: null, partyInvitations: [], room: null, occupancy: { activeCount: 0 }, baseSeq: 0 };
const STARTUP_CONNECTION_BUDGET_MS = 5_000;

function playerOperationError(code: string, message: string, ErrorType: ErrorConstructor = Error): Error & { code: string } {
  const error = new ErrorType(message) as Error & { code: string };
  error.code = code;
  return error;
}

class PlayerStartupTimeoutError extends Error {
  readonly code = "ETIMEDOUT";

  constructor() {
    super("Server connection timed out");
    this.name = "PlayerStartupTimeoutError";
  }
}

function normalizeStartupTimeout(timeoutMs: unknown): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw playerOperationError("startup_timeout_invalid", "timeoutMs must be a finite positive number", RangeError);
  }
  return Math.min(timeoutMs, STARTUP_CONNECTION_BUDGET_MS);
}

function clearPlayerRuntime(deps: IpcDeps): void {
  deps.disconnectRealtime();
  deps.setApiClient(undefined);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "ETIMEDOUT";
}

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
  languageStore: LanguagePreferenceStore;
  loadSession: () => Promise<PersistedSession | null>;
  refreshRealtimeSnapshot: () => Promise<void>;
  saveSession: (session: PersistedSession) => Promise<void>;
  sendRealtimeCommand: <T>(name: string, payload: unknown) => Promise<T>;
  setApiClient: (client: PlayerApiClient | undefined) => void;
}

export interface PlayerAuthenticatedSession extends RestoredPlayerSession {
  baseUrl: string;
}

export type RestoreSessionResult = PlayerAuthenticatedSession;

const profileBootLogFile = "compet-player-client-boot.log";
const PROFILE_BASE_URL = process.env.COMPET_PROFILE_BASE_URL?.trim() || DEFAULT_PROFILE_BASE_URL;
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

export function createPlayerApiClient(baseUrl: string, token: string | undefined, deps: Pick<IpcDeps, "sendRealtimeCommand">): PlayerApiClient {
  return new PlayerApiClient(baseUrl, token, sharedProfileService, deps.sendRealtimeCommand);
}

async function withSavedSession<T>(
  deps: IpcDeps,
  assertCurrent: () => void,
  operation: (persisted: PersistedSession | null) => Promise<T>,
): Promise<T> {
  const persisted = await deps.loadSession();
  try { assertCurrent(); }
  catch (error) {
    if (persisted?.token) {
      await createPlayerApiClient(persisted.baseUrl, persisted.token, deps).logout().catch(() => undefined);
    }
    throw error;
  }
  return operation(persisted);
}

async function restorePersistedPlayerSession(
  deps: IpcDeps,
  persisted: PersistedSession & { token: string },
  timeoutMs?: number,
  assertWithinDeadline: () => void = () => undefined,
  assertCurrent: () => void = () => undefined,
): Promise<PlayerAuthenticatedSession> {
  const client = createPlayerApiClient(persisted.baseUrl, persisted.token, deps);
  if (persisted.username && persisted.password) {
    client.setLoginCredentials(persisted.username, persisted.password);
  }
  let restored: RestoredPlayerSession;
  try {
    restored = await client.restoreSession(timeoutMs);
  } finally {
    try { assertCurrent(); }
    catch (error) {
      await client.logout().catch(() => undefined);
      throw error;
    }
  }
  assertWithinDeadline();
  deps.setApiClient(client);
  deps.connectRealtime(persisted.baseUrl, persisted.token);
  return { baseUrl: persisted.baseUrl, ...restored };
}

async function authenticateAndRestorePlayer(
  deps: IpcDeps,
  baseUrl: string,
  username: string,
  password: string,
  remainingTimeout: () => number | undefined = () => undefined,
  assertWithinDeadline: () => void = () => undefined,
  preserveRuntimeOnFailure = false,
): Promise<PlayerAuthenticatedSession> {
  const client = createPlayerApiClient(baseUrl, undefined, deps);
  try {
    assertWithinDeadline();
    const loginResult = await client.login(username, password, remainingTimeout());
    assertWithinDeadline();
    const restored = loginResult.account.mustChangePassword
      ? { account: loginResult.account, matchmaking: emptyMatchmakingState }
      : await client.restoreSession(remainingTimeout());
    assertWithinDeadline();
    await deps.saveSession({ baseUrl, token: loginResult.token, username, password });
    assertWithinDeadline();
    deps.setApiClient(client);
    if (loginResult.account.mustChangePassword) deps.disconnectRealtime();
    else deps.connectRealtime(baseUrl, loginResult.token);
    return { baseUrl, ...restored };
  } catch (error) {
    const rollbackToken = client.getToken();
    if (rollbackToken) {
      try {
        await client.logout();
        const persisted = await deps.loadSession().catch(() => null);
        if (persisted?.token === rollbackToken) {
          await deps.clearSession().catch(() => undefined);
        }
      } catch {
        await deps.saveSession({ baseUrl, token: rollbackToken, username, password }).catch(() => undefined);
      }
    }
    if (!preserveRuntimeOnFailure) clearPlayerRuntime(deps);
    throw error;
  }
}

let maintenanceAdmission = false;
let maintenanceAccountId: string | undefined;
let maintenanceAbort: AbortController | undefined;

function roomHasAccount(room: PlayerLiveMatchStateDto, accountId: string): boolean {
  return room.humanAccountIds?.includes(accountId) === true ||
    room.ready?.some(entry => entry.accountId === accountId) === true ||
    [...(room.teamA?.participants ?? []), ...(room.teamB?.participants ?? [])].some(entry => entry.accountId === accountId);
}

function isActiveRoom(room: PlayerLiveMatchStateDto): boolean {
  return room.phase !== "completed" && room.phase !== "failed";
}

function ownPartyActive(party: PlayerPartyDto | null, accountId: string): boolean {
  return party?.memberAccountIds.includes(accountId) === true &&
    (party.status === "matchmaking" || party.status === "in_match" ||
      Boolean(party.matchmakingPendingAt || party.preload || party.lockedMatchId));
}

function ownMatchActive(state: PlayerMatchmakingStateDto, accountId: string): boolean {
  return state.queue.some(entry => entry.accountId === accountId) ||
    ownPartyActive(state.party, accountId) ||
    (state.room !== null && isActiveRoom(state.room)) ||
    state.rooms.some(room => isActiveRoom(room) &&
      (roomHasAccount(room, accountId) || Boolean(state.party && room.partyId === state.party.id)));
}

function ownIdleMultiParty(state: PlayerMatchmakingStateDto, accountId: string): boolean {
  return state.party?.memberAccountIds.includes(accountId) === true &&
    state.party.memberAccountIds.length > 1;
}

function cancelForOwnMatch(): void {
  if (!maintenanceAdmission && !isClientMaintenanceActive()) return;
  maintenanceAbort?.abort();
  cancelClientMaintenance();
}

export function observeMaintenanceMatchmakingState(state: PlayerMatchmakingStateDto): void {
  if (maintenanceAccountId &&
      (ownMatchActive(state, maintenanceAccountId) ||
        ownIdleMultiParty(state, maintenanceAccountId))) cancelForOwnMatch();
}

export function observeMaintenanceRealtimeEvent(event: PlayerRealtimeEvent): void {
  const accountId = maintenanceAccountId;
  if (!accountId) return;
  if (event.type === "party_updated" &&
      (ownPartyActive(event.party, accountId) ||
        (event.party?.memberAccountIds.includes(accountId) && event.party.memberAccountIds.length > 1))) {
    cancelForOwnMatch();
  } else if (event.type === "queue_updated" && event.queue.some(entry => entry.accountId === accountId)) {
    cancelForOwnMatch();
  } else if ((event.type === "match_room_created" || event.type === "match_room_updated") &&
      isActiveRoom(event.room) && roomHasAccount(event.room, accountId)) {
    cancelForOwnMatch();
  } else if ((event.type === "ready_check_started" || event.type === "ready_check_updated") &&
      event.humanParticipants.some(entry => entry.accountId === accountId)) {
    cancelForOwnMatch();
  }
}

export function registerPlayerIpc(deps: IpcDeps): AuthRetryController {
  const controller = createAuthRetry({
    getApiClient: deps.getApiClient,
    recover: async (assertCurrent) => {
      const current = deps.getApiClient();
      const persisted = await deps.loadSession();
      assertCurrent();
      const credentials = current.getLoginCredentials();
      const baseUrl = current.getBaseUrl() || persisted?.baseUrl;
      const username = credentials?.username || persisted?.username;
      const password = credentials?.password || persisted?.password;
      if (!baseUrl) return false;
      const token = persisted?.baseUrl === baseUrl ? persisted.token : current.getToken();
      if (token) {
        try {
          await restorePersistedPlayerSession(deps, { baseUrl, token, username, password }, undefined, assertCurrent);
          return true;
        } catch (error) {
          assertCurrent();
          if (!isSessionInvalidError(error)) throw error;
        }
      }
      if (!username || !password) return false;
      try {
        await authenticateAndRestorePlayer(deps, baseUrl, username, password, () => undefined, assertCurrent, true);
        return true;
      } catch (error) {
        assertCurrent();
        if (error instanceof PlayerApiError && (error.statusCode === 401 || error.statusCode === 409)) return false;
        throw error;
      }
    },
  });
  maintenanceAdmission = false;
  maintenanceAccountId = undefined;
  maintenanceAbort = undefined;
  const withSavedAuth = <T>(operation: (client: PlayerApiClient) => Promise<T>): Promise<T> => controller.run(operation);
  const maintenanceBusy = () => maintenanceAdmission || isClientMaintenanceActive();
  const withMaintenanceGuardedAuth = <T>(operation: (client: PlayerApiClient) => Promise<T>): Promise<T> => {
    if (maintenanceBusy()) return Promise.reject(playerOperationError("update_busy", "Client maintenance is active"));
    return withSavedAuth((client) => {
      if (maintenanceBusy()) throw playerOperationError("update_busy", "Client maintenance is active");
      return operation(client);
    });
  };
  const maintenanceBlock = async (): Promise<string | null> => {
    let client: PlayerApiClient | undefined;
    try { client = deps.getApiClient(); } catch { /* No active authenticated client. */ }
    if (!client) {
      try {
        if ((await deps.loadSession())?.token) return "integrity_match_state_unavailable";
      } catch { return "integrity_match_state_unavailable"; }
      maintenanceAccountId = undefined;
      return null;
    }
    try {
      const { account, state } = await controller.run(async (current) => {
        const [account, state] = await Promise.all([current.me(), current.getMatchmakingState()]);
        return { account, state };
      });
      if (!account?.id || !state || !Array.isArray(state.queue) || !Array.isArray(state.rooms)) {
        return "integrity_match_state_unavailable";
      }
      maintenanceAccountId = account.id;
      if (ownMatchActive(state, account.id)) return "integrity_match_active";
      if (ownIdleMultiParty(state, account.id)) return "integrity_party_leave_required";
      return null;
    } catch { return "integrity_match_state_unavailable"; }
  };
  ipcMain.handle("language:load", () => deps.languageStore.load());
  ipcMain.handle("language:save", (_event, language: unknown) => {
    if (!isSupportedLanguage(language)) throw playerOperationError("language_unsupported", "Unsupported language", TypeError);
    return deps.languageStore.save(language);
  });

  ipcMain.handle("auth:login", async (_event, baseUrl: string, username: string, password: string): Promise<PlayerLoginIpcResult<PlayerAuthenticatedSession>> => {
    try {
      return await controller.authenticate(async (assertCurrent, previous) => {
        await previous;
        return withSavedSession(deps, assertCurrent, async (persisted) => {
          const persistedToken = persisted?.token;
          if (
            persistedToken
            && persisted.baseUrl === baseUrl
            && persisted.username === username
            && persisted.password === password
          ) {
            try {
              const restored = await restorePersistedPlayerSession(deps, { ...persisted, token: persistedToken }, undefined, assertCurrent, assertCurrent);
              controller.resume();
              return { ok: true, value: restored };
            } catch (error) {
              if (!isSessionInvalidError(error)) throw error;
              clearPlayerRuntime(deps);
              await deps.clearSession();
            }
          }
          const restored = await authenticateAndRestorePlayer(deps, baseUrl, username, password, () => undefined, assertCurrent);
          controller.resume();
          return { ok: true, value: restored };
        });
      });
    } catch (error) {
      const details = error && typeof error === "object" ? error as { code?: unknown; statusCode?: unknown } : {};
      const statusCode = typeof details.statusCode === "number" && Number.isFinite(details.statusCode)
        ? details.statusCode : undefined;
      const rawCode = typeof details.code === "string" ? details.code : "";
      const knownCode = [
        "account_already_logged_in", "account_disabled", "manager_login_required",
        "player_login_required", "login_rate_limited", "invalid_credentials", "service_unavailable",
      ].includes(rawCode);
      const unavailable = statusCode === 503 || [
        "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
      ].includes(rawCode);
      return {
        ok: false,
        error: {
          code: knownCode ? rawCode : unavailable ? "service_unavailable" : "login_failed",
          message: "Login failed",
          ...(statusCode === undefined ? {} : { statusCode }),
        },
      };
    }
  });

  ipcMain.handle("auth:logout", async () => {
    await controller.suspend();
    await revokePlayerSession({
      ...deps,
      getApiClient: () => {
        try { return deps.getApiClient(); }
        catch { return undefined; }
      },
      createApiClient: (baseUrl, token) => createPlayerApiClient(baseUrl, token, deps),
    });
  });

  ipcMain.handle("auth:changePassword", async (_event, currentPassword: string, newPassword: string) => {
    await deps.getApiClient().changePassword(currentPassword, newPassword);
    const persisted = await deps.loadSession();
    if (persisted) {
      await deps.saveSession({ ...persisted, password: newPassword });
    }
  });

  ipcMain.handle("friends:search", (_event, query: string) => withSavedAuth((client) => client.searchFriends(query)));
  ipcMain.handle("friends:reenrich", (_event, results: PlayerFriendSearchResultDto[]) => withSavedAuth((client) => client.reenrichFriendSearchResults(results)));
  ipcMain.handle("friends:list", () => withSavedAuth((client) => client.listFriends()));
  ipcMain.handle("rankme:standing", () => withSavedAuth((client) => client.getRankmeStanding()));
  ipcMain.handle("matches:history", (_event, accountId?: string, page?: number) => withSavedAuth((client) => client.listMatchHistory(accountId, page)));
  ipcMain.handle("matches:result", (_event, matchId: string, accountId?: string) => withSavedAuth((client) => client.getMatchHistoryResult(matchId, accountId)));
  ipcMain.handle("friends:request", (_event, accountId: string) => withSavedAuth((client) => client.sendFriendRequest(accountId)));
  ipcMain.handle("friends:acceptRequest", (_event, requestId: string) => withSavedAuth((client) => client.acceptFriendRequest(requestId)));
  ipcMain.handle("friends:declineRequest", (_event, requestId: string) => withSavedAuth((client) => client.declineFriendRequest(requestId)));
  ipcMain.handle("friends:remove", (_event, friendshipId: string) => withSavedAuth((client) => client.removeFriend(friendshipId)));

  ipcMain.handle("party:get", () => withSavedAuth((client) => client.getParty()));
  ipcMain.handle("party:create", () => withSavedAuth((client) => client.createParty()));
  ipcMain.handle("party:invite", (_event, accountId: string) => withMaintenanceGuardedAuth((client) => client.inviteToParty(accountId)));
  ipcMain.handle("party:acceptInvite", (_event, invitationId: string) => withMaintenanceGuardedAuth((client) => client.acceptPartyInvite(invitationId)));
  ipcMain.handle("party:declineInvite", (_event, invitationId: string) => withSavedAuth((client) => client.declinePartyInvite(invitationId)));
  ipcMain.handle("party:ignoreInvite", (_event, invitationId: string) => withSavedAuth((client) => client.ignorePartyInvite(invitationId)));
  ipcMain.handle("party:leave", () => withSavedAuth((client) => client.leaveParty()));
  ipcMain.handle("party:preloadReady", (_event, matchId: string, resourceVersion: string) => withMaintenanceGuardedAuth((client) => client.acknowledgePreload(matchId, resourceVersion)));
  ipcMain.handle("match:readyViewReady", (_event, matchId: string, token: string) => withMaintenanceGuardedAuth((client) => client.acknowledgeReadyView(matchId, token)));
  ipcMain.handle("party:beginMatchmaking", (_event, options?: { dev?: boolean }) => withMaintenanceGuardedAuth((client) => client.beginPartyMatchmaking(options ?? {})));
  ipcMain.handle("party:cancelMatchmaking", () => withSavedAuth((client) => client.cancelPartyMatchmaking()));
  ipcMain.handle("party:startMatchmaking", (_event, options?: { dev?: boolean }) => withMaintenanceGuardedAuth((client) => client.startPartyMatchmaking(options ?? {})));

  ipcMain.handle("matchmaking:getState", () => withSavedAuth((client) => client.getMatchmakingState()));
  ipcMain.handle("matchmaking:acceptReady", () => withMaintenanceGuardedAuth((client) => client.acceptReady()));
  ipcMain.handle("matchmaking:declineReady", () => withSavedAuth((client) => client.declineReady()));
  ipcMain.handle("matchmaking:refreshSnapshot", () =>
    withSavedAuth(() => deps.refreshRealtimeSnapshot()));

  ipcMain.handle("player:copyText", (_event, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle("player:openConnectUrl", (_event, connectUrl: string) => {
    if (!isSafeSteamConnectUrl(connectUrl)) throw playerOperationError("connect_url_invalid", "Invalid Steam connect URL");
    return shell.openExternal(connectUrl);
  });

  ipcMain.handle("session:restore", async (_event, timeoutMs?: number): Promise<RestoreSessionResult | null> => {
    const normalizedTimeoutMs = normalizeStartupTimeout(timeoutMs);
    const deadline = normalizedTimeoutMs === undefined ? undefined : performance.now() + normalizedTimeoutMs;
    const remainingTimeout = (): number | undefined => {
      if (deadline === undefined) return undefined;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new PlayerStartupTimeoutError();
      return remaining;
    };
    return controller.authenticate(async (assertCurrent, suspended) => {
      const assertWithinDeadline = (): void => {
        assertCurrent();
        if (deadline !== undefined && deadline - performance.now() <= 0) throw new PlayerStartupTimeoutError();
      };

      let suspendTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remaining = remainingTimeout();
        if (remaining === undefined) await suspended;
        else await Promise.race([
          suspended,
          new Promise<never>((_resolve, reject) => {
            suspendTimer = setTimeout(() => reject(new PlayerStartupTimeoutError()), remaining);
          }),
        ]);
      } finally {
        if (suspendTimer) clearTimeout(suspendTimer);
      }
      return withSavedSession(deps, assertCurrent, async (persisted) => {
        assertWithinDeadline();
        if (!persisted?.baseUrl) return null;

        if (persisted.token) {
          try {
            const restored = await restorePersistedPlayerSession(
              deps,
              { ...persisted, token: persisted.token },
              remainingTimeout(),
              assertWithinDeadline,
              assertCurrent,
            );
            controller.resume();
            return restored;
          } catch (error) {
            if (!isSessionInvalidError(error)) {
              clearPlayerRuntime(deps);
              if (deadline !== undefined && isTimeoutError(error)) throw new PlayerStartupTimeoutError();
              throw error;
            }
            clearPlayerRuntime(deps);
            await deps.clearSession();
          }
        }

        if (!persisted.username || !persisted.password) {
          clearPlayerRuntime(deps);
          await deps.clearSession();
          return null;
        }

        try {
          const restored = await authenticateAndRestorePlayer(
            deps,
            persisted.baseUrl,
            persisted.username,
            persisted.password,
            remainingTimeout,
            assertWithinDeadline,
          );
          controller.resume();
          return restored;
        } catch (error) {
          clearPlayerRuntime(deps);
          if (isSessionInvalidError(error)) {
            await deps.clearSession();
            return null;
          }
          if (deadline !== undefined && isTimeoutError(error)) throw new PlayerStartupTimeoutError();
          throw error;
        }
      });
    });
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

  ipcMain.handle("updates:integrity", (event) => verifyClientIntegrity((progress) => {
    if (!event.sender.isDestroyed()) event.sender.send("updates:integrityProgress", progress);
  }));
  ipcMain.handle("updates:repair", async (event): Promise<MaintenanceStartResult> => {
    if (maintenanceBusy()) return { status: "failed", error: "update_busy" };
    maintenanceAdmission = true;
    const admission = new AbortController();
    maintenanceAbort = admission;
    let handedOff = false;
    try {
      const block = await maintenanceBlock();
      if (admission.signal.aborted) return { status: "cancelled", error: "update_cancelled" };
      if (block) return { status: "failed", error: block };
      const admittedAccountId = maintenanceAccountId;
      const result = await repairClientIntegrity((progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("updates:integrityProgress", progress);
      }, async () => {
        if (admission.signal.aborted) throw playerOperationError("update_cancelled", "Maintenance cancelled");
        const finalBlock = await maintenanceBlock();
        if (admission.signal.aborted) throw playerOperationError("update_cancelled", "Maintenance cancelled");
        if (finalBlock || (admittedAccountId && maintenanceAccountId !== admittedAccountId)) {
          throw playerOperationError(finalBlock ?? "integrity_match_state_unavailable", "Match state changed");
        }
      });
      handedOff = result.status === "installing";
      return result;
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return { status: "failed", error: typeof code === "string" &&
        /^(integrity|update|maintenance)_[a-z0-9_]+$/.test(code) ? code : "integrity_failed" };
    } finally {
      if (!handedOff) {
        maintenanceAdmission = false;
        maintenanceAccountId = undefined;
        if (maintenanceAbort === admission) maintenanceAbort = undefined;
      }
    }
  });
  ipcMain.handle("updates:cancelIntegrity", () => {
    maintenanceAbort?.abort();
    cancelClientMaintenance();
  });
  ipcMain.handle("updates:maintenanceResult", (_event, acknowledge?: boolean) =>
    getMaintenanceResult(acknowledge === true));
  ipcMain.handle("updates:version", () => getCurrentVersion());
  ipcMain.handle("updates:check", (_event, timeoutMs?: number) =>
    checkForUpdates("compet-player-client", normalizeStartupTimeout(timeoutMs)));
  ipcMain.handle("updates:install", () => installUpdate("compet-player-client", "Compet Player Client.exe"));
  return controller;
}
