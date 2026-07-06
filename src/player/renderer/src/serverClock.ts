export type ServerClockOffsetMs = number | null;

export function updateServerClockOffset(
  currentOffsetMs: ServerClockOffsetMs,
  serverNow: string | undefined,
  localNowMs = Date.now(),
): ServerClockOffsetMs {
  if (!serverNow) return currentOffsetMs;
  const serverNowMs = Date.parse(serverNow);
  if (!Number.isFinite(serverNowMs) || !Number.isFinite(localNowMs)) return currentOffsetMs;
  return serverNowMs - localNowMs;
}

export function serverSyncedNowMs(offsetMs: ServerClockOffsetMs, localNowMs = Date.now()): number {
  return localNowMs + (offsetMs ?? 0);
}
