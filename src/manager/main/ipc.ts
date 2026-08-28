import { dialog, ipcMain } from "electron";
import path from "node:path";
import type { FileConfigStore } from "./configStore.js";
import type { FileLogStore } from "./logStore.js";
import type { ManagedServiceProcess } from "./serviceProcess.js";
import type { AccountMatchDetail, AccountMatchHistory, AccountView, CreateAccountInput, ManagerConfig, SavedLoginCredentials, ServiceStatus, UpdateAccountInput } from "../shared/types.js";
import { ServiceApiClient, ServiceApiError } from "./serviceApiClient.js";
import { writeBootstrapAdminFile } from "./bootstrapFile.js";
import { delay } from "../../shared/async.js";
import { checkForUpdates, getCurrentVersion, installUpdate } from "../../desktop/main/updateCheck.js";
import { AccountService } from "../../accounts/accountService.js";
import { accountIdSchema, createAccountSchema, patchAccountSchema, passwordSchema } from "../../accounts/accountInputSchemas.js";
import { AccountRepository } from "../../accounts/accountRepository.js";
import type { AccountRecord } from "../../accounts/accountTypes.js";
import { AuthService } from "../../auth/authService.js";
import { InMemoryLoginRateLimiter } from "../../auth/rateLimiter.js";
import { SessionRepository } from "../../auth/sessionRepository.js";
import { SessionService } from "../../auth/sessionService.js";
import type { ActivityLogInput, LogActor } from "../../shared/activityLog.js";
import { MatchRecordStore } from "../../records/matchRecordStore.js";
import { MATCH_HISTORY_PAGE_SIZE, matchHistoryMatchIdSchema, matchHistoryPageSchema, toMatchHistoryEntry } from "../../records/matchHistory.js";
import { openCompetDatabase } from "../../storage/competDatabase.js";
import { SerialQueue } from "../../storage/serialQueue.js";
import type { DatabaseSync } from "node:sqlite";

export interface IpcDeps {
  configStore: FileConfigStore;
  logStore: FileLogStore;
  service: ManagedServiceProcess;
  getApiClient: () => ServiceApiClient;
  loadSavedLogin: () => Promise<SavedLoginCredentials | null>;
  saveSavedLogin: (credentials: SavedLoginCredentials) => Promise<void>;
  clearSavedLogin: () => Promise<void>;
  setApiClient: (client: ServiceApiClient) => void;
  onAuthRequired?: () => void;
}

const STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_POLL_INTERVAL_MS = 250;

export interface ManagerIpcLifecycle {
  closeOfflineAccounts(): Promise<void>;
  stopService(): Promise<ServiceStatus>;
}

