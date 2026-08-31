export const DEFAULT_PROFILE_BASE_URL = "https://qwepplz111.site/cos-upload/";
export const STEAM64_PATTERN = /^\d{17}$/u;

export interface HumanProfileIndexEntry {
  personaName: string;
  avatarPath?: string;
}

export type HumanProfileIndex = Record<string, HumanProfileIndexEntry>;

export function normalizeSteam64(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const steam64 = value.trim();
  return STEAM64_PATTERN.test(steam64) ? steam64 : undefined;
}

export function normalizePersonaName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const personaName = value.trim();
  return personaName || undefined;
}

export function parseHumanProfileIndexEntries(value: unknown): Map<string, HumanProfileIndexEntry> {
  if (!isRecord(value)) throw new Error("human profile index must be an object");

  const entries = new Map<string, HumanProfileIndexEntry>();
  for (const [rawSteam64, rawEntry] of Object.entries(value)) {
    const steam64 = normalizeSteam64(rawSteam64);
    if (!steam64 || !isRecord(rawEntry)) continue;
    const personaName = normalizePersonaName(rawEntry.personaName);
    if (!personaName) continue;

    const avatarPath = typeof rawEntry.avatarPath === "string" ? rawEntry.avatarPath.trim() : undefined;
    entries.set(steam64, {
      personaName,
      ...(avatarPath ? { avatarPath } : {}),
    });
  }

  if (entries.size === 0) throw new Error("human profile index contains no valid entries");
  return entries;
}

export function parseHumanProfileIndex(value: unknown): Map<string, string> {
  return new Map(
    [...parseHumanProfileIndexEntries(value)].map(([steam64, entry]) => [steam64, entry.personaName]),
  );
}

export function serializeHumanProfileIndex(personas: ReadonlyMap<string, string>): HumanProfileIndex {
  const entries = [...personas.entries()]
    .map(([rawSteam64, rawPersonaName]) => ({
      steam64: normalizeSteam64(rawSteam64),
      personaName: normalizePersonaName(rawPersonaName),
    }))
    .filter((entry): entry is { steam64: string; personaName: string } => (
      entry.steam64 !== undefined && entry.personaName !== undefined
    ))
    .sort((left, right) => left.steam64.localeCompare(right.steam64));

  if (entries.length === 0) throw new Error("human profile index contains no valid entries");

  const serialized: HumanProfileIndex = {};
  for (const entry of entries) {
    serialized[entry.steam64] = {
      personaName: entry.personaName,
      avatarPath: `avatars/${entry.steam64}.jpg`,
    };
  }
  return serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
