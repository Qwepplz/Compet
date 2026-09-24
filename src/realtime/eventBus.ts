import { randomUUID } from "node:crypto";
import type { RealtimeEvent, SequencedRealtimeEvent } from "./realtimeTypes.js";

export interface RealtimeReplayResult {
  streamId: string;
  events: SequencedRealtimeEvent[];
  gap: boolean;
  latestSeq: number;
}

export type RealtimeEventListener = (event: SequencedRealtimeEvent) => void;

const MAX_REPLAY_EVENTS = 500;
const MAX_SEEN_IDEMPOTENT_EVENT_IDS = MAX_REPLAY_EVENTS * 2;

export class RealtimeEventBus {
  readonly streamId = randomUUID();
  private readonly listeners = new Set<RealtimeEventListener>();
  private readonly history: SequencedRealtimeEvent[] = [];
  private readonly seenIdempotentEventIds = new Set<string>();
  private readonly idempotentEventIdOrder: string[] = [];
  private nextSeq = 1;

  latestSeq(): number {
    return this.nextSeq - 1;
  }

  publish(event: RealtimeEvent): void {
    if ((event.type === "match_failed" || event.type === "match_completed") && event.eventId) {
      if (this.seenIdempotentEventIds.has(event.eventId)) return;
      this.seenIdempotentEventIds.add(event.eventId);
      this.idempotentEventIdOrder.push(event.eventId);
      if (this.idempotentEventIdOrder.length > MAX_SEEN_IDEMPOTENT_EVENT_IDS) {
        const expiredEventId = this.idempotentEventIdOrder.shift();
        if (expiredEventId) this.seenIdempotentEventIds.delete(expiredEventId);
      }
    }

    const sequencedEvent: SequencedRealtimeEvent = {
      ...event,
      streamId: this.streamId,
      seq: event.seq ?? this.nextSeq++,
      serverNow: event.serverNow ?? new Date().toISOString(),
    } as SequencedRealtimeEvent;
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
    const latestSeq = this.latestSeq();
    const gap = afterSeq > latestSeq || (firstSeq !== undefined && afterSeq < firstSeq - 1);
    return {
      streamId: this.streamId,
      gap,
      latestSeq,
      events: this.history.filter((event) => event.seq > afterSeq && eventIncludesAccount(event, accountId)),
    };
  }

  waitForEventsAfter(accountId: string, afterSeq: number, timeoutMs: number): Promise<RealtimeReplayResult> {
    const effectiveAfterSeq = afterSeq > 0 ? afterSeq : this.history.at(-1)?.seq ?? 0;
    const existing = this.getEventsAfter(accountId, effectiveAfterSeq);
    if (existing.events.length > 0 || existing.gap || timeoutMs <= 0) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (result: RealtimeReplayResult) => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish(this.getEventsAfter(accountId, effectiveAfterSeq)), timeoutMs);
      timer.unref?.();
      unsubscribe = this.subscribe((event) => {
        if (event.seq > effectiveAfterSeq && eventIncludesAccount(event, accountId)) {
          finish(this.getEventsAfter(accountId, effectiveAfterSeq));
        }
      });
    });
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
