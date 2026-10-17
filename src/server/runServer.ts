import type { ServerConfig } from "../config/config.js";
import type { ServerLayout } from "../shared/serverPackageLayout.js";
import { installGracefulShutdown } from "./gracefulShutdown.js";
import { createRuntime } from "./runtime.js";

export async function runServer(config: ServerConfig, layout?: ServerLayout): Promise<void> {
  const runtime = await createRuntime(config, layout);
  let shutdown: ReturnType<typeof installGracefulShutdown> | undefined;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  try {
    const address = await runtime.app.listen({ host: config.host, port: config.port });
    shutdown = installGracefulShutdown({
      target: { close: async reason => {
        try { const summary = await runtime.close(reason); resolveClosed(); return summary; }
        catch (error) { rejectClosed(error); throw error; }
      } },
      input: process.stdin,
      signals: ["SIGINT", "SIGTERM"],
      onError: error => console.error("Graceful shutdown failed", error),
    });
    console.log(`Compet server listening at ${address}`);
  } catch (error) {
    shutdown?.dispose();
    await runtime.close("listen_failed").catch(() => undefined);
    throw error;
  }
  try { await closed; } finally { shutdown.dispose(); }
}
