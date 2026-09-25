import { isSessionInvalidError, PlayerApiError, type PlayerApiClient } from "./playerApiClient.js";

export interface AuthRetryDeps {
  getApiClient(): PlayerApiClient;
  recover(assertCurrent: () => void): Promise<boolean>;
}

export interface AuthRetryController {
  run<T>(operation: (client: PlayerApiClient) => Promise<T>): Promise<T>;
  authenticate<T>(operation: (assertCurrent: () => void, previous: Promise<void>) => Promise<T>): Promise<T>;
  suspend(): Promise<void>;
  resume(): void;
}

export function createAuthRetry(deps: AuthRetryDeps): AuthRetryController {
  let revision = 0;
  let paused = false;
  let recovery: Promise<boolean> | undefined;
  const explicit = new Set<Promise<unknown>>();
  const suspend = async (): Promise<void> => {
    paused = true;
    revision += 1;
    await Promise.allSettled([recovery, ...explicit]);
  };
  const currentClient = () => {
    try { return deps.getApiClient(); }
    catch { return undefined; }
  };
  return {
    async run<T>(operation: (client: PlayerApiClient) => Promise<T>): Promise<T> {
      if (paused) throw new PlayerApiError("Authentication paused", 503, "service_unavailable");
      const requestRevision = revision;
      const failedClient = deps.getApiClient();
      try {
        return await operation(failedClient);
      } catch (error) {
        if (!isSessionInvalidError(error)) throw error;
        if (paused || revision !== requestRevision) throw error;
        const active = currentClient();
        if (!active) throw error;
        if (active !== failedClient) return operation(active);
        if (!recovery) {
          const assertCurrent = () => {
            if (paused || revision !== requestRevision || currentClient() !== failedClient) {
              throw new Error("Authentication recovery superseded");
            }
          };
          const task = Promise.resolve()
            .then(() => deps.recover(assertCurrent))
            .then((ok) => {
              if (!ok && revision === requestRevision) paused = true;
              return ok;
            });
          recovery = task;
          void task.finally(() => {
            if (recovery === task) recovery = undefined;
          }).catch(() => undefined);
        }
        const recovered = await recovery;
        if (!recovered || paused || revision !== requestRevision) throw error;
        return operation(deps.getApiClient());
      }
    },
    authenticate<T>(operation: (assertCurrent: () => void, previous: Promise<void>) => Promise<T>): Promise<T> {
      const previous = suspend();
      const authenticationRevision = revision;
      const assertCurrent = () => {
        if (revision !== authenticationRevision) throw new Error("Authentication recovery superseded");
      };
      const task = Promise.resolve().then(() => operation(assertCurrent, previous));
      explicit.add(task);
      void task.finally(() => explicit.delete(task)).catch(() => undefined);
      return task;
    },
    suspend,
    resume(): void {
      paused = false;
    },
  };
}
