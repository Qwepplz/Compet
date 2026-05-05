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
}

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
  private readonly cache = new Map<string, SteamProfile | null>();

  constructor(options: SteamProfileServiceOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.steamWebApiKey = options.steamWebApiKey ?? process.env.COMPET_STEAM_WEB_API_KEY ?? process.env.STEAM_WEB_API_KEY ?? process.env.STEAM_API_KEY ?? "";
  }

  async resolveMany(steam64s: string[]): Promise<Map<string, SteamProfile>> {
    const uniqueSteam64s = [...new Set(steam64s.map((steam64) => steam64.trim()).filter((steam64) => STEAM64_PATTERN.test(steam64)))];
    const profiles = new Map<string, SteamProfile>();
    const missing: string[] = [];

    for (const steam64 of uniqueSteam64s) {
      if (this.cache.has(steam64)) {
        const cached = this.cache.get(steam64);
        if (cached) profiles.set(steam64, cached);
      } else {
        missing.push(steam64);
      }
    }

    if (missing.length > 0 && this.steamWebApiKey) {
      const apiProfiles = await this.resolveManyFromWebApi(missing);
      for (const [steam64, profile] of apiProfiles) {
        this.cache.set(steam64, profile);
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
    if (this.cache.has(steam64)) {
      return this.cache.get(steam64) ?? undefined;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`https://steamcommunity.com/profiles/${steam64}/?xml=1`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        return undefined;
      }

      const xml = await response.text();
      const personaName = readXmlText(xml, "steamID");
      const avatarUrl = readXmlText(xml, "avatarFull") || readXmlText(xml, "avatarMedium") || readXmlText(xml, "avatarIcon");
      if (!personaName && !avatarUrl) {
        return undefined;
      }

      const profile: SteamProfile = {
        steam64,
        personaName: personaName || steam64,
        avatarUrl,
      };
      this.cache.set(steam64, profile);
      return profile;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
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
