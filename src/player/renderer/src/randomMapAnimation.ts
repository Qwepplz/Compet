import type { PlayerLiveMatchStateDto } from "../../shared/types.js";

type MapSelection = PlayerLiveMatchStateDto["mapSelection"];

export const MAP_REEL_VISIBLE_TILES = 3;

export function mapReelOffset(index: number): number {
  return 50 - (index + 0.5) * (100 / MAP_REEL_VISIBLE_TILES);
}

export function mapReelDurationMs(mapSelection: NonNullable<MapSelection>, nowMs: number): number {
  const revealMs = Date.parse(mapSelection.revealAt);
  if (!Number.isFinite(revealMs)) return 0;
  return Math.max(0, revealMs - nowMs);
}

export function isMapRandomizingRevealed(mapSelection: MapSelection, nowMs: number): boolean {
  if (!mapSelection) return false;
  const revealMs = Date.parse(mapSelection.revealAt);
  return Number.isFinite(revealMs) && nowMs >= revealMs;
}
