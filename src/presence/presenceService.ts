export interface PresenceSummary {
  accountId: string;
  online: boolean;
  inGame: boolean;
  connectedAt?: string;
  lastSeenAt?: string;
  connectionCount: number;
}

export interface GamePresenceChange {
  accountId: string;
  inGame: boolean;
}

interface PresenceState {
  connectedAt?: string;
  lastSeenAt?: string;
  connectionCount: number;
}

export class PresenceService {
  private readonly states = new Map<string, PresenceState>();
  private inGameAccountIds = new Set<string>();

  register(accountId: string, now: string = timestamp()): PresenceSummary {
    const state = this.states.get(accountId);
    if (!state || state.connectionCount === 0) {
      const nextState: PresenceState = {
        connectedAt: now,
        connectionCount: 1,
      };
      this.states.set(accountId, nextState);
      return this.toSummary(accountId, nextState);
    }

    state.connectionCount += 1;
    return this.toSummary(accountId, state);
  }

  unregister(accountId: string, now: string = timestamp()): PresenceSummary {
    const state = this.states.get(accountId);
    if (!state) return this.toSummary(accountId);
    if (state.connectionCount === 0) return this.toSummary(accountId, state);

    state.connectionCount -= 1;
    if (state.connectionCount === 0) {
      state.lastSeenAt = now;
    }

    return this.toSummary(accountId, state);
  }

  isOnline(accountId: string): boolean {
    return this.get(accountId).online;
  }

  seedLastSeen(accountId: string, lastSeenAt: string): void {
    const state = this.states.get(accountId);
    if (state) {
      if (state.connectionCount === 0 && !state.lastSeenAt) state.lastSeenAt = lastSeenAt;
      return;
    }
    this.states.set(accountId, { connectionCount: 0, lastSeenAt });
  }

  replaceInGameAccounts(accountIds: readonly string[]): GamePresenceChange[] {
    const next = new Set(accountIds);
    const changed = new Set([...this.inGameAccountIds, ...next]);
    const result = [...changed]
      .filter((accountId) => this.inGameAccountIds.has(accountId) !== next.has(accountId))
      .sort()
      .map((accountId) => ({ accountId, inGame: next.has(accountId) }));
    this.inGameAccountIds = next;
    return result;
  }

  get(accountId: string): PresenceSummary {
    return this.toSummary(accountId, this.states.get(accountId));
  }

  list(accountIds?: string[]): PresenceSummary[] {
    if (accountIds) {
      return accountIds.map((accountId) => this.get(accountId));
    }

    return Array.from(this.states.entries(), ([accountId, state]) => this.toSummary(accountId, state));
  }

  private toSummary(accountId: string, state?: PresenceState): PresenceSummary {
    return {
      accountId,
      online: (state?.connectionCount ?? 0) > 0,
      inGame: this.inGameAccountIds.has(accountId),
      connectedAt: state?.connectedAt,
      lastSeenAt: state?.lastSeenAt,
      connectionCount: state?.connectionCount ?? 0,
    };
  }
}

function timestamp(): string {
  return new Date().toISOString();
}
