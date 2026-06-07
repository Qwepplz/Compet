export const DEV_MODE_ENABLED_STORAGE_KEY = "compet.player.devModeEnabled";

type DevModePreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function getDefaultStorage(): DevModePreferenceStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadDevModeEnabled(storage: DevModePreferenceStorage | undefined = getDefaultStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(DEV_MODE_ENABLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveDevModeEnabled(
  enabled: boolean,
  storage: DevModePreferenceStorage | undefined = getDefaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(DEV_MODE_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Local preference persistence is best-effort and must not block the player UI.
  }
}
