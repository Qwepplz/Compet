import { isSessionInvalidError, type PlayerApiClient } from "./playerApiClient.js";

export interface AuthRetrySession {
  baseUrl?: string;
  token?: string;
  username?: string;
  password?: string;
}

export interface AuthRetryDeps {
  clearSession: () => Promise<void>;
  connectRealtime: (baseUrl: string, token: string) => void;
  createPlayerApiClient: (baseUrl: string, token?: string) => PlayerApiClient;
  disconnectRealtime: () => void;
  getApiClient: () => PlayerApiClient;
  loadSession: () => Promise<AuthRetrySession | null>;
  saveSession: (session: AuthRetrySession & { baseUrl: string }) => Promise<void>;
  setApiClient: (client: PlayerApiClient | undefined) => void;
}

export async function withAuthRetry<T>(deps: AuthRetryDeps, operation: (client: PlayerApiClient) => Promise<T>): Promise<T> {
  try {
    return await operation(deps.getApiClient());
  } catch (error) {
    if (!isSessionInvalidError(error)) throw error;
    const refreshed = await reauthenticate(deps);
    if (!refreshed) throw error;
    return operation(deps.getApiClient());
  }
}

async function reauthenticate(deps: AuthRetryDeps): Promise<boolean> {
  let currentClient: PlayerApiClient | undefined;
  try {
    currentClient = deps.getApiClient();
  } catch {
    currentClient = undefined;
  }

  const persisted = await deps.loadSession();
  const currentCredentials = currentClient?.getLoginCredentials();
  const baseUrl = currentClient?.getBaseUrl() || persisted?.baseUrl?.trim();
  const username = currentCredentials?.username.trim() || persisted?.username?.trim();
  const password = currentCredentials?.password || persisted?.password;
  if (!baseUrl || !username || !password) {
    deps.disconnectRealtime();
    deps.setApiClient(undefined);
    await deps.clearSession();
    return false;
  }

  const client = deps.createPlayerApiClient(baseUrl);
  try {
    const result = await client.login(username, password);
    deps.setApiClient(client);
    await deps.saveSession({ baseUrl, token: result.token, username, password });
    deps.connectRealtime(baseUrl, result.token);
    return true;
  } catch (error) {
    deps.disconnectRealtime();
    deps.setApiClient(undefined);
    await deps.clearSession();
    if (isSessionInvalidError(error)) return false;
    throw error;
  }
}
