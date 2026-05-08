import type { RealtimeEvent, SequencedRealtimeEvent } from "./realtimeTypes.js";

export interface RealtimeReplayResult {
  events: SequencedRealtimeEvent[];
  gap: boolean;
}

export type RealtimeEventListener = (event: SequencedRealtimeEvent) => void;

const MAX_REPLAY_EVENTS = 500;

export class RealtimeEventBus {
  private readonly listeners = new Set<RealtimeEventListener>();
  private readonly history: SequencedRealtimeEvent[] = [];
  private nextSeq = 1;

  publish(event: RealtimeEvent): void {
    const sequencedEvent: SequencedRealtimeEvent = { ...event, seq: event.seq ?? this.nextSeq++ } as SequencedRealtimeEvent;
    this.history.push(sequencedEvent);
    if (this.history.length > MAX_REPLAY_EVENTS) {
      this.history.splice(0, this.history.length - MAX_REPLAY_EVENTS);
    }

    for (const listener of [...this.listeners]) {
      try {
        listener(sequencedEvent);
      } catch {
        // Listener failures are isolated so one bad socket cannot stop broadcasts.
      }
    }
  }

  getEventsAfter(accountId: string, afterSeq: number): RealtimeReplayResult {
    const firstSeq = this.history[0]?.seq;
    const gap = firstSeq !== undefined && afterSeq < firstSeq - 1;
    return {
      gap,
      events: this.history.filter((event) => event.seq > afterSeq && eventIncludesAccount(event, accountId)),
    };
  }

  subscribe(listener: RealtimeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function eventIncludesAccount(event: RealtimeEvent, accountId: string): boolean {
  if ("accountIds" in event && event.accountIds) {
    return event.accountIds.includes(accountId);
  }
  if ("accountId" in event) {
    return event.accountId === accountId;
  }
  return true;
}
