type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function getStorage(): PreferenceStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function loadBoolean(key: string, fallback: boolean): boolean {
  const storage = getStorage();
  if (!storage) return fallback;
  try {
    const value = storage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function saveBoolean(key: string, value: boolean): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(key, value ? "true" : "false");
  } catch {
    // 本地偏好持久化尽力而为，不能阻塞 player UI。
  }
}

const DEV_MODE_KEY = "compet.player.devModeEnabled";
const MATCH_SOUND_KEY = "compet.player.matchSoundEnabled";

export const loadDevModeEnabled = (): boolean => loadBoolean(DEV_MODE_KEY, false);
export const saveDevModeEnabled = (enabled: boolean): void => saveBoolean(DEV_MODE_KEY, enabled);
export const loadMatchSoundEnabled = (): boolean => loadBoolean(MATCH_SOUND_KEY, true);
export const saveMatchSoundEnabled = (enabled: boolean): void => saveBoolean(MATCH_SOUND_KEY, enabled);
