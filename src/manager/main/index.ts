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

const appPath = app.getAppPath();
const appPathIsResourcesApp = path.basename(appPath) === "app" && path.basename(path.dirname(appPath)) === "resources";
const isPackagedRuntime = app.isPackaged || appPathIsResourcesApp;
const appRoot = isPackagedRuntime ? appPath : process.cwd();
const managerUserDataPath = ensureManagerUserDataPath({
  appRoot,
  defaultUserDataPath: app.getPath("userData"),
  isPackaged: isPackagedRuntime,
});
if (isPackagedRuntime) app.setPath("userData", managerUserDataPath);

const configStore = new FileConfigStore(path.join(managerUserDataPath, "manager-config.json"), appRoot);
const credentialStore = new SavedLoginStore(path.join(managerUserDataPath, "manager-login.json"));
const logDir = path.join(appRoot, "server-data", "logs");
const sevenZipPath = isPackagedRuntime
  ? path.join(appRoot, "runtime", "7z", "7zr.exe")
  : path.join(appRoot, "packaging", "server", "runtime", "7zr.exe");
const logStore = new FileLogStore(logDir, { sevenZipPath });
const service = new ManagedServiceProcess(appRoot);
let apiClient = new ServiceApiClient("https://127.0.0.1:8443");
let mainWindow: BrowserWindow | undefined;

const { closeOfflineAccounts, stopService } = registerManagerIpc({
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
  onAuthRequired: () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("auth:required");
  },
});

function appendLog(input: Parameters<FileLogStore["append"]>[0]): void {
  void logStore.append(input).catch((error) => console.error("Failed to write manager log", error));
}

service.on("log", (entry) => appendLog(entry));
service.on("status", (status) => appendLog({
  source: "manager",
  level: status.state === "failed" ? "error" : "info",
  message: `Service state changed: ${status.state}`,
  context: { state: status.state, baseUrl: status.baseUrl, pid: status.pid ?? null, ...(status.lastError ? { errorCode: "service_error" } : {}) },
}));

let isQuitPromptOpen = false;
let isQuitConfirmed = false;

logStore.on("entry", (entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("logs:appended", entry);
});

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
    appendLog({ source: "manager", level: "error", message: "Renderer process exited", context: { reason: details.reason, exitCode: details.exitCode } });
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    appendBootLog(bootLogFile, `renderer load failed: ${errorCode} ${errorDescription}; ${validatedURL}`);
  });
  await loadDesktopWindow(win, __dirname);
  appendBootLog(bootLogFile, "desktop window load requested");
}

app.on("before-quit", (event) => {
  if (isQuitConfirmed || isQuitPromptOpen) return;
  event.preventDefault();

  isQuitPromptOpen = true;
  void (async () => {
    try {
      if (service.status().state === "running") {
        const choice = await dialog.showMessageBox({ type: "question", buttons: ["停止服务后退出", "保持服务运行并退出", "取消"], defaultId: 0, cancelId: 2, message: "托管服务仍在运行" });
        if (choice.response === 2) return;

        if (choice.response === 0) await stopService();
        else await closeOfflineAccounts();
      } else {
        await closeOfflineAccounts();
      }
      isQuitConfirmed = true;
      app.exit(0);
    } catch (error) {
      console.error("Failed to confirm manager quit", error);
    } finally {
      isQuitPromptOpen = false;
    }
  })();
});

app.whenReady().then(async () => {
  try {
    await logStore.archiveExpiredLogs();
  } catch (error) {
    console.error("Failed to archive expired logs during startup", error);
    appendBootLog(bootLogFile, "expired log archive failed", error);
    appendLog({ source: "manager", level: "error", message: "Expired log archive failed", context: { errorCode: "log_archive_error" } });
  }
  await createWindow();
}).catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error("Failed to start Compet Server Manager", message);
  appendBootLog(bootLogFile, "startup failed", error);
  appendLog({ source: "manager", level: "error", message: "Manager startup failed", context: { errorCode: "startup_error" } });
  dialog.showErrorBox("Compet Server Manager 启动失败", message);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
