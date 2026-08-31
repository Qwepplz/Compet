// Produces the Tencent COS upload bundle: two indexes (bot + human) plus all
// avatar jpgs. Indexes store RELATIVE avatar paths; the client prepends a base
// URL constant at runtime. Steam is used HERE at build time only (bot summaries,
// vanity resolve, avatar downloads); the runtime client never calls Steam.
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonFileAtomic } from "../src/storage/jsonFile.js";
import { parseHumanProfileIndex, type HumanProfileIndexEntry } from "../src/profiles/humanProfileIndex.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const STEAM_FETCH_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Compet/0.1",
};

const botInfoPath = process.env.COMPET_BOT_INFO_PATH
  ?? "E:/EXCHANGE/Git/BetterBots/addons/sourcemod/data/bot_info.json";
const outDir = path.join(REPO_ROOT, "artifacts/cos-upload");
const avatarsDir = path.join(outDir, "avatars");
const profileSeedPath = path.join(REPO_ROOT, "packaging/server/profile-seed/human-index.json");
const STEAM64_ACCOUNT_ID_OFFSET = 76561197960265728n;
const SUMMARIES_BATCH = 100;
const apiKey = process.env.COMPET_STEAM_WEB_API_KEY
  ?? process.env.STEAM_WEB_API_KEY
  ?? process.env.STEAM_API_KEY
  ?? "";

// The 4 real humans. vanity entries get resolved to steam64 once via Steam.
const HUMAN_INPUTS: Array<{ kind: "steam64"; value: string } | { kind: "vanity"; value: string }> = [
  { kind: "vanity", value: "SaUu--" },
  { kind: "steam64", value: "76561199699781598" },
  { kind: "vanity", value: "-RaeliL-" },
  { kind: "steam64", value: "76561199195939058" },
];

type IndexEntry = HumanProfileIndexEntry & { avatarPath: string };

interface SteamPlayerSummary {
  steamid: string;
  personaname?: string;
  avatar?: string;
  avatarmedium?: string;
  avatarfull?: string;
}

function avatarRelPath(steam64: string): string {
  return `avatars/${steam64}.jpg`;
}

function accountIdToSteam64(accountId: number): string | undefined {
  if (!Number.isSafeInteger(accountId) || accountId < 0) return undefined;
  return (STEAM64_ACCOUNT_ID_OFFSET + BigInt(accountId)).toString();
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, attempts = 4): Promise<Response | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: STEAM_FETCH_HEADERS });
      if (response.ok) return response;
      if (response.status === 429 || response.status >= 500) {
        await delay(attempt * 1000);
        continue;
      }
      return response;
    } catch {
      if (attempt === attempts) return undefined;
      await delay(attempt * 1000);
    }
  }
  return undefined;
}

