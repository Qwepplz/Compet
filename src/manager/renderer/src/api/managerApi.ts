import type { AccountMatchDetail, AccountMatchHistory, AccountView, BootstrapAdminInput, CreateAccountInput, LogEntry, LoginResult, ManagerConfig, MatchmakingOccupancy, SavedLoginCredentials, UpdateAccountInput } from "../../../shared/types.js";
import type { UpdateCheckResult } from "../../../../desktop/updateTypes.js";

export type { UpdateCheckResult };

let authRequired = false;

export function isManagerAuthRequired(): boolean {
  return authRequired;
}

export const managerApi = {
  loadConfig: () => window.managerApi.loadConfig() as Promise<ManagerConfig>,
  saveConfig: (config: ManagerConfig) => window.managerApi.saveConfig(config) as Promise<void>,
  selectServerRoot: () => window.managerApi.selectServerRoot() as Promise<string | null>,
  serviceStatus: () => window.managerApi.serviceStatus(),
  startService: () => window.managerApi.startService(),
  stopService: () => window.managerApi.stopService(),
  restartService: () => window.managerApi.restartService(),
  writeBootstrap: (input: BootstrapAdminInput) => window.managerApi.writeBootstrap(input) as Promise<string>,
  login: async (username: string, password: string) => {
    const result = await window.managerApi.login(username, password) as LoginResult;
    authRequired = false;
    return result;
  },
  loadSavedLogin: () => window.managerApi.loadSavedLogin() as Promise<SavedLoginCredentials | null>,
  changePassword: (currentPassword: string, newPassword: string) => window.managerApi.changePassword(currentPassword, newPassword) as Promise<void>,
  onAuthRequired: (callback: () => void) => window.managerApi.onAuthRequired(() => {
    authRequired = true;
    callback();
  }),
  removeAuthRequiredListener: () => window.managerApi.removeAuthRequiredListener(),
  matchmakingOccupancy: () => window.managerApi.matchmakingOccupancy() as Promise<MatchmakingOccupancy>,
  getVersion: () => window.managerApi.getVersion() as Promise<string>,
  checkUpdate: () => window.managerApi.checkUpdate() as Promise<UpdateCheckResult>,
  installUpdate: () => window.managerApi.installUpdate() as Promise<UpdateCheckResult & { installing: boolean }>,
};

export const accountApi = {
  list: () => window.managerApi.listAccounts() as Promise<AccountView[]>,
  matches: (id: string, page: number) => window.managerApi.accountMatches(id, page) as Promise<AccountMatchHistory>,
  matchDetail: (id: string, matchId: string) => window.managerApi.accountMatchDetail(id, matchId) as Promise<AccountMatchDetail>,
  create: (input: CreateAccountInput) => window.managerApi.createAccount(input) as Promise<AccountView>,
  update: (id: string, input: UpdateAccountInput) => window.managerApi.updateAccount(id, input) as Promise<AccountView>,
  resetPassword: (id: string, password: string) => window.managerApi.resetPassword(id, password) as Promise<AccountView>,
  delete: (id: string) => window.managerApi.deleteAccount(id) as Promise<void>,
};

export const logApi = {
  recent: () => window.managerApi.recentLogs() as Promise<LogEntry[]>,
  onAppended: (callback: (entry: LogEntry) => void) => window.managerApi.onLogAppended((entry) => callback(entry as LogEntry)),
  removeAppendedListener: () => window.managerApi.removeLogAppendedListener(),
};
