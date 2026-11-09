import fs from "node:fs/promises";
import { constants } from "node:fs";
import childProcess from "node:child_process";
import path from "node:path";
import type { ServerPlatform } from "./serverPackageLayout.js";

export interface MysqlToolsInput {
  platform: ServerPlatform;
  mysqlPath?: string;
  mysqldumpPath?: string;
}

function fail(code: string, reasonCode?: string): never {
  throw Object.assign(new Error(code), { code, ...(reasonCode ? { reasonCode } : {}) });
}

export async function resolveMysqlTool(input: {
  platform: ServerPlatform; tool: "mysql" | "mysqldump"; explicitPath?: string; mysqlPath?: string;
}): Promise<string> {
  if (input.platform !== "linux-x64") fail("mysql_platform_unsupported");
  const api = path.posix;
  if (input.explicitPath !== undefined && (!api.isAbsolute(input.explicitPath) ||
      input.explicitPath.includes("\\"))) fail("mysql_tool_path_invalid");
  const name = input.tool;
  const directories = (process.env.PATH ?? "").split(":")
    .map(value => value.replace(/^"(.*)"$/, "$1")).filter(value => api.isAbsolute(value));
  const candidates = input.explicitPath !== undefined ? [input.explicitPath] : [
    ...(input.tool === "mysqldump" && input.mysqlPath ? [api.join(api.dirname(input.mysqlPath), name)] : []),
    ...directories.map(directory => api.join(directory, name)),
  ];
  let reasonCode: string | undefined;
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, constants.R_OK | constants.X_OK);
      const absolute = await fs.realpath(candidate);
      const stdout = await new Promise<string>((resolve, reject) => {
        childProcess.execFile(absolute, ["--version"], { windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 16 * 1024 },
          (error, output) => error ? reject(error) : resolve(output));
      });
      if (!/\bmysql(?:dump)?(?:\.exe)?\s+Ver\s+[0-9]+\.[0-9]+/i.test(stdout)) { reasonCode = "version_probe_failed"; continue; }
      return absolute;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") reasonCode = code;
      else if (code !== "ENOENT") reasonCode ??= "version_probe_failed";
    }
  }
  fail("mysql_tool_unavailable", reasonCode);
}

export async function resolveMysqlTools(input: MysqlToolsInput): Promise<{ mysql: string; mysqldump: string }> {
  const mysql = await resolveMysqlTool({ platform: input.platform, tool: "mysql", explicitPath: input.mysqlPath });
  const mysqldump = await resolveMysqlTool({ platform: input.platform, tool: "mysqldump",
    explicitPath: input.mysqldumpPath, mysqlPath: mysql });
  return { mysql, mysqldump };
}
