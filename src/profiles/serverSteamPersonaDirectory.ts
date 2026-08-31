import { readJsonFile, writeJsonFileAtomic } from "../storage/jsonFile.js";
import {
  normalizeSteam64,
  parseHumanProfileIndex,
  serializeHumanProfileIndex,
} from "./humanProfileIndex.js";

const DEFAULT_REFRESH_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RELOAD_RETRY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

export interface ServerSteamPersonaDirectoryOptions {
  baseUrl: string;
  seedPath: string;
  cachePath: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  refreshTtlMs?: number;
  reloadRetryMs?: number;
  fetchTimeoutMs?: number;
  onLog?: (message: string) => void;
}

export class ServerSteamPersonaDirectory {
  private readonly baseUrl: string;
  private readonly seedPath: string;
  private readonly cachePath: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly refreshTtlMs: number;
  private readonly reloadRetryMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly onLog?: (message: string) => void;
  private personas = new Map<string, string>();
  private loadedAt?: number;
  private lastFailedAt?: number;
  private inFlight?: Promise<void>;

  constructor(options: ServerSteamPersonaDirectoryOptions) {
    this.baseUrl = options.baseUrl;
    this.seedPath = options.seedPath;
    this.cachePath = options.cachePath;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshTtlMs = options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
    this.reloadRetryMs = options.reloadRetryMs ?? DEFAULT_RELOAD_RETRY_MS;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    this.onLog = options.onLog;
  }

  static async create(options: ServerSteamPersonaDirectoryOptions): Promise<ServerSteamPersonaDirectory> {
    const directory = new ServerSteamPersonaDirectory(options);
    await directory.loadLocal();
    directory.startRefreshIfNeeded();
    return directory;
  }

  displayName(steam64: string): string {
    const normalized = steam64.trim();
    if (!normalizeSteam64(normalized)) return normalized;
    this.startRefreshIfNeeded();
    return this.personas.get(normalized) ?? normalized;
  }

  private async loadLocal(): Promise<void> {
    const seed = await this.readLocalIndex(this.seedPath, "profile seed");
    const cache = await this.readLocalIndex(this.cachePath, "profile cache");
    const merged = new Map(seed ?? []);
    for (const [steam64, personaName] of cache ?? []) merged.set(steam64, personaName);
    this.personas = merged;
  }

  private async readLocalIndex(filePath: string, label: string): Promise<Map<string, string> | undefined> {
    try {
      return parseHumanProfileIndex(await readJsonFile<unknown>(filePath));
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      this.onLog?.(`${label} ignored because it is invalid`);
      return undefined;
    }
  }

  private startRefreshIfNeeded(): void {
    if (this.inFlight) return;
    const now = this.now();
    if (this.loadedAt !== undefined && now - this.loadedAt < this.refreshTtlMs) return;
    if (this.lastFailedAt !== undefined && now - this.lastFailedAt < this.reloadRetryMs) return;

    this.inFlight = this.reload().finally(() => {
      this.inFlight = undefined;
    });
  }

  private async reload(): Promise<void> {
    try {
      const personas = await this.fetchIndex();
      await writeJsonFileAtomic(this.cachePath, serializeHumanProfileIndex(personas), { pretty: false });
      this.personas = personas;
      this.loadedAt = this.now();
      this.lastFailedAt = undefined;
      this.onLog?.(`profile index refreshed with ${personas.size} entries`);
    } catch (error) {
      this.lastFailedAt = this.now();
      const message = error instanceof Error ? error.message : "";
      const safeMessage = /timed out|returned status \d+|contains no valid entries/u.test(message)
        ? message
        : "profile index refresh failed";
      this.onLog?.(safeMessage);
    }
  }

  private async fetchIndex(): Promise<Map<string, string>> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("profile index request timed out"));
      }, this.fetchTimeoutMs);
      timeout.unref?.();
    });

    try {
      const response = await Promise.race([
        this.fetchFn(joinUrl(this.baseUrl, "human-index.json"), { signal: controller.signal }),
        timeoutPromise,
      ]);
      if (!response.ok) throw new Error(`profile index request returned status ${response.status}`);
      const payload = await Promise.race([response.json(), timeoutPromise]);
      return parseHumanProfileIndex(payload);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

function joinUrl(baseUrl: string, relative: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${relative.replace(/^\/+/, "")}`;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("JSON file does not exist:");
}
