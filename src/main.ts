import { loadConfig } from "./config/config.js";
import { createRuntime } from "./server/runtime.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await createRuntime(config);
  const address = await runtime.app.listen({ host: config.host, port: config.port });

  console.log(`Compet server listening at ${address}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
