import type { PlayerLiveMatchStateDto } from "../../shared/types.js";

type MapSelection = PlayerLiveMatchStateDto["mapSelection"];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function uniqueMaps(maps: string[]): string[] {
  return maps.filter((map, index) => map && maps.indexOf(map) === index);
}

function buildAnimationPool(mapSelection: NonNullable<MapSelection>, allowFinal: boolean): string[] {
  const source = uniqueMaps([...mapSelection.reel, ...mapSelection.mapPool]);
  if (allowFinal) return source.length > 0 ? source : [mapSelection.finalMap];
  const nonFinal = source.filter((map) => map !== mapSelection.finalMap);
  return nonFinal.length > 0 ? nonFinal : source.length > 0 ? source : [mapSelection.finalMap];
}

export function getRandomizingDisplayMap(mapSelection: MapSelection, nowMs: number): string | undefined {
  if (!mapSelection) return undefined;

  const revealMs = Date.parse(mapSelection.revealAt);
  const startedMs = Date.parse(mapSelection.startedAt);
  if (Number.isFinite(revealMs) && nowMs >= revealMs) return mapSelection.finalMap;

  const animationPool = buildAnimationPool(mapSelection, false);
  if (animationPool.length === 0) return undefined;

  if (!Number.isFinite(startedMs) || !Number.isFinite(revealMs) || revealMs <= startedMs) {
    return animationPool[0];
  }

  const durationMs = revealMs - startedMs;
  const progress = clamp((nowMs - startedMs) / durationMs, 0, 0.999);
  const eased = 1 - Math.pow(1 - progress, 2.5);
  const frameCount = Math.max(1, animationPool.length * 4);
  const frame = Math.min(Math.floor(eased * frameCount), frameCount - 1);
  return animationPool[frame % animationPool.length];
}

export function isMapRandomizingRevealed(mapSelection: MapSelection, nowMs: number): boolean {
  if (!mapSelection) return false;
  const revealMs = Date.parse(mapSelection.revealAt);
  return Number.isFinite(revealMs) && nowMs >= revealMs;
}

export function isMapRandomizingPreReveal(mapSelection: MapSelection, nowMs: number): boolean {
  if (!mapSelection) return false;
  const revealMs = Date.parse(mapSelection.revealAt);
  return Number.isFinite(revealMs) && nowMs < revealMs;
}
