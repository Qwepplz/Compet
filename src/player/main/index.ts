import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import { appendBootLog, describeBootEnvironment } from "../../desktop/main/bootLog.js";
import { configureRemoteDesktopRendering } from "../../desktop/main/remoteRendering.js";
import { SavedLoginStore, type SavedLoginRecord } from "../../desktop/main/savedLoginStore.js";
import { loadDesktopWindow, resolveDesktopWindowEntry } from "../../desktop/main/windowEntry.js";
import type {
  PlayerRealtimeEvent,
  PlayerRealtimeSnapshotDto,
  PlayerRealtimeSnapshotReason,
  PlayerRealtimeSnapshotScope,
  PlayerRealtimeStatusDto,
} from "../shared/types.js";
import { registerPlayerIpc } from "./ipc.js";
import { PlayerApiClient } from "./playerApiClient.js";
import { PlayerRealtimeClient } from "./playerRealtimeClient.js";
import { deliverRealtimeEvent } from "./realtimeEventDelivery.js";
import { getRealtimeStatusAfterPollFailure, shouldApplyRealtimePollFailure } from "./realtimeStatus.js";
import { revokePlayerSessionForExit } from "./sessionShutdown.js";

const bootLogFile = "compet-player-client-boot.log";
appendBootLog(bootLogFile, `process starting; ${describeBootEnvironment()}`);
process.on("uncaughtException", (error) => appendBootLog(bootLogFile, "uncaught exception", error));
process.on("unhandledRejection", (error) => appendBootLog(bootLogFile, "unhandled rejection", error));

configureRemoteDesktopRendering();

const sessionFile = path.join(app.getPath("userData"), "player-session.json");
const sessionStore = new SavedLoginStore(sessionFile);
const realtimeClient = new PlayerRealtimeClient();
const realtimeStatusChannel = "player:realtime:status";
const realtimeEventChannel = "player:realtime:event";
const realtimeSnapshotChannel = "player:realtime:snapshot";
const MAX_QUEUED_REALTIME_EVENTS = 200;
const REALTIME_EVENT_ENRICH_TIMEOUT_MS = 1_500;
const REALTIME_EVENT_POLL_TIMEOUT_MS = 25_000;
const REALTIME_EVENT_POLL_RETRY_MS = 1_000;

let apiClient: PlayerApiClient | undefined;
let mainWindow: BrowserWindow | undefined;
let realtimeSessionVersion = 0;
let connectedInCurrentSession = false;
let pauseRealtimeEvents = false;
let realtimeDeliveryQueue = Promise.resolve();
let quitAfterSessionCleanup = false;
let lastDeliveredRealtimeSeq = 0;
const queuedRealtimeEvents: PlayerRealtimeEvent[] = [];
let realtimeStatus: PlayerRealtimeStatusDto = { connection: "disconnected", stale: false };
let realtimeStatusRevision = 0;