export function registerManagerIpc(deps: IpcDeps): ManagerIpcLifecycle {
  type OfflineAccountsContext = {
    database: DatabaseSync;
    databasePath: string;
    accounts: AccountService;
    sessions: SessionService;
    auth: AuthService;
    records: MatchRecordStore;
  };

  let offlineAccounts: OfflineAccountsContext | undefined;
  const offlineAccountsLifecycle = new SerialQueue();
  let managerActor: LogActor | undefined;
  let authRequiredNotified = false;

  function notifyAuthRequired(): void {
    managerActor = undefined;
    if (authRequiredNotified) return;
    authRequiredNotified = true;
    deps.onAuthRequired?.();
  }

  async function withAuthBoundary<T>(operation: () => Promise<T>): Promise<T> {
    const client = deps.getApiClient();
    const token = client.sessionToken();
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof ServiceApiError
        && error.statusCode === 401
        && deps.getApiClient() === client
        && client.sessionToken() === token
      ) {
        client.logout();
        notifyAuthRequired();
      }
      throw error;
    }
  }

  async function logActivity(input: ActivityLogInput): Promise<void> {
    try {
      await deps.logStore.append(input);
    } catch (error) {
      console.error("Failed to write manager activity log", error);
    }
  }

  async function ensureOfflineAccounts(): Promise<OfflineAccountsContext | undefined> {
    if (deps.service.status().state !== "stopped") {
      closeOfflineAccountsNow();
      return undefined;
    }

    const config = await deps.configStore.load();
    const external = await probeExternalService(config);
    if (external) {
      closeOfflineAccountsNow();
      deps.setApiClient(external.apiClient);
      return undefined;
    }

    const recordsDir = path.join(config.dataDir, "records");
    const databasePath = path.join(recordsDir, "compet.sqlite3");
    if (offlineAccounts?.databasePath === databasePath) return offlineAccounts;
    closeOfflineAccountsNow();

    const database = await openCompetDatabase(recordsDir);
    try {
      const accounts = new AccountService(new AccountRepository(database));
      const sessions = new SessionService(new SessionRepository(database), config.tokenTtlMinutes);
      offlineAccounts = {
        database,
        databasePath,
        accounts,
        sessions,
        auth: new AuthService(accounts, sessions, new InMemoryLoginRateLimiter()),
        records: new MatchRecordStore(recordsDir, database),
      };
    } catch (error) {
      database.close();
      throw error;
    }
    return offlineAccounts;
  }

  async function withOfflineAccounts<T>(
    offlineOperation: (offline: OfflineAccountsContext) => Promise<T>,
    onlineOperation: () => Promise<T>,
  ): Promise<T> {
    return offlineAccountsLifecycle.enqueue(async () => {
      const offline = await ensureOfflineAccounts();
      return offline ? offlineOperation(offline) : onlineOperation();
    });
  }

  async function closeOfflineAccounts(): Promise<void> {
    await offlineAccountsLifecycle.enqueue(async () => {
      closeOfflineAccountsNow();
    });
  }

  async function stopService(): Promise<ServiceStatus> {
    return offlineAccountsLifecycle.enqueue(async () => {
      closeOfflineAccountsNow();
      return deps.service.stop();
    });
  }

  function closeOfflineAccountsNow(): void {
    const current = offlineAccounts;
    offlineAccounts = undefined;
    current?.database.close();
  }

  async function requireOfflineAdmin(offline: NonNullable<typeof offlineAccounts>): Promise<AccountRecord> {
    const token = deps.getApiClient().sessionToken();
    if (!token) throw new ServiceApiError("Manager login required", 401);
    const session = await offline.sessions.verifyToken(token);
    if (!session) throw new ServiceApiError("Manager login required", 401);
    const admin = await offline.accounts.getById(session.accountId);
    if (!admin || admin.role !== "admin" || !admin.enabled) throw new ServiceApiError("Manager login required", 401);
    return admin;
  }

  async function listAccounts(): Promise<AccountView[]> {
    return withOfflineAccounts(
      async (offline) => {
        await requireOfflineAdmin(offline);
        return (await offline.accounts.listAccounts()).map(toAccountView);
      },
      () => deps.getApiClient().accounts(),
    );
  }

  async function accountMatchHistory(id: string, page: number): Promise<AccountMatchHistory> {
    return withOfflineAccounts(
      async (offline) => {
        await requireOfflineAdmin(offline);
        const account = await offline.accounts.getById(id);
        if (!account || account.role !== "player") throw new Error("Account not found");
        const completedRecords = await offline.records.listPlayerCompletedMatches(account.steam64, { page, pageSize: MATCH_HISTORY_PAGE_SIZE });
        return {
          account: toAccountView(account),
          matches: completedRecords.matches
            .map((record) => toMatchHistoryEntry(record, account))
            .filter((record): record is NonNullable<typeof record> => Boolean(record)),
          page,
          pageSize: MATCH_HISTORY_PAGE_SIZE,
          total: completedRecords.total,
        };
      },
      () => deps.getApiClient().accountMatchHistory(id, page),
    );
  }

  async function accountMatchDetail(id: string, matchId: string): Promise<AccountMatchDetail> {
    return withOfflineAccounts(
      async (offline) => {
        await requireOfflineAdmin(offline);
        const account = await offline.accounts.getById(id);
        if (!account || account.role !== "player") throw new Error("Account not found");
        const match = await offline.records.readPlayerCompletedMatch(account.steam64, matchId);
        if (!match) throw new Error("Match not found");
        return { account: toAccountView(account), result: match.result };
      },
      () => deps.getApiClient().accountMatchDetail(id, matchId),
    );
  }

  async function createAccount(input: CreateAccountInput): Promise<AccountView> {
    return withOfflineAccounts(
      async (offline) => {
        const admin = await requireOfflineAdmin(offline);
        const account = toAccountView(await offline.accounts.createAccount({ ...input, role: "player", mustChangePassword: false }));
        await logActivity({ source: "account", level: "info", message: "Offline account created", actor: toLogActor(admin), context: { targetId: account.id, targetUsername: account.username } });
        return account;
      },
      () => deps.getApiClient().createAccount(input),
    );
  }

  async function updateAccount(id: string, input: UpdateAccountInput): Promise<AccountView> {
    return withOfflineAccounts(
      async (offline) => {
        const admin = await requireOfflineAdmin(offline);
        if (id === admin.id && input.enabled === false) throw new Error("Cannot disable current admin");
        const account = toAccountView(await offline.accounts.updateAccount(id, input));
        await logActivity({ source: "account", level: "info", message: "Offline account updated", actor: toLogActor(admin), context: { targetId: account.id, targetUsername: account.username } });
        return account;
      },
      () => deps.getApiClient().updateAccount(id, input),
    );
  }

  async function resetPassword(id: string, password: string): Promise<AccountView> {
    return withOfflineAccounts(
      async (offline) => {
        const admin = await requireOfflineAdmin(offline);
        const account = await offline.accounts.resetPassword(id, password);
        await offline.sessions.revokeSessionsForAccount(id);
        const view = toAccountView(account);
        await logActivity({ source: "account", level: "info", message: "Offline account password reset", actor: toLogActor(admin), context: { targetId: view.id, targetUsername: view.username } });
        return view;
      },
      () => deps.getApiClient().resetPassword(id, password),
    );
  }

  async function deleteAccount(id: string): Promise<void> {
    return withOfflineAccounts(
      async (offline) => {
        const admin = await requireOfflineAdmin(offline);
        if (id === admin.id) throw new Error("Cannot delete current admin");
        const target = await offline.accounts.getById(id);
        try {
          await offline.sessions.revokeSessionsForAccount(id);
        } catch {
          // Deleting the account makes any leftover sessions fail account lookup.
        }
        await offline.accounts.deleteAccount(id);
        await logActivity({ source: "account", level: "info", message: "Offline account deleted", actor: toLogActor(admin), context: { targetId: id, targetUsername: target?.username ?? "unknown" } });
      },
      () => deps.getApiClient().deleteAccount(id),
    );
  }

  ipcMain.handle("config:load", () => deps.configStore.load());
  ipcMain.handle("config:save", (_event, config) => offlineAccountsLifecycle.enqueue(async () => {
    closeOfflineAccountsNow();
    await deps.configStore.save(config);
    await logActivity({ source: "manager", level: "info", message: "Manager settings updated", actor: managerActor });
  }));
  ipcMain.handle("config:selectServerRoot", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select CSGO Dedicated Server directory",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("service:status", () => offlineAccountsLifecycle.enqueue(async () => {
    const current = deps.service.status();
    const status = await statusWithExternalProbe(deps);
    if (current.state === "stopped" && status.state === "running") closeOfflineAccountsNow();
    return status;
  }));
  ipcMain.handle("service:start", () => offlineAccountsLifecycle.enqueue(async () => {
    closeOfflineAccountsNow();
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
  }));
  ipcMain.handle("service:stop", () => stopService());
  ipcMain.handle("service:restart", () => offlineAccountsLifecycle.enqueue(async () => {
    closeOfflineAccountsNow();
    await deps.service.stop();
    const config = await deps.configStore.load();
    const status = await deps.service.start(config);
    const apiClient = new ServiceApiClient(status.baseUrl);
    deps.setApiClient(apiClient);
    return waitForServiceReady(deps.service, apiClient);
  }));
  ipcMain.handle("bootstrap:write", async (_event, input) => {
    const filePath = await writeBootstrapAdminFile((await deps.configStore.load()).dataDir, input);
    await logActivity({ source: "account", level: "info", message: "Bootstrap administrator file written", actor: managerActor, context: { filePath } });
    return filePath;
  });
  ipcMain.handle("auth:login", async (_event, username: string, password: string) => {
    try {
      return await withOfflineAccounts(
        async (offline) => {
          const result = await offline.auth.login(username, password, "offline", { requireAdmin: true });
          deps.getApiClient().setSessionToken(result.token);
          const account = toAccountView(result.account);
          managerActor = { accountId: account.id, username: account.username, role: account.role, ...(account.steam64 ? { steam64: account.steam64 } : {}) };
          await deps.saveSavedLogin({ username, password });
          authRequiredNotified = false;
          return { account };
        },
        async () => {
          const result = await deps.getApiClient().login(username, password);
          managerActor = { accountId: result.account.id, username: result.account.username, role: result.account.role, ...(result.account.steam64 ? { steam64: result.account.steam64 } : {}) };
          await deps.saveSavedLogin({ username, password });
          authRequiredNotified = false;
          return result;
        },
      );
    } catch (error) {
      await deps.clearSavedLogin();
      throw error;
    }
  });
  ipcMain.handle("auth:logout", async () => {
    try {
      await withOfflineAccounts(
        async (offline) => {
          const token = deps.getApiClient().sessionToken();
          if (!token) return;
          const session = await offline.sessions.verifyToken(token);
          if (session) await offline.sessions.revokeSession(session.sessionId);
        },
        async () => {},
      );
    } finally {
      deps.getApiClient().logout();
      managerActor = undefined;
      authRequiredNotified = false;
    }
  });
  ipcMain.handle("auth:changePassword", (_event, currentPassword: string, newPassword: string) => withAuthBoundary(async () => {
    await withOfflineAccounts(
      async (offline) => {
        const admin = await requireOfflineAdmin(offline);
        await offline.auth.changePassword(admin.id, currentPassword, newPassword);
      },
      () => deps.getApiClient().changePassword(currentPassword, newPassword),
    );
    const savedLogin = await deps.loadSavedLogin();
    if (savedLogin) {
      await deps.saveSavedLogin({ ...savedLogin, password: newPassword });
    }
  }));
  ipcMain.handle("credentials:load", () => deps.loadSavedLogin());
  ipcMain.handle("matchmaking:occupancy", () => withAuthBoundary(() => deps.getApiClient().matchmakingOccupancy()));
  ipcMain.handle("accounts:list", () => withAuthBoundary(listAccounts));
  ipcMain.handle("accounts:matches", (_event, id, page) => withAuthBoundary(() => accountMatchHistory(accountIdSchema.parse(id), matchHistoryPageSchema.parse(page))));
  ipcMain.handle("accounts:matchDetail", (_event, id, matchId) => withAuthBoundary(() => accountMatchDetail(accountIdSchema.parse(id), matchHistoryMatchIdSchema.parse(matchId))));
  ipcMain.handle("accounts:create", (_event, input) => withAuthBoundary(() => createAccount(createAccountSchema.parse(input))));
  ipcMain.handle("accounts:update", (_event, id, input) => withAuthBoundary(() => updateAccount(accountIdSchema.parse(id), patchAccountSchema.parse(input))));
  ipcMain.handle("accounts:resetPassword", (_event, id, password) => withAuthBoundary(() => {
    const input = passwordSchema.parse({ password });
    return resetPassword(accountIdSchema.parse(id), input.password);
  }));
  ipcMain.handle("accounts:delete", (_event, id) => withAuthBoundary(() => deleteAccount(accountIdSchema.parse(id))));
  ipcMain.handle("logs:recent", () => deps.logStore.recent());
  ipcMain.handle("updates:version", () => getCurrentVersion());
  ipcMain.handle("updates:check", () => checkForUpdates("compet-server-manager"));
  ipcMain.handle("updates:install", () => installUpdate("compet-server-manager", "Compet Server Manager.exe"));

  return { closeOfflineAccounts, stopService };
}

function toAccountView(account: AccountRecord): AccountView {
  const { passwordHash: _passwordHash, lastLoginAt, ...view } = account;
  return { ...view, lastLoginAt: lastLoginAt ?? undefined };
}

function toLogActor(account: AccountRecord): LogActor {
  return { accountId: account.id, username: account.username, role: account.role, ...(account.steam64 ? { steam64: account.steam64 } : {}) };
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
    await apiClient.health();
    return {
      apiClient,
      status: {
        state: "running",
        baseUrl: baseUrl(config),
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
  apiClient: Pick<ServiceApiClient, "health">,
  timeoutMs = STARTUP_TIMEOUT_MS,
  intervalMs = STARTUP_POLL_INTERVAL_MS,
): Promise<ReturnType<ManagedServiceProcess["status"]>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = service.status();
    if (status.state === "failed" || status.state === "stopped") return status;

    try {
      await apiClient.health();
      return status;
    } catch {
      await delay(intervalMs);
    }
  }

  return service.status();
}
