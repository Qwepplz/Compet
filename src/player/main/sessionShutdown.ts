import type { PlayerApiClient } from "./playerApiClient.js";

export interface PlayerSessionShutdownDeps {
  getApiClient: () => PlayerApiClient | undefined;
  setApiClient: (client: PlayerApiClient | undefined) => void;
  disconnectRealtime: () => void;
  clearSession: () => Promise<void>;
}

export async function revokePlayerSessionForExit(deps: PlayerSessionShutdownDeps): Promise<void> {
  const client = deps.getApiClient();
  deps.disconnectRealtime();
  deps.setApiClient(undefined);
  try {
    await client?.logout();
  } catch {
    // The process is exiting; local cleanup below is more important than surfacing a late network error.
  } finally {
    await deps.clearSession().catch(() => undefined);
  }
}
