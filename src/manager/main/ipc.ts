import { dialog, ipcMain } from "electron";
import type { FileConfigStore } from "./configStore.js";
import type { FileLogStore } from "./logStore.js";
import type { ManagedServiceProcess } from "./serviceProcess.js";
import type { ManagerConfig, SavedLoginCredentials, ServiceStatus } from "../shared/types.js";
import { ServiceApiClient } from "./serviceApiClient.js";
import { writeBootstrapAdminFile } from "./bootstrapFile.js";
import { runLocalDiagnostics } from "./diagnostics.js";
import { delay } from "../../shared/async.js";

export interface IpcDeps {
  configStore: FileConfigStore;
  logStore: FileLogStore;
  service: ManagedServiceProcess;
  getApiClient: () => ServiceApiClient;
  loadSavedLogin: () => Promise<SavedLoginCredentials | null>;
  saveSavedLogin: (credentials: SavedLoginCredentials) => Promise<void>;
  clearSavedLogin: () => Promise<void>;
  setApiClient: (client: ServiceApiClient) => void;
}

const STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_POLL_INTERVAL_MS = 250;

export function registerManagerIpc(deps: IpcDeps): void {
  ipcMain.handle("config:load", () => deps.configStore.load());
  ipcMain.handle("config:save", (_event, config) => deps.configStore.save(config));
  ipcMain.handle("config:selectServerRoot", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select CSGO Dedicated Server directory",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("service:status", () => statusWithExternalProbe(deps));
  ipcMain.handle("service:start", async () => {
    const config = await deps.configStore.load();
    const external = await probeExternalService(config);
    if (external) {
      deps.setApiClient(external.apiClient);
      return external.status;
    }
    const status = await deps.service.start(config);
    const apiClient = new ServiceApiClient(status.baseUrl);
    deps.setApiClient(apiClient);
    return waitForServiceReady(deps.service, apiClient);
  });
  ipcMain.handle("service:stop", () => deps.service.stop());
  ipcMain.handle("service:restart", async () => {
    await deps.service.stop();
    const config = await deps.configStore.load();
    const status = await deps.service.start(config);
    const apiClient = new ServiceApiClient(status.baseUrl);
    deps.setApiClient(apiClient);
    return waitForServiceReady(deps.service, apiClient);
  });
  ipcMain.handle("bootstrap:write", async (_event, input) => writeBootstrapAdminFile((await deps.configStore.load()).dataDir, input));
  ipcMain.handle("diagnostics:run", (_event, input) => runLocalDiagnostics(input));
  ipcMain.handle("auth:login", async (_event, username: string, password: string) => {
    try {
      const result = await deps.getApiClient().login(username, password);
      await deps.saveSavedLogin({ username, password });
      return result;
    } catch (error) {
      await deps.clearSavedLogin();
      throw error;
    }
  });
  ipcMain.handle("auth:logout", () => deps.getApiClient().logout());
  ipcMain.handle("auth:changePassword", async (_event, currentPassword: string, newPassword: string) => {
    await deps.getApiClient().changePassword(currentPassword, newPassword);
    const savedLogin = await deps.loadSavedLogin();
    if (savedLogin) {
      await deps.saveSavedLogin({ ...savedLogin, password: newPassword });
    }
  });
  ipcMain.handle("credentials:load", () => deps.loadSavedLogin());
  ipcMain.handle("server:info", () => deps.getApiClient().serverInfo());
  ipcMain.handle("accounts:list", () => deps.getApiClient().accounts());
  ipcMain.handle("accounts:create", (_event, input) => deps.getApiClient().createAccount(input));
  ipcMain.handle("accounts:update", (_event, id, input) => deps.getApiClient().updateAccount(id, input));
  ipcMain.handle("accounts:resetPassword", (_event, id, password) => deps.getApiClient().resetPassword(id, password));
  ipcMain.handle("accounts:delete", (_event, id) => deps.getApiClient().deleteAccount(id));
  ipcMain.handle("logs:recent", () => deps.logStore.recent());
  ipcMain.handle("logs:listFiles", () => deps.logStore.listFiles());
  ipcMain.handle("logs:readFile", (_event, name: string) => deps.logStore.readFile(name));
}

async function statusWithExternalProbe(deps: IpcDeps): Promise<ServiceStatus> {
  const current = deps.service.status();
  if (current.state === "running" || current.state === "starting" || current.state === "stopping") {
    return current;
  }

  const config = await deps.configStore.load();
  const external = await probeExternalService(config);
  if (!external) return { ...current, baseUrl: baseUrl(config) };

  deps.setApiClient(external.apiClient);
  return external.status;
}

async function probeExternalService(config: ManagerConfig): Promise<{ apiClient: ServiceApiClient; status: ServiceStatus } | undefined> {
  const apiClient = new ServiceApiClient(baseUrl(config));
  try {
    const info = await apiClient.serverInfo();
    return {
      apiClient,
      status: {
        state: "running",
        baseUrl: baseUrl(config),
        version: info.version,
        certificateFingerprintSha256: info.certificateFingerprintSha256,
      },
    };
  } catch {
    return undefined;
  }
}

function baseUrl(config: ManagerConfig): string {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  return `https://${host}:${config.port}`;
}

export async function waitForServiceReady(
  service: Pick<ManagedServiceProcess, "status">,
  apiClient: Pick<ServiceApiClient, "serverInfo">,
  timeoutMs = STARTUP_TIMEOUT_MS,
  intervalMs = STARTUP_POLL_INTERVAL_MS,
): Promise<ReturnType<ManagedServiceProcess["status"]>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = service.status();
    if (status.state === "failed" || status.state === "stopped") return status;

    try {
      const info = await apiClient.serverInfo();
      return {
        ...status,
        version: info.version,
        certificateFingerprintSha256: info.certificateFingerprintSha256,
      };
    } catch {
      await delay(intervalMs);
    }
  }

  return service.status();
}
