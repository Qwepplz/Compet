import { createInterface } from "node:readline";
import { MANAGER_SHUTDOWN_COMMAND } from "../shared/serviceControl.js";

export interface GracefulShutdownTarget {
  close(reason: string): Promise<unknown>;
}

export function installGracefulShutdown(options: {
  target: GracefulShutdownTarget;
  input: NodeJS.ReadableStream;
  signals?: NodeJS.Signals[];
  onError?: (error: unknown) => void;
}): { request(reason: string): Promise<void>; dispose(): void } {
  let disposed = false;
  let closePromise: Promise<void> | undefined;
  const reader = createInterface({ input: options.input });
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    reader.close();
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
  };

  const request = (reason: string): Promise<void> => {
    if (closePromise) return closePromise;
    const pending = Promise.resolve()
      .then(() => options.target.close(reason))
      .then(() => undefined)
      .catch((error: unknown) => {
        process.exitCode = 1;
        try {
          options.onError?.(error);
        } catch {
          // Keep the original close failure as the rejection reason.
        }
        throw error;
      })
      .finally(dispose);
    closePromise = pending;
    return pending;
  };

  reader.on("line", (line) => {
    if (line.trim() !== MANAGER_SHUTDOWN_COMMAND) return;
    void request("manager").catch(() => undefined);
  });

  for (const signal of options.signals ?? ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      void request(signal.toLowerCase()).catch(() => undefined);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  return { request, dispose };
}
