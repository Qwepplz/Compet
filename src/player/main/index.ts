import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { appendBootLog, describeBootEnvironment } from "../../desktop/main/bootLog.js";
import { delay } from "../../shared/async.js";
import { configureRemoteDesktopRendering } from "../../desktop/main/remoteRendering.js";
import { SavedLoginStore, type SavedLoginRecord } from "../../desktop/main/savedLoginStore.js";
import { LanguagePreferenceStore } from "../../desktop/main/languagePreferenceStore.js";
import { loadDesktopWindow, resolveDesktopWindowEntry } from "../../desktop/main/windowEntry.js";
import type {
  PlayerRealtimeEvent,
  PlayerRealtimeSnapshotDto,
  PlayerRealtimeStatusDto,
} from "../shared/types.js";
import type { AccountView } from "../../manager/shared/types.js";
import { createPlayerApiClient, observeMaintenanceMatchmakingState, observeMaintenanceRealtimeEvent,
  registerPlayerIpc, setProfilesUpdatedHandler, warmUpProfiles } from "./ipc.js";
import { PlayerApiClient } from "./playerApiClient.js";
import type { AuthRetryController } from "./authRetry.js";
import { PlayerRealtimeClient } from "./playerRealtimeClient.js";
import { deliverRealtimeEvent } from "./realtimeEventDelivery.js";
import { getRealtimeStatusAfterPollFailure, shouldApplyRealtimePollFailure } from "./realtimeStatus.js";
import { revokePlayerSession } from "./sessionShutdown.js";
import { translate } from "../../language/translate.js";
import { finalizeClientMaintenance } from "../../desktop/main/updateCheck.js";

const bootLogFile = "compet-player-client-boot.log";
appendBootLog(bootLogFile, `process starting; ${describeBootEnvironment()}`);
process.on("uncaughtException", (error) => appendBootLog(bootLogFile, "uncaught exception", error));
process.on("unhandledRejection", (error) => appendBootLog(bootLogFile, "unhandled rejection", error));

configureRemoteDesktopRendering();

const sessionFile = path.join(app.getPath("userData"), "player-session.json");
const sessionStore = new SavedLoginStore(sessionFile);
const languageStore = new LanguagePreferenceStore(path.join(app.getPath("userData"), "language.json"));
const realtimeClient = new PlayerRealtimeClient({
  onCommandTrace: ({ phase, commandId, name, connectionId, elapsedMs }) => {
    appendBootLog(
      bootLogFile,
      `realtime command ${phase}; name=${name ?? "unknown"}; commandId=${commandId}; connectionId=${connectionId}; elapsedMs=${elapsedMs ?? "unknown"}`,
    );
  },
});
const realtimeStatusChannel = "player:realtime:status";
const realtimeEventChannel = "player:realtime:event";
const realtimeSnapshotChannel = "player:realtime:snapshot";
const accountUpdatedChannel = "player:account:updated";
const profilesUpdatedChannel = "player:profiles:updated";
const PROFILES_UPDATED_DEBOUNCE_MS = 300;
const REALTIME_EVENT_ENRICH_TIMEOUT_MS = 1_500;
const REALTIME_EVENT_POLL_TIMEOUT_MS = 25_000;
const REALTIME_EVENT_POLL_RETRY_MS = 1_000;

let apiClient: PlayerApiClient | undefined;
let authRetryController: AuthRetryController | undefined;
let sessionCleanupTask: Promise<void> | undefined;
let mainWindow: BrowserWindow | undefined;
let realtimeSessionVersion = 0;
let connectedInCurrentSession = false;
let pauseRealtimeEvents = false;
let realtimeDeliveryQueue = Promise.resolve();
let quitAfterSessionCleanup = false;
let lastDeliveredRealtimeSeq = 0;
let realtimeStreamId: string | undefined;
let realtimeDeliveryGeneration = 0;
const queuedRealtimeEvents: PlayerRealtimeEvent[] = [];
let realtimeStatus: PlayerRealtimeStatusDto = { connection: "disconnected", stale: false };
let realtimeStatusRevision = 0;
let realtimeWebSocketConnected = false;
let activeRealtimePollSession: number | undefined;
let realtimePollGeneration = 0;
let realtimeSnapshotQueue: Promise<unknown> = Promise.resolve();
let profilesUpdatedTimer: ReturnType<typeof setTimeout> | undefined;

