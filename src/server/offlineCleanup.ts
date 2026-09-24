import type { FriendService } from "../friends/friendService.js";
import type { PresenceService } from "../presence/presenceService.js";

type OfflineCleanupOperation = "participant_check" | "friend_cleanup" | "matchmaking_cleanup";

interface CleanupProgress {
  revision: object;
  pending: Set<"friends" | "matchmaking">;
}

interface OfflineCleanupTimer {
  revision: object;
  timeout: ReturnType<typeof setTimeout>;
}

export interface OfflineCleanupSchedulerDependencies {
  presence: Pick<PresenceService, "get" | "isOnline">;
  matchmaking: {
    isMatchmakingParticipant(accountId: string): Promise<boolean>;
    handleAccountOffline(accountId: string, shouldContinue: () => boolean): Promise<void>;
  };
  friends: Pick<FriendService, "expireDisconnectedRequests">;
  graceMs: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  now?: () => number | Date;
  onError: (accountId: string, operation: OfflineCleanupOperation, error: unknown) => void;
}

export interface OfflineCleanupScheduler {
  onPresenceUpdated(accountId: string, online: boolean): void;
  close(): void;
}

const OFFLINE_MATCHMAKING_GRACE_MS = 8_000;
const RETRY_DELAY_MS = 1_000;

export function createOfflineCleanupScheduler(
  deps: OfflineCleanupSchedulerDependencies,
): OfflineCleanupScheduler {
  const setTimeoutFn = deps.setTimeout ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeout ?? clearTimeout;
  const nowMs = () => {
    const value = deps.now?.() ?? Date.now();
    return value instanceof Date ? value.getTime() : value;
  };
  const timers = new Map<string, OfflineCleanupTimer>();
  const revisions = new Map<string, object>();
  const cleanupProgress = new Map<string, CleanupProgress>();
  let closed = false;

  const isCurrentOffline = (accountId: string, revision: object): boolean => (
    !closed
    && revisions.get(accountId) === revision
    && !deps.presence.isOnline(accountId)
  );

  const clearTimer = (accountId: string): void => {
    const entry = timers.get(accountId);
    if (!entry) return;
    clearTimeoutFn(entry.timeout);
    timers.delete(accountId);
  };

  const schedule = (
    accountId: string,
    revision: object,
    delayMs: number,
    callback: () => void,
  ): void => {
    if (!isCurrentOffline(accountId, revision)) return;
    clearTimer(accountId);
    const timeout = setTimeoutFn(() => {
      const entry = timers.get(accountId);
      if (entry?.timeout !== timeout || entry.revision !== revision) return;
      timers.delete(accountId);
      if (!isCurrentOffline(accountId, revision)) return;
      callback();
    }, Math.max(0, delayMs));
    (timeout as NodeJS.Timeout).unref?.();
    timers.set(accountId, { revision, timeout });
  };

  const scheduleParticipantCheck = (accountId: string, revision: object, delayMs: number): void => {
    schedule(accountId, revision, delayMs, () => {
      void checkParticipantStatus(accountId, revision);
    });
  };

  const runPendingCleanup = async (accountId: string, revision: object): Promise<void> => {
    let progress = cleanupProgress.get(accountId);
    if (!progress || progress.revision !== revision) {
      progress = { revision, pending: new Set(["friends", "matchmaking"]) };
      cleanupProgress.set(accountId, progress);
    }

    const pending = [...progress.pending];
    const operations = pending.map((operation) => (
      operation === "friends"
        ? () => deps.friends.expireDisconnectedRequests(accountId)
        : () => deps.matchmaking.handleAccountOffline(accountId, () => isCurrentOffline(accountId, revision))
    ));
    const results = await Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation)));
    results.forEach((result, index) => {
      const operation = pending[index]!;
      if (result.status === "fulfilled") {
        progress!.pending.delete(operation);
        return;
      }
      const operationName: OfflineCleanupOperation = operation === "friends" ? "friend_cleanup" : "matchmaking_cleanup";
      deps.onError(accountId, operationName, result.reason);
    });

    if (!isCurrentOffline(accountId, revision)) return;
    if (progress.pending.size === 0) {
      cleanupProgress.delete(accountId);
      return;
    }
    schedule(accountId, revision, RETRY_DELAY_MS, () => {
      void runPendingCleanup(accountId, revision);
    });
  };

  async function checkParticipantStatus(accountId: string, revision: object): Promise<void> {
    if (!isCurrentOffline(accountId, revision)) return;
    let matching: boolean;
    try {
      matching = await deps.matchmaking.isMatchmakingParticipant(accountId);
    } catch (error) {
      deps.onError(accountId, "participant_check", error);
      scheduleParticipantCheck(accountId, revision, RETRY_DELAY_MS);
      return;
    }
    if (!isCurrentOffline(accountId, revision)) return;

    const lastSeenAt = deps.presence.get(accountId).lastSeenAt;
    const elapsedOfflineMs = lastSeenAt ? nowMs() - Date.parse(lastSeenAt) : 0;
    const delayMs = matching
      ? Math.max(0, OFFLINE_MATCHMAKING_GRACE_MS - elapsedOfflineMs)
      : deps.graceMs;
    schedule(accountId, revision, delayMs, () => {
      void runPendingCleanup(accountId, revision);
    });
  }

  return {
    onPresenceUpdated(accountId, online) {
      if (closed) return;
      const revision = {};
      revisions.set(accountId, revision);
      clearTimer(accountId);
      cleanupProgress.delete(accountId);
      if (online) return;
      void checkParticipantStatus(accountId, revision);
    },
    close() {
      if (closed) return;
      closed = true;
      revisions.clear();
      cleanupProgress.clear();
      for (const accountId of timers.keys()) clearTimer(accountId);
    },
  };
}
