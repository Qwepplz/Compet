import { app, BrowserWindow } from "electron";
import path from "node:path";
import { SavedLoginStore, type SavedLoginRecord } from "../../desktop/main/savedLoginStore.js";
import { loadDesktopWindow, resolveDesktopWindowEntry } from "../../desktop/main/windowEntry.js";
import type {
  PlayerRealtimeEvent,
  PlayerRealtimeSnapshotDto,
  PlayerRealtimeSnapshotReason,
  PlayerRealtimeStatusDto,
} from "../shared/types.js";
import { registerPlayerIpc } from "./ipc.js";
import { PlayerApiClient } from "./playerApiClient.js";
import { PlayerRealtimeClient } from "./playerRealtimeClient.js";
import { deliverRealtimeEvent } from "./realtimeEventDelivery.js";
import { revokePlayerSessionForExit } from "./sessionShutdown.js";

const sessionFile = path.join(app.getPath("userData"), "player-session.json");
const sessionStore = new SavedLoginStore(sessionFile);
const realtimeClient = new PlayerRealtimeClient();
const realtimeStatusChannel = "player:realtime:status";
const realtimeEventChannel = "player:realtime:event";
const realtimeSnapshotChannel = "player:realtime:snapshot";

let apiClient: PlayerApiClient | undefined;
let mainWindow: BrowserWindow | undefined;
let realtimeSessionVersion = 0;
let connectedInCurrentSession = false;
let pauseRealtimeEvents = false;
let realtimeDeliveryQueue = Promise.resolve();
let quitAfterSessionCleanup = false;
const queuedRealtimeEvents: PlayerRealtimeEvent[] = [];
let realtimeStatus: PlayerRealtimeStatusDto = { connection: "disconnected", stale: false };

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
  const entry = resolveDesktopWindowEntry(__dirname);
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
  await loadDesktopWindow(win, __dirname);
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
  broadcast(realtimeStatusChannel, next);
}

function publishRealtimeEvent(event: PlayerRealtimeEvent): void {
  broadcast(realtimeEventChannel, event);
}

function publishRealtimeSnapshot(snapshot: PlayerRealtimeSnapshotDto): void {
  broadcast(realtimeSnapshotChannel, snapshot);
}

function currentApiClient(): PlayerApiClient {
  if (!apiClient) {
    throw new Error("Not authenticated");
  }
  return apiClient;
}

async function refreshRealtimeSnapshot(reason: PlayerRealtimeSnapshotReason): Promise<PlayerRealtimeSnapshotDto> {
  const sessionVersion = realtimeSessionVersion;
  pauseRealtimeEvents = true;
  const snapshot = await currentApiClient().fetchRealtimeSnapshot(reason);
  if (sessionVersion !== realtimeSessionVersion) {
    return snapshot;
  }

  publishRealtimeSnapshot(snapshot);
  pauseRealtimeEvents = realtimeStatus.connection !== "connected";
  if (realtimeStatus.connection === "connected") {
    publishRealtimeStatus({ connection: "connected", stale: false });
    flushQueuedRealtimeEvents(sessionVersion);
  }
  return snapshot;
}

function connectRealtime(baseUrl: string, token: string): void {
  realtimeSessionVersion += 1;
  connectedInCurrentSession = false;
  pauseRealtimeEvents = false;
  realtimeDeliveryQueue = Promise.resolve();
  queuedRealtimeEvents.length = 0;
  realtimeClient.connect(baseUrl, token);
}

function disconnectRealtime(): void {
  realtimeSessionVersion += 1;
  connectedInCurrentSession = false;
  pauseRealtimeEvents = false;
  realtimeDeliveryQueue = Promise.resolve();
  queuedRealtimeEvents.length = 0;
  realtimeClient.disconnect();
  publishRealtimeStatus({ connection: "disconnected", stale: false });
}

realtimeClient.onEvent((event) => {
  if (pauseRealtimeEvents) {
    queuedRealtimeEvents.push(event);
    return;
  }
  const sessionVersion = realtimeSessionVersion;
  publishEnrichedRealtimeEvent(event, sessionVersion);
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
  void refreshRealtimeSnapshot("reconnected").catch(() => {
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
      queue: (next) => queuedRealtimeEvents.push(next),
      publish: publishRealtimeEvent,
    }))
    .catch(() => undefined);
}

function flushQueuedRealtimeEvents(sessionVersion: number): void {
  if (pauseRealtimeEvents || sessionVersion !== realtimeSessionVersion || queuedRealtimeEvents.length === 0) {
    return;
  }
  const queued = queuedRealtimeEvents.splice(0, queuedRealtimeEvents.length);
  for (const event of queued) {
    publishEnrichedRealtimeEvent(event, sessionVersion);
  }
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
      setApiClient: (client) => {
        apiClient = client;
      },
    });

    await createWindow();

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
      else focusMainWindow();
    });
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
