import type { AccountView, BootstrapAdminInput, CreateAccountInput, DiagnosticResult, LogEntry, LoginResult, ManagerConfig, SavedLoginCredentials, ServiceStatus, UpdateAccountInput } from "../../../shared/types.js";

export const managerApi = {
  loadConfig: () => window.managerApi.loadConfig() as Promise<ManagerConfig>,
  saveConfig: (config: ManagerConfig) => window.managerApi.saveConfig(config) as Promise<void>,
  selectServerRoot: () => window.managerApi.selectServerRoot() as Promise<string | null>,
  serviceStatus: () => window.managerApi.serviceStatus() as Promise<ServiceStatus>,
  startService: () => window.managerApi.startService() as Promise<ServiceStatus>,
  stopService: () => window.managerApi.stopService() as Promise<ServiceStatus>,
  restartService: () => window.managerApi.restartService() as Promise<ServiceStatus>,
  writeBootstrap: (input: BootstrapAdminInput) => window.managerApi.writeBootstrap(input) as Promise<string>,
  runDiagnostics: (input: unknown) => window.managerApi.runDiagnostics(input) as Promise<DiagnosticResult[]>,
  login: (username: string, password: string) => window.managerApi.login(username, password) as Promise<LoginResult>,
  loadSavedLogin: () => window.managerApi.loadSavedLogin() as Promise<SavedLoginCredentials | null>,
  changePassword: (currentPassword: string, newPassword: string) => window.managerApi.changePassword(currentPassword, newPassword) as Promise<void>,
};

export const accountApi = {
  list: () => window.managerApi.listAccounts() as Promise<AccountView[]>,
  create: (input: CreateAccountInput) => window.managerApi.createAccount(input) as Promise<AccountView>,
  update: (id: string, input: UpdateAccountInput) => window.managerApi.updateAccount(id, input) as Promise<AccountView>,
  resetPassword: (id: string, password: string) => window.managerApi.resetPassword(id, password) as Promise<AccountView>,
  revokeSessions: (id: string) => window.managerApi.revokeSessions(id) as Promise<{ revoked: number }>,
};

export const logApi = {
  recent: () => window.managerApi.recentLogs() as Promise<LogEntry[]>,
  listFiles: () => window.managerApi.listLogFiles() as Promise<string[]>,
  readFile: (name: string) => window.managerApi.readLogFile(name) as Promise<string>,
};