function queueRealtimeEvent(nextEvent: PlayerRealtimeEvent): void {
  queuedRealtimeEvents.push(nextEvent);
  if (queuedRealtimeEvents.length > MAX_QUEUED_REALTIME_EVENTS) {
    queuedRealtimeEvents.splice(0, queuedRealtimeEvents.length - MAX_QUEUED_REALTIME_EVENTS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function acceptRealtimeEvent(event: PlayerRealtimeEvent): boolean {
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
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#101010",
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
  await loadDesktopWindow(win, __dirname);
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
  broadcast(realtimeEventChannel, event);
}

function publishRealtimeEventNowOrQueue(event: PlayerRealtimeEvent, sessionVersion: number): void {
  if (sessionVersion !== realtimeSessionVersion) return;
  if (pauseRealtimeEvents && !canPublishRealtimeEventWhileSnapshotting(event)) {
    queueRealtimeEvent(event);
    return;
  }
  publishRealtimeEvent(event);
}

function publishRealtimeSnapshot(snapshot: PlayerRealtimeSnapshotDto): void {
  broadcast(realtimeSnapshotChannel, snapshot);
}

function canPublishRealtimeEventWhileSnapshotting(event: PlayerRealtimeEvent): boolean {
  switch (event.type) {
    case "friend_request_received":
    case "friend_request_resolved":
    case "friend_list_refresh":
    case "party_updated":
    case "party_invite_received":
    case "party_invite_resolved":
    case "match_room_created":
      return true;
    default:
      return false;
  }
}

function currentApiClient(): PlayerApiClient {
  if (!apiClient) {
    throw new Error("Not authenticated");
  }
  return apiClient;
}

async function refreshRealtimeSnapshot(
  reason: PlayerRealtimeSnapshotReason,
  scope: PlayerRealtimeSnapshotScope = "full",
): Promise<PlayerRealtimeSnapshotDto> {
  const sessionVersion = realtimeSessionVersion;
  pauseRealtimeEvents = true;
  try {
    const snapshot = await currentApiClient().fetchRealtimeSnapshot(reason, scope);
    if (sessionVersion !== realtimeSessionVersion) {
      return snapshot;
    }

    publishRealtimeSnapshot(snapshot);
    if (realtimeStatus.connection === "connected") {
      publishRealtimeStatus({ connection: "connected", stale: false });
    }
    return snapshot;
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
  connectedInCurrentSession = false;
  pauseRealtimeEvents = false;
  realtimeDeliveryQueue = Promise.resolve();
  lastDeliveredRealtimeSeq = 0;
  queuedRealtimeEvents.length = 0;
  realtimeClient.connect(baseUrl, token);
  void pollRealtimeEvents(realtimeSessionVersion);
}

function sendRealtimeCommand<T>(name: string, payload: unknown): Promise<T> {
  return realtimeClient.sendCommand<T>(name, payload);
}

function disconnectRealtime(): void {
  realtimeSessionVersion += 1;
  connectedInCurrentSession = false;
  pauseRealtimeEvents = false;
  realtimeDeliveryQueue = Promise.resolve();
  lastDeliveredRealtimeSeq = 0;
  queuedRealtimeEvents.length = 0;
  realtimeClient.disconnect();
  publishRealtimeStatus({ connection: "disconnected", stale: false });
}

function receiveRealtimeEvent(event: PlayerRealtimeEvent, sessionVersion: number): void {
  if (sessionVersion !== realtimeSessionVersion || !acceptRealtimeEvent(event)) return;
  deliverAcceptedRealtimeEvent(event, sessionVersion);
}

function deliverAcceptedRealtimeEvent(event: PlayerRealtimeEvent, sessionVersion: number): void {
  if (pauseRealtimeEvents && !canPublishRealtimeEventWhileSnapshotting(event)) {
    queueRealtimeEvent(event);
    return;
  }
  if (!doesRealtimeEventNeedEnrich(event)) {
    publishRealtimeEventNowOrQueue(event, sessionVersion);
    return;
  }
  if (shouldPublishRealtimeEventBeforeEnrich(event)) {
    publishRealtimeEventNowOrQueue(event, sessionVersion);
  }
  publishEnrichedRealtimeEvent(event, sessionVersion);
}

async function pollRealtimeEvents(sessionVersion: number): Promise<void> {
  while (sessionVersion === realtimeSessionVersion) {
    const pollStartedStatusRevision = realtimeStatusRevision;
    try {
      const result = await currentApiClient().fetchRealtimeEvents(lastDeliveredRealtimeSeq, REALTIME_EVENT_POLL_TIMEOUT_MS);
      if (sessionVersion !== realtimeSessionVersion) return;
      if (result.gap) {
        await refreshRealtimeSnapshot("reconnected");
        if (sessionVersion !== realtimeSessionVersion) return;
      }
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
      if (sessionVersion !== realtimeSessionVersion) return;
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
    if (connectedInCurrentSession) {
      pauseRealtimeEvents = true;
      publishRealtimeStatus({ connection, stale: true });
    } else {
      publishRealtimeStatus({ connection, stale: false });
    }
    return;
  }

  if (connection === "disconnected") {
    if (connectedInCurrentSession) {
      pauseRealtimeEvents = true;
      publishRealtimeStatus({ connection, stale: true });
    } else {
      publishRealtimeStatus({ connection, stale: false });
    }
    return;
  }

  if (!connectedInCurrentSession) {
    connectedInCurrentSession = true;
    pauseRealtimeEvents = true;
    publishRealtimeStatus({ connection, stale: true });
    void refreshRealtimeSnapshot("manual").catch(() => {
      if (sessionVersion === realtimeSessionVersion) {
        publishRealtimeStatus({ connection: "connected", stale: true });
      }
    });
    return;
  }

  pauseRealtimeEvents = true;
  publishRealtimeStatus({ connection, stale: true });
  void refreshRealtimeSnapshot("reconnected", "matchmaking").catch(() => {
    if (sessionVersion === realtimeSessionVersion) {
      publishRealtimeStatus({ connection: "connected", stale: true });
    }
  });
});

function publishEnrichedRealtimeEvent(event: PlayerRealtimeEvent, sessionVersion: number): void {
  realtimeDeliveryQueue = realtimeDeliveryQueue
    .then(() => deliverRealtimeEvent(event, sessionVersion, (next) => currentApiClient().enrichRealtimeEvent(next), {
      getSessionVersion: () => realtimeSessionVersion,
      isPaused: () => pauseRealtimeEvents,
      queue: queueRealtimeEvent,
      publish: publishRealtimeEvent,
      enrichTimeoutMs: REALTIME_EVENT_ENRICH_TIMEOUT_MS,
      publishFallback: !shouldPublishRealtimeEventBeforeEnrich(event),
    }))
    .catch(() => undefined);
}

function flushQueuedRealtimeEvents(sessionVersion: number): void {
  if (pauseRealtimeEvents || sessionVersion !== realtimeSessionVersion || queuedRealtimeEvents.length === 0) {
    return;
  }
  const queued = queuedRealtimeEvents.splice(0, queuedRealtimeEvents.length);
  for (const event of queued) {
    if (!doesRealtimeEventNeedEnrich(event)) {
      publishRealtimeEventNowOrQueue(event, sessionVersion);
      continue;
    }
    if (shouldPublishRealtimeEventBeforeEnrich(event)) {
      publishRealtimeEventNowOrQueue(event, sessionVersion);
    }
    publishEnrichedRealtimeEvent(event, sessionVersion);
  }
}

function doesRealtimeEventNeedEnrich(event: PlayerRealtimeEvent): boolean {
  return event.type === "friend_request_received"
    || event.type === "friend_request_resolved"
    || event.type === "match_room_created"
    || event.type === "teams_assigned";
}

function shouldPublishRealtimeEventBeforeEnrich(event: PlayerRealtimeEvent): boolean {
  return doesRealtimeEventNeedEnrich(event);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);

  app.whenReady().then(async () => {
    registerPlayerIpc({
      clearSession,
      connectRealtime,
      disconnectRealtime,
      getApiClient: currentApiClient,
      loadSession,
      refreshRealtimeSnapshot,
      saveSession,
      sendRealtimeCommand,
      setApiClient: (client) => {
        apiClient = client;
      },
    });

    await createWindow();

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
      else focusMainWindow();
    });
  }).catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error("Failed to start Compet Player Client", message);
    appendBootLog(bootLogFile, "startup failed", error);
    dialog.showErrorBox("Compet Player Client 启动失败", message);
    app.exit(1);
  });
}

app.on("before-quit", (event) => {
  if (quitAfterSessionCleanup || !apiClient) return;
  event.preventDefault();
  void revokePlayerSessionForExit({
    clearSession,
    disconnectRealtime,
    getApiClient: () => apiClient,
    setApiClient: (client) => {
      apiClient = client;
    },
  }).finally(() => {
    quitAfterSessionCleanup = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
