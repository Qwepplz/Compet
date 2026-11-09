import { serverWorkerMain } from "../src/update/serverWorker.js";

void serverWorkerMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
  process.stderr.write("update_worker_failed\n"); process.exitCode = 1;
});
