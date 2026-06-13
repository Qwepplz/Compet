import type { PlayerLiveMatchStateDto } from "../../shared/types.js";

type MapSelection = PlayerLiveMatchStateDto["mapSelection"];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getRandomizingDisplayMap(mapSelection: MapSelection, nowMs: number): string | undefined {
  if (!mapSelection) return undefined;

  const reel = mapSelection.reel;
  const lastIndex = reel.length - 1;

  const revealMs = Date.parse(mapSelection.revealAt);
  const startedMs = Date.parse(mapSelection.startedAt);
  if (Number.isFinite(revealMs) && nowMs >= revealMs) return mapSelection.finalMap;

  if (!Number.isFinite(startedMs) || !Number.isFinite(revealMs) || revealMs <= startedMs) {
    return reel[0];
  }

  const durationMs = revealMs - startedMs;
  const progress = clamp((nowMs - startedMs) / durationMs, 0, 1);
  const eased = 1 - Math.pow(1 - progress, 2.5);
  const frame = clamp(Math.round(eased * lastIndex), 0, lastIndex);
  return reel[frame];
}

export function isMapRandomizingRevealed(mapSelection: MapSelection, nowMs: number): boolean {
  if (!mapSelection) return false;
  const revealMs = Date.parse(mapSelection.revealAt);
  return Number.isFinite(revealMs) && nowMs >= revealMs;
}
