export interface HltvRating2Stats {
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
}

export function calculateHltvRating2(
  stats: HltvRating2Stats,
  kastRounds: number | undefined,
  roundsPlayed: number | undefined,
): number | undefined {
  if (
    kastRounds === undefined
    || roundsPlayed === undefined
    || roundsPlayed <= 0
    || !Number.isFinite(kastRounds)
    || !Number.isFinite(roundsPlayed)
    || !Number.isFinite(stats.kills)
    || !Number.isFinite(stats.deaths)
    || !Number.isFinite(stats.assists)
    || !Number.isFinite(stats.damage)
  ) {
    return undefined;
  }

  const kast = (kastRounds / roundsPlayed) * 100;
  const kpr = stats.kills / roundsPlayed;
  const dpr = stats.deaths / roundsPlayed;
  const apr = stats.assists / roundsPlayed;
  const adr = stats.damage / roundsPlayed;
  const impact = 2.13 * kpr + 0.42 * apr - 0.41;
  const rating = 0.0073 * kast + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587;

  return Math.max(0, Math.round(rating * 100) / 100);
}
