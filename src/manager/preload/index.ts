import { contextBridge, ipcRenderer } from "electron";

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args);

export const managerApi = {
  loadConfig: () => invoke("config:load"),
  saveConfig: (config: unknown) => invoke("config:save", config),
  selectServerRoot: () => invoke("config:selectServerRoot"),
  serviceStatus: () => invoke("service:status"),
  startService: () => invoke("service:start"),
  stopService: () => invoke("service:stop"),
  restartService: () => invoke("service:restart"),
  writeBootstrap: (input: unknown) => invoke("bootstrap:write", input),
  runDiagnostics: (input: unknown) => invoke("diagnostics:run", input),
  login: (username: string, password: string) => invoke("auth:login", username, password),
  loadSavedLogin: () => invoke("credentials:load"),
  logout: () => invoke("auth:logout"),
  changePassword: (currentPassword: string, newPassword: string) => invoke("auth:changePassword", currentPassword, newPassword),
  serverInfo: () => invoke("server:info"),
  listAccounts: () => invoke("accounts:list"),
  createAccount: (input: unknown) => invoke("accounts:create", input),
  updateAccount: (id: string, input: unknown) => invoke("accounts:update", id, input),
  resetPassword: (id: string, password: string) => invoke("accounts:resetPassword", id, password),
  deleteAccount: (id: string) => invoke("accounts:delete", id),
  recentLogs: () => invoke("logs:recent"),
  listLogFiles: () => invoke("logs:listFiles"),
  readLogFile: (name: string) => invoke("logs:readFile", name),
};

contextBridge.exposeInMainWorld("managerApi", managerApi);
