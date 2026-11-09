import { assertNativeServerPlatform } from "./shared/serverPackageLayout.js";
import { loadConfig } from "./config/config.js";
import { runServer } from "./server/runServer.js";

void Promise.resolve().then(() => {
  assertNativeServerPlatform(process.platform, process.arch);
  return runServer(loadConfig());
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
