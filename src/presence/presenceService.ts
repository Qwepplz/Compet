export interface PresenceSummary {
  accountId: string;
  online: boolean;
  connectedAt?: string;
  lastSeenAt?: string;
  connectionCount: number;
}

interface PresenceState {
  connectedAt?: string;
  lastSeenAt?: string;
  connectionCount: number;
}

export class PresenceService {
  private readonly states = new Map<string, PresenceState>();

  register(accountId: string, now: string = timestamp()): PresenceSummary {
    const state = this.states.get(accountId);
    if (!state || state.connectionCount === 0) {
      const nextState: PresenceState = {
        connectedAt: now,
        connectionCount: 1,
      };
      this.states.set(accountId, nextState);
      return toSummary(accountId, nextState);
    }

    state.connectionCount += 1;
    return toSummary(accountId, state);
  }

  unregister(accountId: string, now: string = timestamp()): PresenceSummary {
    const state = this.states.get(accountId);
    if (!state) return toSummary(accountId);
    if (state.connectionCount === 0) return toSummary(accountId, state);

    state.connectionCount -= 1;
    if (state.connectionCount === 0) {
      state.lastSeenAt = now;
    }

    return toSummary(accountId, state);
  }

  isOnline(accountId: string): boolean {
    return this.get(accountId).online;
  }

  get(accountId: string): PresenceSummary {
    return toSummary(accountId, this.states.get(accountId));
  }

  list(accountIds?: string[]): PresenceSummary[] {
    if (accountIds) {
      return accountIds.map((accountId) => this.get(accountId));
    }

    return Array.from(this.states.entries(), ([accountId, state]) => toSummary(accountId, state));
  }
}

function toSummary(accountId: string, state?: PresenceState): PresenceSummary {
  return {
    accountId,
    online: (state?.connectionCount ?? 0) > 0,
    connectedAt: state?.connectedAt,
    lastSeenAt: state?.lastSeenAt,
    connectionCount: state?.connectionCount ?? 0,
  };
}

function timestamp(): string {
  return new Date().toISOString();
}
