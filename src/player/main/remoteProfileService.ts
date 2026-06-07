// Resolves player names/avatars from the Tencent COS indexes instead of Steam.
// Both bot and human entries are merged into one lookup table loaded once and
// refreshed on a TTL. Misses return nothing; callers fall back to steam64 text
// and a local placeholder avatar.

export interface PlayerProfile {
  steam64: string;
  personaName: string;
  avatarUrl: string;
}

const DEFAULT_REFRESH_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RELOAD_RETRY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const STEAM64_PATTERN = /^\d{17}$/;

interface RemoteIndexEntry {
  personaName: string;
  avatarPath: string;
}

interface ProfileEntry {
  personaName: string;
  avatarRemoteUrl: string;
}

interface RemoteProfileServiceOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  refreshTtlMs?: number;
  onLog?: (message: string) => void;
  onProfilesUpdated?: () => void;
}

function joinUrl(baseUrl: string, relative: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
}

export class RemoteProfileService {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly refreshTtlMs: number;
  private readonly onLog?: (message: string) => void;
  private readonly onProfilesUpdated?: () => void;
  private readonly indexFiles = ["bot-index.json", "human-index.json"];
  private profiles = new Map<string, ProfileEntry>();
  private readonly avatarCache = new Map<string, string>();
  private readonly avatarInFlight = new Map<string, Promise<void>>();
  private loadedAt = 0;
  private lastLoadAttemptAt = 0;
  private inFlight?: Promise<void>;

  constructor(options: RemoteProfileServiceOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchFn = options.fetchFn ?? fetch;
    this.refreshTtlMs = options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
    this.onLog = options.onLog;
    this.onProfilesUpdated = options.onProfilesUpdated;
  }

  warmUp(): void {
    this.startLoadIfNeeded();
  }

  async resolveMany(steam64s: string[]): Promise<Map<string, PlayerProfile>> {
    this.startLoadIfNeeded();
    const result = new Map<string, PlayerProfile>();
    for (const raw of steam64s) {
      const steam64 = raw.trim();
      if (!STEAM64_PATTERN.test(steam64)) continue;
      const entry = this.profiles.get(steam64);
      if (!entry) continue;

      const avatarUrl = this.avatarCache.get(steam64);
      if (avatarUrl === undefined) {
        this.fetchAvatarInBackground(steam64, entry.avatarRemoteUrl);
      }
      result.set(steam64, { steam64, personaName: entry.personaName, avatarUrl: avatarUrl ?? "" });
    }

    return result;
  }

  private fetchAvatarInBackground(steam64: string, remoteUrl: string): void {
    if (this.avatarInFlight.has(steam64)) return;
    const request = this.resolveAvatarDataUri(steam64, remoteUrl)
      .then(() => undefined)
      .finally(() => {
        this.avatarInFlight.delete(steam64);
      });
    this.avatarInFlight.set(steam64, request);
  }

  private async resolveAvatarDataUri(steam64: string, remoteUrl: string): Promise<string | undefined> {
    const cached = this.avatarCache.get(steam64);
    if (cached !== undefined) return cached;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await this.fetchFn(remoteUrl, { signal: controller.signal });
        if (!response.ok) {
          this.onLog?.(`avatar ${steam64} status ${response.status}`);
          return undefined;
        }
        const contentType = response.headers.get("content-type") || "image/jpeg";
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) return undefined;
        const dataUri = `data:${contentType};base64,${buffer.toString("base64")}`;
        this.avatarCache.set(steam64, dataUri);
        this.onProfilesUpdated?.();
        return dataUri;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      this.onLog?.(`avatar ${steam64} fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private startLoadIfNeeded(): void {
    const now = Date.now();
    const fresh = this.profiles.size > 0 && now - this.loadedAt < this.refreshTtlMs;
    if (fresh) return;
    if (this.inFlight) return;
    if (this.lastLoadAttemptAt > 0 && now - this.lastLoadAttemptAt < DEFAULT_RELOAD_RETRY_MS) return;

    this.lastLoadAttemptAt = now;
    this.inFlight = this.reload().finally(() => {
      this.inFlight = undefined;
    });
  }

  private async reload(): Promise<void> {
    try {
      const merged = new Map<string, ProfileEntry>();
      const indexes = await Promise.all(this.indexFiles.map((file) => this.fetchIndex(file)));
      for (const index of indexes) {
        for (const [steam64, entry] of Object.entries(index)) {
          if (!STEAM64_PATTERN.test(steam64)) continue;
          merged.set(steam64, {
            personaName: entry.personaName,
            avatarRemoteUrl: joinUrl(this.baseUrl, entry.avatarPath),
          });
        }
      }
      if (merged.size > 0) {
        this.profiles = merged;
        this.loadedAt = Date.now();
        this.onLog?.(`remote profiles loaded: ${merged.size} entries from ${this.baseUrl}`);
        this.onProfilesUpdated?.();
      } else {
        this.onLog?.(`remote profiles load returned 0 entries from ${this.baseUrl}`);
      }
    } catch (error) {
      this.onLog?.(`remote profiles load failed: ${error instanceof Error ? error.message : String(error)}`);
      // Keep whatever we already have; misses fall back to placeholder.
    }
  }

  private async fetchIndex(file: string): Promise<Record<string, RemoteIndexEntry>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchFn(joinUrl(this.baseUrl, file), { signal: controller.signal });
      if (!response.ok) {
        this.onLog?.(`fetch ${file} returned status ${response.status}`);
        return {};
      }
      return (await response.json()) as Record<string, RemoteIndexEntry>;
    } catch (error) {
      this.onLog?.(`fetch ${file} threw: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    } finally {
      clearTimeout(timeout);
    }
  }
}
