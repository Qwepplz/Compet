import type { RankmeLevel } from "../../../rankme/rankmeStandings.js";

export function faceitLevelIconUrl(level: RankmeLevel): string {
  return new URL(`./assets/faceit/${level}.png`, import.meta.url).href;
}

export function faceitRankIconUrl(rank: number | null): string | undefined {
  if (rank === null || !Number.isInteger(rank) || rank < 1 || rank > 100) return undefined;
  return new URL(`./assets/faceit/rank${rank}.png`, import.meta.url).href;
}