function currentMainWindow(): BrowserWindow | undefined {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
}

function registerWindowIpc(): void {
  ipcMain.handle("player:window:minimize", () => {
    currentMainWindow()?.minimize();
  });
  ipcMain.handle("player:window:close", () => {
    currentMainWindow()?.close();
  });
}

function queueRealtimeEvent(nextEvent: PlayerRealtimeEvent): void {
  queuedRealtimeEvents.push(nextEvent);
}

function acceptRealtimeEvent(event: PlayerRealtimeEvent): boolean {
  if (realtimeStreamId && event.streamId !== realtimeStreamId) return false;
  if (typeof event.seq !== "number") return true;
  if (event.seq <= lastDeliveredRealtimeSeq) return false;
  lastDeliveredRealtimeSeq = event.seq;
  return true;
}

async function loadSession(): Promise<(SavedLoginRecord & { baseUrl: string }) | null> {
  const persisted = await sessionStore.load();
  if (!persisted?.baseUrl) return null;
  return { ...persisted, baseUrl: persisted.baseUrl };
}

async function saveSession(session: SavedLoginRecord & { baseUrl: string }): Promise<void> {
  await sessionStore.save(session);
}

async function clearSession(): Promise<void> {
  await sessionStore.clearToken();
}

async function createWindow(): Promise<void> {
  appendBootLog(bootLogFile, "creating BrowserWindow");
  const entry = resolveDesktopWindowEntry(__dirname);
  appendBootLog(bootLogFile, `resolved entries preload=${entry.preloadPath}; renderer=${entry.rendererPath}; problems=${entry.problems.join(" | ")}`);
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    resizable: false,
    maximizable: false,
    backgroundColor: "#101010",
    frame: false,
    webPreferences: {
      preload: entry.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    appendBootLog(bootLogFile, `renderer process gone: ${details.reason}; exitCode=${details.exitCode}`);
    console.error(`Compet Player renderer process gone: ${details.reason}`);
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    appendBootLog(bootLogFile, `renderer load failed: ${errorCode} ${errorDescription}; ${validatedURL}`);
  });
  await loadDesktopWindow(win, __dirname, languageStore.load());
  appendBootLog(bootLogFile, "desktop window load requested");
}

