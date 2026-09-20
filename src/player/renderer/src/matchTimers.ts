export const READY_COUNTDOWN_SECONDS = 45;

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function formatMatchmakingElapsed(elapsedMs: number): string {
  return formatClock(Math.max(0, Math.floor(elapsedMs / 1000)));
}

export function formatReadyCountdown(deadlineAt: string | undefined, nowMs: number): string {
  if (!deadlineAt) return "--:--";
  const deadlineMs = new Date(deadlineAt).getTime();
  if (!Number.isFinite(deadlineMs)) return "--:--";
  const remainingSeconds = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
  return formatClock(Math.min(READY_COUNTDOWN_SECONDS, remainingSeconds));
}
