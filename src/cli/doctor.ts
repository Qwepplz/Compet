import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { assertServerConfigPaths, type ServerConfig } from "../config/config.js";
import type { ServerLayout } from "../shared/serverPackageLayout.js";
import { resolveMysqlTools } from "../shared/mysqlCli.js";
import { parseRankmeDatabaseConfig } from "../rankme/rankmeScoreStore.js";

export interface DoctorReport {
  ok: boolean;
  checks: { code: string; status: "passed" | "failed" | "unknown"; detail?: string }[];
}

const execute = promisify(execFile);

export async function inspectServerEnvironment(input: {
  config: ServerConfig; layout: ServerLayout;
}): Promise<DoctorReport> {
  const checks: DoctorReport["checks"] = [];
  const add = (code: string, status: "passed" | "failed" | "unknown", detail?: string) =>
    checks.push({ code, status, ...(detail ? { detail } : {}) });
  try { assertServerConfigPaths(input.config, input.layout); add("configuration_valid", "passed"); }
  catch { add("configuration_invalid", "failed"); }
  async function inspect(absolute: string, kind: "file" | "directory", prefix: string, executable = false) {
    try {
      const info = await fs.lstat(absolute);
      if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory())) {
        add(prefix + "_invalid", "failed"); return false;
      }
      await fs.access(absolute, constants.R_OK | (executable ? constants.X_OK : 0));
      add(prefix + "_available", "passed"); return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      add(prefix + (code === "ENOENT" ? "_unavailable" : "_check_failed"), code === "ENOENT" ? "failed" : "unknown");
      return false;
    }
  }
  const linux = input.layout.platform === "linux-x64";
  const runtimeAvailable = await inspect(input.layout.nodePath, "file", "runtime", linux);
  if (runtimeAvailable) {
    if (process.platform + "-" + process.arch !== input.layout.platform) add("runtime_platform_mismatch", "failed");
    else {
      const script = [
        "const {createRequire}=require('node:module');",
        "const requireApp=createRequire(process.argv[1]);",
        "(async()=>{",
        "if(Number(process.versions.node.split('.')[0])<24)throw Error();",
        "const {DatabaseSync,backup}=require('node:sqlite');const db=new DatabaseSync(':memory:');",
        "try{if(db.isTransaction!==false||typeof backup!=='function')throw Error();",
        "db.exec('BEGIN');if(!db.isTransaction)throw Error();db.exec('ROLLBACK');}finally{db.close();}",
        "const argon=requireApp('argon2');if(!await argon.verify(await argon.hash('probe'),'probe'))throw Error();",
        ...(linux ? ["requireApp('node-pty');"] : []),
        "console.log(JSON.stringify({node:process.versions.node,sqlite:process.versions.sqlite,abi:process.versions.modules}));",
        "})().catch(()=>{process.exitCode=1});",
      ].join("");
      const env = { ...process.env };
      delete env.NODE_OPTIONS; delete env.NODE_PATH;
      try {
        const result = await execute(input.layout.nodePath, ["-e", script, path.join(input.layout.appRoot, "package.json")],
          { env, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
        const versions = JSON.parse(result.stdout) as { node: string; sqlite: string; abi: string };
        add("runtime_capabilities_valid", "passed", "Node " + versions.node + "; SQLite " + versions.sqlite + "; ABI " + versions.abi);
      } catch { add("runtime_capabilities_failed", "failed"); }
    }
  }
  await inspect(input.config.gameServer.serverRoot, "directory", "game_root");
  for (const relative of [linux ? "srcds_run" : "srcds.exe",
    "csgo/addons/sourcemod/configs/core.cfg", "csgo/addons/sourcemod/configs/databases.cfg"]) {
    await inspect(path.join(input.config.gameServer.serverRoot, relative), "file",
      relative === "srcds_run" || relative === "srcds.exe" ? "game_entry" : relative.endsWith("core.cfg") ? "sourcemod_config" : "mysql_config",
      relative === "srcds_run");
  }
  if (linux) {
    await inspect(path.join(input.config.gameServer.serverRoot, "srcds_linux"), "file", "game_binary", true);
    try {
      await execute("script", ["--version"], { windowsHide: true, timeout: 5_000, maxBuffer: 4096 });
      add("preinit_terminal_available", "passed");
    } catch { add("preinit_terminal_unavailable", "failed"); }
  }
  try {
    const tools = await resolveMysqlTools({ platform: input.layout.platform });
    add("mysql_tools_available", "passed");
    const configPath = path.join(input.config.gameServer.serverRoot, "csgo/addons/sourcemod/configs/databases.cfg");
    let database;
    try { database = parseRankmeDatabaseConfig(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(configPath))); }
    catch { add("database_permissions_not_checked", "unknown"); }
    if (database) {
      try {
        const result = await execute(tools.mysql, ["--batch", "--raw", "--skip-column-names",
          "--host=" + database.host, "--port=" + database.port, "--user=" + database.user,
          "--database=" + database.database, "--execute=SELECT 1; SHOW GRANTS FOR CURRENT_USER"],
          { env: { ...process.env, MYSQL_PWD: database.password }, windowsHide: true,
            timeout: 10_000, maxBuffer: 64 * 1024 });
        if (!/^1\r?\n/.test(result.stdout)) throw new Error("mysql_probe_invalid");
        add("mysql_readonly_connection_valid", "passed");
        add("mysql_grants_readable", "passed");
      } catch { add("mysql_readonly_connection_failed", "failed"); }
    } else if (!checks.some(check => check.code === "database_permissions_not_checked")) add("mysql_config_invalid", "failed");
  } catch (error) {
    const reason = (error as { reasonCode?: string }).reasonCode;
    add("mysql_tools_unavailable", reason === "EACCES" || reason === "EPERM" ? "unknown" : "failed");
    add("database_permissions_not_checked", "unknown");
  }
  return { ok: checks.every(check => check.status === "passed"), checks };
}
