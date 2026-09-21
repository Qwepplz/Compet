import type { PlayerLiveMatchStateDto } from "../../shared/types.js";

type MapSelection = PlayerLiveMatchStateDto["mapSelection"];

export const MAP_REEL_VISIBLE_TILES = 3;

export function mapReelOffset(index: number): number {
  return 50 - (index + 0.5) * (100 / MAP_REEL_VISIBLE_TILES);
}

export function isMapRandomizingRevealed(mapSelection: MapSelection, nowMs: number): boolean {
  if (!mapSelection?.startedAt || !mapSelection.revealAt) return false;
  const revealMs = Date.parse(mapSelection.revealAt);
  const startMs = Date.parse(mapSelection.startedAt);
  return Number.isFinite(startMs) && Number.isFinite(revealMs) && revealMs > startMs && nowMs >= revealMs;
}

export function mapReelPosition(mapSelection: NonNullable<MapSelection>, nowMs: number): number {
  const start = Date.parse(mapSelection.startedAt ?? "");
  const end = Date.parse(mapSelection.revealAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 1;
  const progress = Math.max(0, Math.min(1, (nowMs - start) / (end - start)));
  return 1 + (mapSelection.reel.length - 2) * (1 - (1 - progress) ** 3);
}
