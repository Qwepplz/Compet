import { loadConfig } from "./config/config.js";
import { runServer } from "./server/runServer.js";

void Promise.resolve().then(() => runServer(loadConfig())).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
