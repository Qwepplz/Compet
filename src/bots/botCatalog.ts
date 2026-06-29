import { readFile } from "node:fs/promises";
import path from "node:path";

import { type BotInfoEntry, parseBotInfo } from "./botInfoParser.js";
import { type BotProfileEntry, parseBotProfiles } from "./botProfileParser.js";
import { type BotRosterTeam, parseBotRosters } from "./botRosterParser.js";

export interface BotCandidate {
  name: string;
  templates: string[];
  steamAccountId?: number;
  crosshairCode?: string;
}

export interface BotCatalog {
  candidates: BotCandidate[];
  rosters: BotRosterTeam[];
  findCandidate(name: string): BotCandidate | undefined;
  pickRandom(count: number, random?: () => number): BotCandidate[];
}

export interface BotCatalogInput {
  profileDb: string;
  botInfoJson: string;
  botRosters: string;
  teamLogoImages?: ReadonlyMap<string, string>;
}

export interface BotCatalogPaths {
  profileDbPath: string;
  botInfoPath: string;
  botRostersPath: string;
  teamLogoDirectoryPath?: string;
}

const SAFE_TEAM_LOGO_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function buildUnambiguousInfoByLowerName(infoByName: Map<string, BotInfoEntry>): Map<string, BotInfoEntry | undefined> {
  const fallback = new Map<string, BotInfoEntry | undefined>();

  for (const info of infoByName.values()) {
    const normalized = info.name.toLowerCase();
    fallback.set(normalized, fallback.has(normalized) ? undefined : info);
  }

  return fallback;
}

function findBotInfo(
  profileName: string,
  infoByName: Map<string, BotInfoEntry>,
  unambiguousInfoByLowerName: Map<string, BotInfoEntry | undefined>,
): BotInfoEntry | undefined {
  return infoByName.get(profileName) ?? unambiguousInfoByLowerName.get(profileName.toLowerCase());
}

function enrichCandidate(
  profile: BotProfileEntry,
  infoByName: Map<string, BotInfoEntry>,
  unambiguousInfoByLowerName: Map<string, BotInfoEntry | undefined>,
): BotCandidate {
  const info = findBotInfo(profile.name, infoByName, unambiguousInfoByLowerName);
  return {
    name: profile.name,
    templates: profile.templates,
    steamAccountId: info?.steamAccountId,
    crosshairCode: info?.crosshairCode,
  };
}

export function createBotCatalog(input: BotCatalogInput): BotCatalog {
  const infoByName = parseBotInfo(input.botInfoJson);
  const unambiguousInfoByLowerName = buildUnambiguousInfoByLowerName(infoByName);
  const candidates = parseBotProfiles(input.profileDb).map((profile) => enrichCandidate(profile, infoByName, unambiguousInfoByLowerName));
  const rosters = parseBotRosters(input.botRosters).map((roster) => {
    const logoImage = roster.logo ? input.teamLogoImages?.get(roster.logo) : undefined;
    return logoImage ? { ...roster, logoImage } : roster;
  });

  return {
    candidates,
    rosters,
    findCandidate(name: string): BotCandidate | undefined {
      const exact = candidates.find((candidate) => candidate.name === name);
      if (exact) {
        return exact;
      }

      const normalized = name.toLowerCase();
      const matches = candidates.filter((candidate) => candidate.name.toLowerCase() === normalized);
      return matches.length === 1 ? matches[0] : undefined;
    },
    pickRandom(count: number, random: () => number = Math.random): BotCandidate[] {
      const pool = [...candidates];
      const picked: BotCandidate[] = [];
      const limit = Math.min(Math.max(0, count), pool.length);

      for (let index = 0; index < limit; index += 1) {
        const poolIndex = Math.min(Math.floor(random() * pool.length), pool.length - 1);
        const [candidate] = pool.splice(poolIndex, 1);
        picked.push(candidate);
      }

      return picked;
    },
  };
}

async function readTeamLogoImage(logoDirectoryPath: string | undefined, logo: string): Promise<string | undefined> {
  if (!logoDirectoryPath || !SAFE_TEAM_LOGO_ID_PATTERN.test(logo)) return undefined;
  try {
    const svg = await readFile(path.join(logoDirectoryPath, `${logo}.svg`), "utf8");
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readTeamLogoImages(rosters: readonly BotRosterTeam[], logoDirectoryPath?: string): Promise<ReadonlyMap<string, string>> {
  const images = new Map<string, string>();
  const logos = [...new Set(rosters.map((roster) => roster.logo).filter((logo): logo is string => Boolean(logo)))];
  await Promise.all(logos.map(async (logo) => {
    const image = await readTeamLogoImage(logoDirectoryPath, logo);
    if (image) images.set(logo, image);
  }));
  return images;
}

export async function loadBotCatalog(paths: BotCatalogPaths): Promise<BotCatalog> {
  const [profileDb, botInfoJson, botRosters] = await Promise.all([
    readFile(paths.profileDbPath, "utf8"),
    readFile(paths.botInfoPath, "utf8"),
    readFile(paths.botRostersPath, "utf8"),
  ]);
  const rosters = parseBotRosters(botRosters);
  const teamLogoImages = await readTeamLogoImages(rosters, paths.teamLogoDirectoryPath);

  return createBotCatalog({ profileDb, botInfoJson, botRosters, teamLogoImages });
}
