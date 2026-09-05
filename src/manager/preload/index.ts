import { contextBridge, ipcRenderer } from "electron";
import type { ServiceStatus } from "../shared/types.js";

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args);

export const managerApi = {
  loadConfig: () => invoke("config:load"),
  saveConfig: (config: unknown) => invoke("config:save", config),
  selectServerRoot: () => invoke("config:selectServerRoot"),
  serviceStatus: () => invoke<ServiceStatus>("service:status"),
  startService: () => invoke<ServiceStatus>("service:start"),
  stopService: () => invoke<ServiceStatus>("service:stop"),
  restartService: () => invoke<ServiceStatus>("service:restart"),
  bootstrapRequired: () => invoke<boolean>("bootstrap:required"),
  writeBootstrap: (input: unknown) => invoke("bootstrap:write", input),
  login: (username: string, password: string) => invoke("auth:login", username, password),
  loadSavedLogin: () => invoke("credentials:load"),
  logout: () => invoke("auth:logout"),
  changePassword: (currentPassword: string, newPassword: string) => invoke("auth:changePassword", currentPassword, newPassword),
  onAuthRequired: (callback: () => void) => {
    ipcRenderer.removeAllListeners("auth:required");
    ipcRenderer.on("auth:required", () => callback());
  },
  removeAuthRequiredListener: () => {
    ipcRenderer.removeAllListeners("auth:required");
  },
  matchmakingOccupancy: () => invoke("matchmaking:occupancy"),
  listAccounts: () => invoke("accounts:list"),
  accountMatches: (id: string, page: number) => invoke("accounts:matches", id, page),
  accountMatchDetail: (id: string, matchId: string) => invoke("accounts:matchDetail", id, matchId),
  createAccount: (input: unknown) => invoke("accounts:create", input),
  updateAccount: (id: string, input: unknown) => invoke("accounts:update", id, input),
  resetPassword: (id: string, password: string) => invoke("accounts:resetPassword", id, password),
  deleteAccount: (id: string) => invoke("accounts:delete", id),
  recentLogs: () => invoke("logs:recent"),
  onLogAppended: (callback: (entry: unknown) => void) => {
    ipcRenderer.removeAllListeners("logs:appended");
    const listener = (_event: Electron.IpcRendererEvent, entry: unknown) => callback(entry);
    ipcRenderer.on("logs:appended", listener);
  },
  removeLogAppendedListener: () => {
    ipcRenderer.removeAllListeners("logs:appended");
  },
  getVersion: (): Promise<string> => invoke("updates:version"),
  checkUpdate: () => invoke("updates:check"),
  installUpdate: () => invoke("updates:install"),
};

contextBridge.exposeInMainWorld("managerApi", managerApi);