async function resolveVanity(vanity: string): Promise<string | undefined> {
  const url = new URL("https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("vanityurl", vanity);
  const response = await fetchWithRetry(url.toString());
  if (!response || !response.ok) return undefined;
  const data = await response.json() as { response?: { success?: number; steamid?: string } };
  return data.response?.success === 1 ? data.response.steamid : undefined;
}

async function fetchSummaries(steam64s: string[]): Promise<Map<string, SteamPlayerSummary>> {
  const result = new Map<string, SteamPlayerSummary>();
  for (const batch of chunk(steam64s, SUMMARIES_BATCH)) {
    const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("steamids", batch.join(","));
    const response = await fetchWithRetry(url.toString());
    if (!response || !response.ok) throw new Error(`GetPlayerSummaries failed for a batch of ${batch.length}`);
    const data = await response.json() as { response?: { players?: SteamPlayerSummary[] } };
    for (const player of data.response?.players ?? []) result.set(player.steamid, player);
    process.stdout.write(`  summaries: ${result.size}/${steam64s.length}\r`);
  }
  if (steam64s.length > SUMMARIES_BATCH) process.stdout.write("\n");
  return result;
}

async function fetchAvatarBuffer(avatarUrl: string): Promise<Buffer | undefined> {
  const response = await fetchWithRetry(avatarUrl);
  if (!response || !response.ok) return undefined;
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.length > 0 ? buffer : undefined;
}

async function buildBotIndex(): Promise<Record<string, IndexEntry>> {
  const raw = await readFile(botInfoPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, { steamid?: number }>;
  const steam64ToName = new Map<string, string>();
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value.steamid !== "number") continue;
    const steam64 = accountIdToSteam64(value.steamid);
    if (steam64 && !steam64ToName.has(steam64)) steam64ToName.set(steam64, name);
  }
  const steam64s = [...steam64ToName.keys()];
  console.log(`  resolved ${steam64s.length} bot steam64 ids from ${botInfoPath}`);

  const summaries = await fetchSummaries(steam64s);
  const index: Record<string, IndexEntry> = {};
  let done = 0;
  let skipped = 0;
  for (const steam64 of steam64s) {
    done += 1;
    const summary = summaries.get(steam64);
    const avatarUrl = summary?.avatarfull || summary?.avatarmedium || summary?.avatar;
    if (!summary || !avatarUrl) { skipped += 1; continue; }
    const buffer = await fetchAvatarBuffer(avatarUrl);
    if (!buffer) { skipped += 1; continue; }
    await writeFile(path.join(avatarsDir, `${steam64}.jpg`), buffer);
    index[steam64] = {
      personaName: summary.personaname?.trim() || steam64ToName.get(steam64) || steam64,
      avatarPath: avatarRelPath(steam64),
    };
    process.stdout.write(`  bot avatars: ${done}/${steam64s.length} (skipped ${skipped})\r`);
  }
  process.stdout.write("\n");
  return index;
}

async function buildHumanIndex(): Promise<Record<string, IndexEntry>> {
  const steam64s: string[] = [];
  for (const input of HUMAN_INPUTS) {
    if (input.kind === "steam64") {
      steam64s.push(input.value);
      continue;
    }
    const resolved = await resolveVanity(input.value);
    if (!resolved) {
      console.warn(`  WARN: vanity not resolved: ${input.value}`);
      continue;
    }
    console.log(`  vanity ${input.value} -> ${resolved}`);
    steam64s.push(resolved);
  }

  const summaries = await fetchSummaries(steam64s);
  const index: Record<string, IndexEntry> = {};
  for (const steam64 of steam64s) {
    const summary = summaries.get(steam64);
    const avatarUrl = summary?.avatarfull || summary?.avatarmedium || summary?.avatar;
    if (!summary || !avatarUrl) {
      console.warn(`  WARN: no summary/avatar for ${steam64}`);
      continue;
    }
    const buffer = await fetchAvatarBuffer(avatarUrl);
    if (!buffer) {
      console.warn(`  WARN: avatar download failed for ${steam64}`);
      continue;
    }
    await writeFile(path.join(avatarsDir, `${steam64}.jpg`), buffer);
    index[steam64] = {
      personaName: summary.personaname?.trim() || steam64,
      avatarPath: avatarRelPath(steam64),
    };
  }
  return index;
}

async function run(): Promise<number> {
  if (!apiKey) {
    console.error("COMPET_STEAM_WEB_API_KEY is not set. Aborting.");
    return 1;
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(avatarsDir, { recursive: true });

  console.log("Building bot index from BetterBots bot_info.json + Steam ...");
  const botIndex = await buildBotIndex();
  console.log(`  bot entries: ${Object.keys(botIndex).length}`);

  console.log("Building human index (resolving vanity + fetching avatars) ...");
  const humanIndex = await buildHumanIndex();
  console.log(`  human entries: ${Object.keys(humanIndex).length}`);
  parseHumanProfileIndex(humanIndex);

  await writeFile(path.join(outDir, "bot-index.json"), JSON.stringify(botIndex), "utf8");
  await writeFile(path.join(outDir, "human-index.json"), JSON.stringify(humanIndex), "utf8");
  await writeJsonFileAtomic(profileSeedPath, humanIndex, { pretty: false });

  console.log(`\nUpload the whole folder to your COS bucket: ${outDir}`);
  console.log("  bot-index.json, human-index.json, avatars/<steam64>.jpg");
  return 0;
}

async function main(): Promise<void> {
  process.exit(await run());
}

void main();
