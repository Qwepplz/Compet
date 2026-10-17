import path from "node:path";
import { serverWorkerMain } from "../src/update/serverWorker.js";
import { legacyServerWorkerMain } from "../src/update/legacyServerWorker.js";

const args = process.argv.slice(2);
const plan = args[args.indexOf("--plan") + 1];
const run = plan && path.basename(plan) === "plan.txt" ? legacyServerWorkerMain : serverWorkerMain;
void run(args).then(code => { process.exitCode = code; }).catch(() => {
  process.stderr.write("update_worker_failed\n"); process.exitCode = 1;
});
