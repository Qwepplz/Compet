import type { RealtimeEvent } from "./realtimeTypes.js";

export type RealtimeEventListener = (event: RealtimeEvent) => void;

export class RealtimeEventBus {
  private readonly listeners = new Set<RealtimeEventListener>();

  publish(event: RealtimeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Listener failures are isolated so one bad socket cannot stop broadcasts.
      }
    }
  }

  subscribe(listener: RealtimeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
