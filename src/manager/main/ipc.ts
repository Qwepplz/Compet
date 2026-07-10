import { dialog, ipcMain } from "electron";
import path from "node:path";
import type { FileConfigStore } from "./configStore.js";
import type { FileLogStore } from "./logStore.js";
import type { ManagedServiceProcess } from "./serviceProcess.js";
import type { AccountView, CreateAccountInput, ManagerConfig, SavedLoginCredentials, ServiceStatus, UpdateAccountInput } from "../shared/types.js";
import { ServiceApiClient } from "./serviceApiClient.js";
import { writeBootstrapAdminFile } from "./bootstrapFile.js";
import { runLocalDiagnostics } from "./diagnostics.js";
import { delay } from "../../shared/async.js";
import { checkForUpdates, getCurrentVersion, installUpdate } from "../../desktop/main/updateCheck.js";
import { AccountService } from "../../accounts/accountService.js";
import { accountIdSchema, createAccountSchema, patchAccountSchema, passwordSchema } from "../../accounts/accountInputSchemas.js";
import { JsonAccountRepository } from "../../accounts/accountRepository.js";
import type { AccountRecord } from "../../accounts/accountTypes.js";
import { JsonSessionRepository } from "../../auth/sessionRepository.js";
import { SessionService } from "../../auth/sessionService.js";

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
  let offlineAccounts: { filePath: string; accounts: AccountService; sessions: SessionService } | undefined;

  async function getOfflineAccounts(): Promise<typeof offlineAccounts> {
    if (deps.service.status().state !== "stopped") return undefined;

    const config = await deps.configStore.load();
    const external = await probeExternalService(config);
    if (external) {
      deps.setApiClient(external.apiClient);
      return undefined;
    }

    const filePath = path.join(config.dataDir, "records", "accounts.json");
    if (offlineAccounts?.filePath === filePath) return offlineAccounts;

    offlineAccounts = {
      filePath,
      accounts: new AccountService(await JsonAccountRepository.create(filePath)),
      sessions: new SessionService(
        await JsonSessionRepository.create(path.join(config.dataDir, "records", "sessions.json")),
        config.tokenTtlMinutes,
      ),
    };
    return offlineAccounts;
  }

  async function requireOfflineAdmin(offline: NonNullable<typeof offlineAccounts>): Promise<string> {
    const token = deps.getApiClient().sessionToken();
    if (!token) throw new Error("Manager login required");
    const session = await offline.sessions.verifyToken(token);
    if (!session) throw new Error("Manager login required");
    const admin = await offline.accounts.getById(session.accountId);
    if (!admin || admin.role !== "admin" || !admin.enabled) throw new Error("Manager login required");
    return admin.id;
  }

  async function listAccounts(): Promise<AccountView[]> {
    const offline = await getOfflineAccounts();
    if (!offline) return deps.getApiClient().accounts();
    await requireOfflineAdmin(offline);
    return (await offline.accounts.listAccounts()).map(toAccountView);
  }

  async function createAccount(input: CreateAccountInput): Promise<AccountView> {
    const offline = await getOfflineAccounts();
    if (!offline) return deps.getApiClient().createAccount(input);
    await requireOfflineAdmin(offline);
    return toAccountView(await offline.accounts.createAccount({ ...input, role: "player", mustChangePassword: false }));
  }

  async function updateAccount(id: string, input: UpdateAccountInput): Promise<AccountView> {
    const offline = await getOfflineAccounts();
    if (!offline) return deps.getApiClient().updateAccount(id, input);
    const adminId = await requireOfflineAdmin(offline);
    if (id === adminId && input.enabled === false) throw new Error("Cannot disable current admin");
    return toAccountView(await offline.accounts.updateAccount(id, input));
  }

  async function resetPassword(id: string, password: string): Promise<AccountView> {
    const offline = await getOfflineAccounts();
    if (!offline) return deps.getApiClient().resetPassword(id, password);
    await requireOfflineAdmin(offline);
    const account = await offline.accounts.resetPassword(id, password);
    await offline.sessions.revokeSessionsForAccount(id);
    return toAccountView(account);
  }

  async function deleteAccount(id: string): Promise<void> {
    const offline = await getOfflineAccounts();
    if (!offline) return deps.getApiClient().deleteAccount(id);
    const adminId = await requireOfflineAdmin(offline);
    if (id === adminId) throw new Error("Cannot delete current admin");
    try {
      await offline.sessions.revokeSessionsForAccount(id);
    } catch {
      // Deleting the account makes any leftover sessions fail account lookup.
    }
    await offline.accounts.deleteAccount(id);
  }

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
  ipcMain.handle("matchmaking:occupancy", () => deps.getApiClient().matchmakingOccupancy());
  ipcMain.handle("accounts:list", () => listAccounts());
  ipcMain.handle("accounts:create", (_event, input) => createAccount(createAccountSchema.parse(input)));
  ipcMain.handle("accounts:update", (_event, id, input) => updateAccount(accountIdSchema.parse(id), patchAccountSchema.parse(input)));
  ipcMain.handle("accounts:resetPassword", (_event, id, password) => {
    const input = passwordSchema.parse({ password });
    return resetPassword(accountIdSchema.parse(id), input.password);
  });
  ipcMain.handle("accounts:delete", (_event, id) => deleteAccount(accountIdSchema.parse(id)));
  ipcMain.handle("logs:recent", () => deps.logStore.recent());
  ipcMain.handle("logs:listFiles", () => deps.logStore.listFiles());
  ipcMain.handle("logs:readFile", (_event, name: string) => deps.logStore.readFile(name));
  ipcMain.handle("updates:version", () => getCurrentVersion());
  ipcMain.handle("updates:check", () => checkForUpdates("compet-server-manager"));
  ipcMain.handle("updates:install", () => installUpdate("compet-server-manager", "Compet Server Manager.exe"));
}

function toAccountView(account: AccountRecord): AccountView {
  const { passwordHash: _passwordHash, lastLoginAt, ...view } = account;
  return { ...view, lastLoginAt: lastLoginAt ?? undefined };
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
