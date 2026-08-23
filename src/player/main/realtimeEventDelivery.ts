import type { PlayerRealtimeEvent } from "../shared/types.js";

export interface RealtimeEventDeliveryOptions {
  getSessionVersion: () => number;
  isPaused: () => boolean;
  isSuperseded?: (event: PlayerRealtimeEvent) => boolean;
  queue: (event: PlayerRealtimeEvent) => void;
  publish: (event: PlayerRealtimeEvent) => void;
  enrichTimeoutMs?: number;
  publishFallback?: boolean;
}

export async function deliverRealtimeEvent(
  event: PlayerRealtimeEvent,
  sessionVersion: number,
  enrich: (event: PlayerRealtimeEvent) => Promise<PlayerRealtimeEvent>,
  options: RealtimeEventDeliveryOptions,
): Promise<void> {
  try {
    const next = await enrichWithTimeout(event, enrich, options.enrichTimeoutMs);
    if (next !== event || options.publishFallback !== false) {
      publishOrQueue(next, sessionVersion, options);
    }
  } catch {
    if (options.publishFallback !== false) {
      publishOrQueue(event, sessionVersion, options);
    }
  }
}

async function enrichWithTimeout(
  event: PlayerRealtimeEvent,
  enrich: (event: PlayerRealtimeEvent) => Promise<PlayerRealtimeEvent>,
  enrichTimeoutMs: number | undefined,
): Promise<PlayerRealtimeEvent> {
  if (!enrichTimeoutMs || enrichTimeoutMs <= 0) {
    return enrich(event);
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => enrich(event)),
      new Promise<PlayerRealtimeEvent>((resolve) => {
        timeoutId = setTimeout(() => resolve(event), enrichTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function publishOrQueue(
  event: PlayerRealtimeEvent,
  sessionVersion: number,
  options: RealtimeEventDeliveryOptions,
): void {
  if (sessionVersion !== options.getSessionVersion()) return;
  if (options.isSuperseded?.(event)) return;
  if (options.isPaused()) {
    options.queue(event);
    return;
  }
  options.publish(event);
}
