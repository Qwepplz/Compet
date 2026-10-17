import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, assertServerConfigPaths, type ServerConfig } from "../config/config.js";
import { parseManagerConfig } from "../manager/main/configStore.js";
import { readRequiredClientVersion } from "../manager/main/serviceProcess.js";
import type { ServerLayout } from "../shared/serverPackageLayout.js";
import { isSemver } from "../shared/version.js";
import { assertPlainPath } from "../desktop/main/serverManagedFiles.js";
import { updateFailure } from "./serverUpdateTypes.js";

export async function loadManagerServerConfig(input: { layout: ServerLayout; configPath: string; requiredClientVersion?: string }): Promise<ServerConfig> {
  if (input.layout.platform !== "win32-x64" || input.configPath !== path.join(input.layout.appRoot, "user-data/manager-config.json")) updateFailure("maintenance_config_invalid");
  await assertPlainPath(input.configPath);
  const bytes = await fs.readFile(input.configPath);
  if (bytes.length > 1024 * 1024) updateFailure("maintenance_config_invalid");
  const manager = parseManagerConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), input.layout.appRoot);
  const requiredClientVersion = input.requiredClientVersion ?? await readRequiredClientVersion(input.layout.appRoot, true);
  if (!isSemver(requiredClientVersion)) updateFailure("maintenance_config_invalid");
  const config = loadConfig({ ...process.env, COMPET_REQUIRED_CLIENT_VERSION: requiredClientVersion,
    COMPET_HOST: manager.host, COMPET_PORT: String(manager.port), COMPET_DATA_DIR: manager.dataDir,
    COMPET_TOKEN_TTL_MINUTES: String(manager.tokenTtlMinutes), COMPET_CSGO_SERVER_ROOT: manager.serverRoot,
    COMPET_PUBLIC_CONNECT_HOST: manager.publicConnectHost, COMPET_GAME_PORT_START: String(manager.gamePortStart), COMPET_GAME_PORT_END: String(manager.gamePortEnd) });
  assertServerConfigPaths(config, input.layout);
  return config;
}
