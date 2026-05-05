import type { PlayerRealtimeEvent } from "../shared/types.js";

export interface RealtimeEventDeliveryOptions {
  getSessionVersion: () => number;
  isPaused: () => boolean;
  queue: (event: PlayerRealtimeEvent) => void;
  publish: (event: PlayerRealtimeEvent) => void;
}

export async function deliverRealtimeEvent(
  event: PlayerRealtimeEvent,
  sessionVersion: number,
  enrich: (event: PlayerRealtimeEvent) => Promise<PlayerRealtimeEvent>,
  options: RealtimeEventDeliveryOptions,
): Promise<void> {
  try {
    publishOrQueue(await enrich(event), sessionVersion, options);
  } catch {
    publishOrQueue(event, sessionVersion, options);
  }
}

function publishOrQueue(
  event: PlayerRealtimeEvent,
  sessionVersion: number,
  options: RealtimeEventDeliveryOptions,
): void {
  if (sessionVersion !== options.getSessionVersion()) return;
  if (options.isPaused()) {
    options.queue(event);
    return;
  }
  options.publish(event);
}
