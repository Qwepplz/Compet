import type { PlayerLiveMatchStateDto } from "../../shared/types.js";

type MapSelection = PlayerLiveMatchStateDto["mapSelection"];

export const MAP_REEL_VISIBLE_TILES = 3;

export function mapReelOffset(viewportWidth: number, index: number): number {
  const tileWidth = viewportWidth / MAP_REEL_VISIBLE_TILES;
  return viewportWidth / 2 - (index + 0.5) * tileWidth;
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
