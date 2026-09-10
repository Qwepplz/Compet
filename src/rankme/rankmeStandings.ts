export type RankmeLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface RankmeLeaderboardRow {
  steam: string;
  name: string;
  score: number;
  kills: number;
  deaths: number;
}

export interface RankmeDisplay {
  score: number | null;
  level: RankmeLevel;
  rank: number | null;
}

export type RankmeStandingLookup =
  | { status: "found"; standing: RankmeDisplay }
  | { status: "missing" }
  | { status: "unavailable" };

export interface RankmeLeaderboardSnapshot {
  total: number;
  bySteam: Map<string, RankmeDisplay>;
  byBotName: Map<string, RankmeDisplay>;
}

const steam64Base = 76561197960265728n;
const steam2Pattern = /^STEAM_1:([01]):(\d+)$/;
const LEVEL_THRESHOLDS: ReadonlyArray<readonly [number, RankmeLevel]> = [
  [0.015, 10],
  [0.035, 9],
  [0.07, 8],
  [0.12, 7],
  [0.21, 6],
  [0.35, 5],
  [0.6, 4],
  [0.8, 3],
  [0.92, 2],
  [1, 1],
];

export function compareRankmeRows(left: RankmeLeaderboardRow, right: RankmeLeaderboardRow): number {
  return right.score - left.score || right.kills - left.kills || left.deaths - right.deaths;
}

function steamIdentityKeys(steam: string): string[] {
  const normalized = steam.trim();
  if (/^\d{17}$/.test(normalized)) {
    const accountId = BigInt(normalized) - steam64Base;
    if (accountId < 0n) return [];
    return [normalized, `STEAM_1:${accountId % 2n}:${accountId / 2n}`];
  }
  const steam2 = steam2Pattern.exec(normalized);
  if (!steam2) return [];
  const steam64 = steam64Base + BigInt(steam2[2]!) * 2n + BigInt(steam2[1]!);
  return [normalized, steam64.toString()];
}

function levelForPercentile(percentile: number): RankmeLevel {
  for (const [limit, level] of LEVEL_THRESHOLDS) {
    if (percentile < limit) return level;
  }
  return 1;
}

export function buildRankmeLeaderboardSnapshot(
  rows: readonly RankmeLeaderboardRow[],
): RankmeLeaderboardSnapshot {
  const sorted = [...rows].sort(compareRankmeRows);
  const bySteam = new Map<string, RankmeDisplay>();
  const byBotName = new Map<string, RankmeDisplay>();
  const total = sorted.length;
  let previousRow: RankmeLeaderboardRow | null = null;
  let competitiveRank = 0;

  sorted.forEach((row, index) => {
    if (!previousRow || compareRankmeRows(previousRow, row) !== 0) {
      competitiveRank = index + 1;
    }
    previousRow = row;

    const standing: RankmeDisplay = {
      score: row.score,
      level: levelForPercentile((competitiveRank - 1) / total),
      rank: competitiveRank <= 100 ? competitiveRank : null,
    };

    const identityKeys = steamIdentityKeys(row.steam);
    if (identityKeys.length > 0) {
      for (const identityKey of identityKeys) {
        if (!bySteam.has(identityKey)) bySteam.set(identityKey, standing);
      }
      return;
    }

    const botName = row.name.trim();
    if (botName && !byBotName.has(botName)) byBotName.set(botName, standing);
  });

  return { total, bySteam, byBotName };
}

export function rankmeDisplayFromLookup(
  lookup: RankmeStandingLookup,
  fallbackLevel: RankmeLevel,
  fallbackScore: number | null,
): RankmeDisplay | null {
  if (lookup.status === "found") return lookup.standing;
  if (lookup.status === "unavailable") return null;
  return { score: fallbackScore, level: fallbackLevel, rank: null };
}
