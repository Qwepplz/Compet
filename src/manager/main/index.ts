import path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { SavedLoginStore } from "../../desktop/main/savedLoginStore.js";
import { appendBootLog, describeBootEnvironment } from "../../desktop/main/bootLog.js";
import { configureRemoteDesktopRendering } from "../../desktop/main/remoteRendering.js";
import { loadDesktopWindow, resolveDesktopWindowEntry } from "../../desktop/main/windowEntry.js";
import { FileConfigStore } from "./configStore.js";
import { FileLogStore } from "./logStore.js";
import { ManagedServiceProcess } from "./serviceProcess.js";
import { ServiceApiClient } from "./serviceApiClient.js";
import { registerManagerIpc } from "./ipc.js";
import { ensureManagerUserDataPath } from "./userDataPath.js";

const bootLogFile = "compet-server-manager-boot.log";
appendBootLog(bootLogFile, `process starting; ${describeBootEnvironment()}`);
process.on("uncaughtException", (error) => appendBootLog(bootLogFile, "uncaught exception", error));
process.on("unhandledRejection", (error) => appendBootLog(bootLogFile, "unhandled rejection", error));

configureRemoteDesktopRendering();

const appRoot = app.isPackaged ? app.getAppPath() : process.cwd();
const managerUserDataPath = ensureManagerUserDataPath({
  appRoot,
  defaultUserDataPath: app.getPath("userData"),
  isPackaged: app.isPackaged,
});
if (app.isPackaged) app.setPath("userData", managerUserDataPath);

const configStore = new FileConfigStore(path.join(managerUserDataPath, "manager-config.json"), appRoot);
const credentialStore = new SavedLoginStore(path.join(managerUserDataPath, "manager-login.json"));
const logStore = new FileLogStore(path.join(appRoot, "server-data", "logs"));
const service = new ManagedServiceProcess(appRoot);
let apiClient = new ServiceApiClient("https://127.0.0.1:8443");

registerManagerIpc({
  configStore,
  logStore,
  service,
  getApiClient: () => apiClient,
  loadSavedLogin: async () => {
    const saved = await credentialStore.load();
    if (!saved?.username && !saved?.password) return null;
    return { username: saved.username, password: saved.password };
  },
  saveSavedLogin: (credentials) => credentialStore.save(credentials),
  clearSavedLogin: () => credentialStore.clear(),
  setApiClient: (client) => { apiClient = client; },
});

function appendLog(...args: Parameters<FileLogStore["append"]>): void {
  void logStore.append(...args).catch((error) => console.error("Failed to write manager log", error));
}

service.on("log", (source, level, message) => appendLog(source, level, message));
service.on("status", (status) => appendLog("manager", "info", `service state ${status.state}`));

let isQuitPromptOpen = false;
let isQuitConfirmed = false;
let mainWindow: BrowserWindow | undefined;

async function createWindow(): Promise<void> {
  appendBootLog(bootLogFile, "creating BrowserWindow");
  const entry = resolveDesktopWindowEntry(__dirname);
  appendBootLog(bootLogFile, `resolved entries preload=${entry.preloadPath}; renderer=${entry.rendererPath}; problems=${entry.problems.join(" | ")}`);
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
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
    appendLog("manager", "error", `renderer process gone: ${details.reason}`);
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    appendBootLog(bootLogFile, `renderer load failed: ${errorCode} ${errorDescription}; ${validatedURL}`);
  });
  await loadDesktopWindow(win, __dirname);
  appendBootLog(bootLogFile, "desktop window load requested");
}

app.on("before-quit", async (event) => {
  if (isQuitConfirmed || service.status().state !== "running") return;

  event.preventDefault();
  if (isQuitPromptOpen) return;

  isQuitPromptOpen = true;
  try {
    const choice = await dialog.showMessageBox({ type: "question", buttons: ["停止服务后退出", "保持服务运行并退出", "取消"], defaultId: 0, cancelId: 2, message: "托管服务仍在运行" });
    if (choice.response === 2) return;

    if (choice.response === 0) await service.stop();
    isQuitConfirmed = true;
    app.exit(0);
  } catch (error) {
    console.error("Failed to confirm manager quit", error);
  } finally {
    isQuitPromptOpen = false;
  }
});

app.whenReady().then(createWindow).catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error("Failed to start Compet Server Manager", message);
  appendBootLog(bootLogFile, "startup failed", error);
  appendLog("manager", "error", `startup failed: ${message}`);
  dialog.showErrorBox("Compet Server Manager 启动失败", message);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
