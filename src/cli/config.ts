import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, serverConfigSchema, type ServerConfig } from "../config/config.js";
import { assertServerRoots, type ServerPlatform } from "../shared/serverPackageLayout.js";

function invalid(code: string): never {
  throw Object.assign(new Error(code), { code });
}

export const HEADLESS_TEMPLATE_SERVER_ROOT = "REPLACE_WITH_ABSOLUTE_GAME_SERVER_ROOT";
export const HEADLESS_TEMPLATE_CONNECT_HOST = "REPLACE_WITH_PLAYER_REACHABLE_HOST";

export async function loadHeadlessConfig(input: {
  configPath: string; env: NodeJS.ProcessEnv;
}): Promise<ServerConfig> {
  if (!path.isAbsolute(input.configPath)) invalid("config_path_invalid");
  let bytes: Buffer;
  try { bytes = await fs.readFile(input.configPath); }
  catch (error) {
    invalid((error as NodeJS.ErrnoException).code === "ENOENT" ? "config_missing" : "config_read_failed");
  }
  try {
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const base = serverConfigSchema.extend({ requiredClientVersion: serverConfigSchema.shape.requiredClientVersion.optional() }).parse(raw);
    const values: NodeJS.ProcessEnv = {
      COMPET_REQUIRED_CLIENT_VERSION: base.requiredClientVersion,
      COMPET_HOST: base.host, COMPET_PORT: String(base.port), COMPET_DATA_DIR: base.dataDir,
      COMPET_TOKEN_TTL_MINUTES: String(base.tokenTtlMinutes),
      COMPET_PROFILE_BASE_URL: base.profileBaseUrl,
      COMPET_CSGO_SERVER_ROOT: base.gameServer.serverRoot,
      COMPET_PUBLIC_CONNECT_HOST: base.gameServer.publicConnectHost,
      COMPET_GAME_PORT_START: String(base.gameServer.portRange.start),
      COMPET_GAME_PORT_END: String(base.gameServer.portRange.end),
    };
    for (const key of Object.keys(values)) {
      if (input.env[key] !== undefined) values[key] = input.env[key];
    }
    if (values.COMPET_CSGO_SERVER_ROOT?.trim() === HEADLESS_TEMPLATE_SERVER_ROOT
      || values.COMPET_PUBLIC_CONNECT_HOST?.trim() === HEADLESS_TEMPLATE_CONNECT_HOST) {
      invalid("config_invalid");
    }
    if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform)) invalid("config_invalid");
    const platform = (process.platform + "-x64") as ServerPlatform;
    assertServerRoots({ platform, dataDir: values.COMPET_DATA_DIR!, serverRoot: values.COMPET_CSGO_SERVER_ROOT! });
    return loadConfig(values);
  } catch { invalid("config_invalid"); }
}
