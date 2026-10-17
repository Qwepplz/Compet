import { spawnSync } from "node:child_process";
import { packageServer, parsePackageOptions } from "./package-server.js";
import { repositoryRoot } from "./build-sourcemod.js";

if (process.platform !== "win32") throw new Error("client_packaging_unsupported_on_this_host; use package:server:linux");
const options = parsePackageOptions(process.argv.slice(2));
await packageServer(options);
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run aggregate packaging through npm");
const result = spawnSync(process.execPath, [npm, "run", "package:client:build"], { cwd: repositoryRoot, stdio: "inherit", windowsHide: true });
if (result.error || result.status !== 0) throw new Error("client_packaging_failed");