function focusMainWindow(): void {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function publishRealtimeStatus(next: PlayerRealtimeStatusDto): void {
  if (realtimeStatus.connection === next.connection && realtimeStatus.stale === next.stale) {
    return;
  }
  realtimeStatus = next;
  realtimeStatusRevision += 1;
  broadcast(realtimeStatusChannel, next);
}

function publishRealtimeEvent(event: PlayerRealtimeEvent): void {
  observeMaintenanceRealtimeEvent(event);
  broadcast(realtimeEventChannel, event);
}

function publishRealtimeEventNowOrQueue(event: PlayerRealtimeEvent, sessionVersion: number): void {
  if (sessionVersion !== realtimeSessionVersion) return;
  if (pauseRealtimeEvents) {
    queueRealtimeEvent(event);
    return;
  }
  publishRealtimeEvent(event);
}

function publishRealtimeSnapshot(snapshot: PlayerRealtimeSnapshotDto): void {
  observeMaintenanceMatchmakingState(snapshot.matchmaking);
  broadcast(realtimeSnapshotChannel, snapshot);
}

function publishAccount(account: AccountView): void {
  broadcast(accountUpdatedChannel, account);
}

async function refreshAccount(): Promise<void> {
  if (!apiClient) return;
  const account = await apiClient.me();
  if (apiClient) publishAccount(account);
}

function handleProfilesUpdated(): void {
  if (profilesUpdatedTimer !== undefined) return;
  profilesUpdatedTimer = setTimeout(() => {
    profilesUpdatedTimer = undefined;
    broadcast(profilesUpdatedChannel, undefined);
    if (!apiClient) return;
    void refreshAccount().catch(() => undefined);
    if (realtimeSessionVersion > 0) {
      void refreshRealtimeSnapshot().catch(() => undefined);
    }
  }, PROFILES_UPDATED_DEBOUNCE_MS);
}

function currentApiClient(): PlayerApiClient {
  if (!apiClient) {
    throw new Error("Not authenticated");
  }
  return apiClient;
}

async function refreshRealtimeSnapshot(): Promise<void> {
  const refresh = realtimeSnapshotQueue.then(() => performRealtimeSnapshotRefresh());
  realtimeSnapshotQueue = refresh.catch(() => undefined);
  return refresh;
}

async function performRealtimeSnapshotRefresh(): Promise<void> {
  const sessionVersion = realtimeSessionVersion;
  pauseRealtimeEvents = true;
  try {
    if (!authRetryController) return;
    const snapshot = await authRetryController.run((client) => client.fetchRealtimeSnapshot());
    if (sessionVersion !== realtimeSessionVersion) {
      return;
    }

    const streamChanged = snapshot.matchmaking.streamId !== realtimeStreamId;
    const sequenceReset = snapshot.matchmaking.baseSeq < lastDeliveredRealtimeSeq;
    if (streamChanged || sequenceReset) {
      realtimeDeliveryGeneration += 1;
      realtimeDeliveryQueue = Promise.resolve();
      const currentStreamEvents = snapshot.matchmaking.streamId
        ? queuedRealtimeEvents.filter((event) => event.streamId === snapshot.matchmaking.streamId)
        : [];
      queuedRealtimeEvents.splice(0, queuedRealtimeEvents.length, ...currentStreamEvents);
    }
    realtimeStreamId = snapshot.matchmaking.streamId;
    realtimeClient.setLastSeq(snapshot.matchmaking.baseSeq);
    lastDeliveredRealtimeSeq = snapshot.matchmaking.baseSeq;
    publishRealtimeSnapshot(snapshot);
    if (realtimeStatus.connection === "connected") {
      publishRealtimeStatus({ connection: "connected", stale: false });
    }
  } finally {
    if (sessionVersion === realtimeSessionVersion) {
      pauseRealtimeEvents = realtimeStatus.connection !== "connected";
      if (realtimeStatus.connection === "connected") {
        flushQueuedRealtimeEvents(sessionVersion);
      }
    }
  }
}

function connectRealtime(baseUrl: string, token: string): void {
  realtimeSessionVersion += 1;
  realtimeStreamId = undefined;
  realtimeDeliveryGeneration += 1;
  connectedInCurrentSession = false;
  realtimeWebSocketConnected = false;
  activeRealtimePollSession = undefined;
  realtimePollGeneration += 1;
  pauseRealtimeEvents = false;
  realtimeDeliveryQueue = Promise.resolve();
  lastDeliveredRealtimeSeq = 0;
  queuedRealtimeEvents.length = 0;
  realtimeClient.connect(baseUrl, token);
}

function sendRealtimeCommand<T>(name: string, payload: unknown): Promise<T> {
  return realtimeClient.sendCommand<T>(name, payload);
}

function disconnectRealtime(): void {
  realtimeSessionVersion += 1;
  realtimeStreamId = undefined;
  realtimeDeliveryGeneration += 1;
  connectedInCurrentSession = false;
  realtimeWebSocketConnected = false;
  activeRealtimePollSession = undefined;
  realtimePollGeneration += 1;
  pauseRealtimeEvents = false;
  realtimeDeliveryQueue = Promise.resolve();
  lastDeliveredRealtimeSeq = 0;
  queuedRealtimeEvents.length = 0;
  realtimeClient.disconnect();
  publishRealtimeStatus({ connection: "disconnected", stale: false });
}

function receiveRealtimeEvent(event: PlayerRealtimeEvent, sessionVersion: number): void {
  if (sessionVersion !== realtimeSessionVersion) return;
  if (pauseRealtimeEvents) {
    queueRealtimeEvent(event);
    return;
  }
  if (!acceptRealtimeEvent(event)) return;
  deliverAcceptedRealtimeEvent(event, sessionVersion);
}

function deliverAcceptedRealtimeEvent(event: PlayerRealtimeEvent, sessionVersion: number): void {
  if (!doesRealtimeEventNeedEnrich(event)) {
    publishRealtimeEventNowOrQueue(event, sessionVersion);
    return;
  }
  if (shouldPublishRealtimeEventBeforeEnrich(event)) {
    publishRealtimeEventNowOrQueue(event, sessionVersion);
  }
  publishEnrichedRealtimeEvent(event, sessionVersion);
}

function startRealtimeEventPolling(sessionVersion: number): void {
  if (activeRealtimePollSession === sessionVersion) return;
  activeRealtimePollSession = sessionVersion;
  const pollGeneration = ++realtimePollGeneration;
  void pollRealtimeEvents(sessionVersion, pollGeneration).finally(() => {
    if (activeRealtimePollSession === sessionVersion && realtimePollGeneration === pollGeneration) {
      activeRealtimePollSession = undefined;
    }
  });
}

async function pollRealtimeEvents(sessionVersion: number, pollGeneration: number): Promise<void> {
  while (
    sessionVersion === realtimeSessionVersion
    && pollGeneration === realtimePollGeneration
    && !realtimeWebSocketConnected
  ) {
    const pollStartedStatusRevision = realtimeStatusRevision;
    try {
      if (!authRetryController) return;
      const result = await authRetryController.run(
        (client) => client.fetchRealtimeEvents(lastDeliveredRealtimeSeq, REALTIME_EVENT_POLL_TIMEOUT_MS),
      );
      if (
        sessionVersion !== realtimeSessionVersion
        || pollGeneration !== realtimePollGeneration
        || realtimeWebSocketConnected
      ) return;
      if (result.gap || result.streamId !== realtimeStreamId) {
        await refreshRealtimeSnapshot();
        if (sessionVersion !== realtimeSessionVersion || pollGeneration !== realtimePollGeneration) return;
      }
      if (result.streamId !== realtimeStreamId) continue;
      if (!connectedInCurrentSession) connectedInCurrentSession = true;
      pauseRealtimeEvents = false;
      publishRealtimeStatus({ connection: "connected", stale: false });
      flushQueuedRealtimeEvents(sessionVersion);
      for (const event of result.events) {
        receiveRealtimeEvent(event, sessionVersion);
      }
      if (result.latestSeq > lastDeliveredRealtimeSeq) {
        lastDeliveredRealtimeSeq = result.latestSeq;
      }
    } catch {
      if (sessionVersion !== realtimeSessionVersion || pollGeneration !== realtimePollGeneration) return;
      if (!shouldApplyRealtimePollFailure(pollStartedStatusRevision, realtimeStatusRevision)) {
        await delay(REALTIME_EVENT_POLL_RETRY_MS);
        continue;
      }
      const nextStatus = getRealtimeStatusAfterPollFailure(realtimeStatus, connectedInCurrentSession);
      pauseRealtimeEvents = nextStatus.connection !== "disconnected";
      publishRealtimeStatus(nextStatus);
      await delay(REALTIME_EVENT_POLL_RETRY_MS);
    }
  }
}

realtimeClient.onEvent((event) => {
  receiveRealtimeEvent(event, realtimeSessionVersion);
});

realtimeClient.onStatus((connection) => {
  const sessionVersion = realtimeSessionVersion;
  if (connection === "connecting") {
    realtimeWebSocketConnected = false;
    if (connectedInCurrentSession) {
      pauseRealtimeEvents = true;
      publishRealtimeStatus({ connection, stale: true });
      startRealtimeEventPolling(sessionVersion);
    } else {
      publishRealtimeStatus({ connection, stale: false });
    }
    return;
  }

  if (connection === "disconnected") {
    realtimeWebSocketConnected = false;
    if (connectedInCurrentSession) {
      pauseRealtimeEvents = true;
      publishRealtimeStatus({ connection, stale: true });
    } else {
      publishRealtimeStatus({ connection, stale: false });
    }
    startRealtimeEventPolling(sessionVersion);
    return;
  }

  realtimeWebSocketConnected = true;
  activeRealtimePollSession = undefined;
  realtimePollGeneration += 1;

  if (!connectedInCurrentSession) {
    connectedInCurrentSession = true;
    pauseRealtimeEvents = true;
    publishRealtimeStatus({ connection, stale: true });
    void refreshRealtimeSnapshot().catch(() => {
      if (sessionVersion === realtimeSessionVersion) {
        publishRealtimeStatus({ connection: "connected", stale: true });
      }
    });
    return;
  }

  pauseRealtimeEvents = true;
  publishRealtimeStatus({ connection, stale: true });
  void refreshRealtimeSnapshot().catch(() => {
    if (sessionVersion === realtimeSessionVersion) {
      publishRealtimeStatus({ connection: "connected", stale: true });
    }
  });
});

function publishEnrichedRealtimeEvent(event: PlayerRealtimeEvent, sessionVersion: number): void {
  const deliveryGeneration = realtimeDeliveryGeneration;
  const publishedBeforeEnrich = shouldPublishRealtimeEventBeforeEnrich(event);
  realtimeDeliveryQueue = realtimeDeliveryQueue
    .then(() => deliveryGeneration !== realtimeDeliveryGeneration ? undefined : deliverRealtimeEvent(event, sessionVersion, (next) => currentApiClient().enrichRealtimeEvent(next), {
      getSessionVersion: () => realtimeSessionVersion,
      isPaused: () => pauseRealtimeEvents,
      isSuperseded: (next) => deliveryGeneration !== realtimeDeliveryGeneration
        || Boolean(realtimeStreamId && next.streamId !== realtimeStreamId)
        || (publishedBeforeEnrich && typeof next.seq === "number" && next.seq < lastDeliveredRealtimeSeq),
      queue: queueRealtimeEvent,
      publish: publishRealtimeEvent,
      enrichTimeoutMs: REALTIME_EVENT_ENRICH_TIMEOUT_MS,
      publishFallback: !publishedBeforeEnrich,
    }))
    .catch(() => undefined);
}

function flushQueuedRealtimeEvents(sessionVersion: number): void {
  if (pauseRealtimeEvents || sessionVersion !== realtimeSessionVersion || queuedRealtimeEvents.length === 0) {
    return;
  }
  const queued = queuedRealtimeEvents.splice(0, queuedRealtimeEvents.length).sort((left, right) => {
    if (typeof left.seq !== "number") return 1;
    if (typeof right.seq !== "number") return -1;
    return left.seq - right.seq;
  });
  for (const event of queued) {
    if (!acceptRealtimeEvent(event)) continue;
    deliverAcceptedRealtimeEvent(event, sessionVersion);
  }
}

function doesRealtimeEventNeedEnrich(event: PlayerRealtimeEvent): boolean {
  return event.type === "friend_request_received"
    || event.type === "friend_request_resolved"
    || event.type === "match_room_created"
    || event.type === "match_room_updated"
    || event.type === "match_completed";
}

function shouldPublishRealtimeEventBeforeEnrich(event: PlayerRealtimeEvent): boolean {
  return event.type !== "match_completed" && doesRealtimeEventNeedEnrich(event);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);

  app.whenReady().then(async () => {
    const maintenanceReport = await finalizeClientMaintenance();
    if (maintenanceReport === "exit_requested") return;
    if (maintenanceReport?.error) appendBootLog(bootLogFile, `maintenance verification: ${maintenanceReport.error}`);
    registerWindowIpc();
    authRetryController = registerPlayerIpc({
      clearSession,
      connectRealtime,
      disconnectRealtime,
      getApiClient: currentApiClient,
      languageStore,
      loadSession,
      refreshRealtimeSnapshot,
      saveSession,
      sendRealtimeCommand,
      setApiClient: (client) => {
        apiClient = client;
      },
    });
    setProfilesUpdatedHandler(handleProfilesUpdated);
    warmUpProfiles();

    await createWindow();

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
      else focusMainWindow();
    });
  }).catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error("Failed to start Compet Player Client", message);
    appendBootLog(bootLogFile, "startup failed", error);
    dialog.showErrorBox(translate(languageStore.load(), "desktop.startup.title"), message);
    app.exit(1);
  });
}

app.on("before-quit", (event) => {
  if (quitAfterSessionCleanup || (!authRetryController && !apiClient)) return;
  event.preventDefault();
  if (sessionCleanupTask) return;
  sessionCleanupTask = (async () => {
    await authRetryController?.suspend();
    await revokePlayerSession({
      loadSession,
      createApiClient: (baseUrl, token) => createPlayerApiClient(baseUrl, token, { sendRealtimeCommand }),
      clearSession,
      disconnectRealtime,
      getApiClient: () => apiClient,
      setApiClient: (client) => {
        apiClient = client;
      },
    }).catch(() => undefined);
  })().finally(() => {
    quitAfterSessionCleanup = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
