import { isSessionInvalidError, type PlayerApiClient } from "./playerApiClient.js";

export interface PlayerSessionShutdownDeps {
  loadSession: () => Promise<{ baseUrl: string; token?: string } | null>;
  createApiClient: (baseUrl: string, token: string) => PlayerApiClient;
  getApiClient: () => PlayerApiClient | undefined;
  setApiClient: (client: PlayerApiClient | undefined) => void;
  disconnectRealtime: () => void;
  clearSession: () => Promise<void>;
}

export async function revokePlayerSession(deps: PlayerSessionShutdownDeps): Promise<void> {
  const client = deps.getApiClient();
  const currentToken = client?.getToken();
  const currentBaseUrl = client?.getBaseUrl();
  deps.disconnectRealtime();
  deps.setApiClient(undefined);

  const errors: unknown[] = [];
  let saved: Awaited<ReturnType<PlayerSessionShutdownDeps["loadSession"]>> = null;
  try { saved = await deps.loadSession(); }
  catch (error) { errors.push(error); }

  if (client && currentToken) {
    try { await client.logout(); }
    catch (error) { if (!isSessionInvalidError(error)) errors.push(error); }
  }
  if (saved?.token && (saved.token !== currentToken || saved.baseUrl !== currentBaseUrl)) {
    try { await deps.createApiClient(saved.baseUrl, saved.token).logout(); }
    catch (error) { if (!isSessionInvalidError(error)) errors.push(error); }
  }
  // Preserve recovery credentials when remote revocation could not be confirmed.
  if (errors.length > 0) throw errors[0];
  await deps.clearSession();
}
