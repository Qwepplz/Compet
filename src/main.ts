import { loadConfig } from "./config/config.js";
import { installGracefulShutdown } from "./server/gracefulShutdown.js";
import { createRuntime } from "./server/runtime.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await createRuntime(config);
  let shutdown: ReturnType<typeof installGracefulShutdown> | undefined;
  try {
    const address = await runtime.app.listen({ host: config.host, port: config.port });
    shutdown = installGracefulShutdown({
      target: runtime,
      input: process.stdin,
      signals: ["SIGINT", "SIGTERM"],
      onError: (error) => console.error("Graceful shutdown failed", error),
    });
    console.log(`Compet server listening at ${address}`);
  } catch (error) {
    shutdown?.dispose();
    await runtime.close("listen_failed").catch(() => undefined);
    throw error;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
