export interface SteamProfile {
  steam64: string;
  personaName: string;
  avatarUrl: string;
}

export interface SteamProfileResolver {
  resolveMany(steam64s: string[]): Promise<Map<string, SteamProfile>>;
}

interface SteamProfileServiceOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  steamWebApiKey?: string;
  cacheMaxEntries?: number;
  cacheTtlMs?: number;
  negativeCacheTtlMs?: number;
}

interface SteamProfileCacheEntry {
  profile: SteamProfile | null;
  expiresAt: number;
  lastUsedAt: number;
}

const DEFAULT_CACHE_MAX_ENTRIES = 500;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;

const STEAM64_PATTERN = /^\d{17}$/;
const DEFAULT_TIMEOUT_MS = 5_000;

interface SteamPlayerSummary {
  steamid: string;
  personaname?: string;
  avatar?: string;
  avatarmedium?: string;
  avatarfull?: string;
}

interface SteamPlayerSummaryResponse {
  response?: {
    players?: SteamPlayerSummary[];
  };
}

export class SteamProfileService implements SteamProfileResolver {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly steamWebApiKey: string;
  private readonly cacheMaxEntries: number;
  private readonly cacheTtlMs: number;
  private readonly negativeCacheTtlMs: number;
  private readonly cache = new Map<string, SteamProfileCacheEntry>();
  private cacheUseClock = 0;

  constructor(options: SteamProfileServiceOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.steamWebApiKey = options.steamWebApiKey ?? process.env.COMPET_STEAM_WEB_API_KEY ?? process.env.STEAM_WEB_API_KEY ?? process.env.STEAM_API_KEY ?? "";
    this.cacheMaxEntries = options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.negativeCacheTtlMs = options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS;
  }

  async resolveMany(steam64s: string[]): Promise<Map<string, SteamProfile>> {
    const uniqueSteam64s = [...new Set(steam64s.map((steam64) => steam64.trim()).filter((steam64) => STEAM64_PATTERN.test(steam64)))];
    const profiles = new Map<string, SteamProfile>();
    const missing: string[] = [];

    for (const steam64 of uniqueSteam64s) {
      const cached = this.getCachedProfile(steam64);
      if (cached.hit) {
        if (cached.profile) profiles.set(steam64, cached.profile);
      } else {
        missing.push(steam64);
      }
    }

    if (missing.length > 0 && this.steamWebApiKey) {
      const apiProfiles = await this.resolveManyFromWebApi(missing);
      for (const [steam64, profile] of apiProfiles) {
        this.setCachedProfile(steam64, profile);
        profiles.set(steam64, profile);
      }
    }

    const unresolved = missing.filter((steam64) => !profiles.has(steam64));
    const entries = await Promise.all(unresolved.map(async (steam64) => [steam64, await this.resolveOne(steam64)] as const));
    for (const [steam64, profile] of entries) {
      if (profile) profiles.set(steam64, profile);
    }
    return profiles;
  }

  private async resolveManyFromWebApi(steam64s: string[]): Promise<Map<string, SteamProfile>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
      url.searchParams.set("key", this.steamWebApiKey);
      url.searchParams.set("steamids", steam64s.join(","));
      const response = await this.fetchFn(url.toString(), { signal: controller.signal });
      if (!response.ok) {
        return new Map();
      }
      const data = await response.json() as SteamPlayerSummaryResponse;
      const profiles = new Map<string, SteamProfile>();
      for (const player of data.response?.players ?? []) {
        const profile = steamSummaryToProfile(player);
        if (profile) {
          profiles.set(profile.steam64, profile);
        }
      }
      return profiles;
    } catch {
      return new Map();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveOne(steam64: string): Promise<SteamProfile | undefined> {
    const cached = this.getCachedProfile(steam64);
    if (cached.hit) {
      return cached.profile ?? undefined;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`https://steamcommunity.com/profiles/${steam64}/?xml=1`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        this.setCachedProfile(steam64, null);
        return undefined;
      }

      const xml = await response.text();
      const personaName = readXmlText(xml, "steamID");
      const avatarUrl = readXmlText(xml, "avatarFull") || readXmlText(xml, "avatarMedium") || readXmlText(xml, "avatarIcon");
      if (!personaName && !avatarUrl) {
        this.setCachedProfile(steam64, null);
        return undefined;
      }

      const profile: SteamProfile = {
        steam64,
        personaName: personaName || steam64,
        avatarUrl,
      };
      this.setCachedProfile(steam64, profile);
      return profile;
    } catch {
      this.setCachedProfile(steam64, null);
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private getCachedProfile(steam64: string): { hit: true; profile: SteamProfile | null } | { hit: false } {
    const entry = this.cache.get(steam64);
    const now = Date.now();
    if (!entry) {
      return { hit: false };
    }
    if (entry.expiresAt <= now) {
      this.cache.delete(steam64);
      return { hit: false };
    }
    entry.lastUsedAt = this.nextCacheUseStamp();
    return { hit: true, profile: entry.profile };
  }

  private setCachedProfile(steam64: string, profile: SteamProfile | null): void {
    if (this.cacheMaxEntries <= 0) {
      this.cache.clear();
      return;
    }

    const now = Date.now();
    this.cache.set(steam64, {
      profile,
      expiresAt: now + (profile ? this.cacheTtlMs : this.negativeCacheTtlMs),
      lastUsedAt: this.nextCacheUseStamp(),
    });
    this.evictLeastRecentlyUsed();
  }

  private nextCacheUseStamp(): number {
    this.cacheUseClock += 1;
    return this.cacheUseClock;
  }

  private evictLeastRecentlyUsed(): void {
    while (this.cache.size > this.cacheMaxEntries) {
      let oldestSteam64: string | undefined;
      let oldestLastUsedAt = Number.POSITIVE_INFINITY;
      for (const [steam64, entry] of this.cache) {
        if (entry.lastUsedAt < oldestLastUsedAt) {
          oldestSteam64 = steam64;
          oldestLastUsedAt = entry.lastUsedAt;
        }
      }
      if (!oldestSteam64) return;
      this.cache.delete(oldestSteam64);
    }
  }
}

function steamSummaryToProfile(player: SteamPlayerSummary): SteamProfile | undefined {
  if (!STEAM64_PATTERN.test(player.steamid)) {
    return undefined;
  }
  const personaName = player.personaname?.trim() || player.steamid;
  const avatarUrl = player.avatarfull || player.avatarmedium || player.avatar || "";
  if (!personaName && !avatarUrl) {
    return undefined;
  }
  return {
    steam64: player.steamid,
    personaName,
    avatarUrl,
  };
}

function readXmlText(xml: string, tagName: string): string {
  const match = new RegExp(`<${tagName}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tagName}>`, "i").exec(xml);
  return decodeXmlEntities((match?.[1] ?? match?.[2] ?? "").trim());
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}
