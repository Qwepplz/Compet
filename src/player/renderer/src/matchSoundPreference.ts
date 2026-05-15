export const MATCH_SOUND_ENABLED_STORAGE_KEY = "compet.player.matchSoundEnabled";

type MatchSoundPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function getDefaultStorage(): MatchSoundPreferenceStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadMatchSoundEnabled(storage: MatchSoundPreferenceStorage | undefined = getDefaultStorage()): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(MATCH_SOUND_ENABLED_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveMatchSoundEnabled(
  enabled: boolean,
  storage: MatchSoundPreferenceStorage | undefined = getDefaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(MATCH_SOUND_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Local preference persistence is best-effort and must not block the player UI.
  }
}
