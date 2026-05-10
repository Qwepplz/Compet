import type { PlayerRealtimeStatusDto } from "../shared/types.js";

export function getRealtimeStatusAfterPollFailure(
  current: PlayerRealtimeStatusDto,
  connectedInCurrentSession: boolean,
): PlayerRealtimeStatusDto {
  if (current.connection === "disconnected" && current.stale) {
    return current;
  }

  if (connectedInCurrentSession || current.connection === "connected") {
    return { connection: "connecting", stale: true };
  }

  return { connection: "disconnected", stale: false };
}

export function shouldApplyRealtimePollFailure(
  pollStartedStatusRevision: number,
  currentStatusRevision: number,
): boolean {
  return pollStartedStatusRevision === currentStatusRevision;
}
