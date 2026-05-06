import path from "node:path";
import { z } from "zod";
import { defaultPublicConnectHost } from "../shared/network.js";

export interface GameServerConfig {
  serverRoot: string;
  publicConnectHost: string;
  portRange: { start: number; end: number };
}

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  tokenTtlMinutes: number;
  gameServer: GameServerConfig;
}

const positiveInt = z.coerce.number().int().positive();
const detectedPublicConnectHost = defaultPublicConnectHost();

const envSchema = z.object({
  COMPET_HOST: z.string().min(1).default("0.0.0.0"),
  COMPET_PORT: positiveInt.max(65535).default(8443),
  COMPET_DATA_DIR: z.string().min(1).optional(),
  COMPET_TOKEN_TTL_MINUTES: positiveInt.default(1440),
  COMPET_CSGO_SERVER_ROOT: z.string().default(""),
  COMPET_PUBLIC_CONNECT_HOST: z.string().min(1).default(detectedPublicConnectHost),
  COMPET_GAME_PORT_START: positiveInt.max(65535).default(27015),
  COMPET_GAME_PORT_END: positiveInt.max(65535).default(27030),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ServerConfig {
  const parsed = envSchema.parse(env);
  if (parsed.COMPET_GAME_PORT_END < parsed.COMPET_GAME_PORT_START) {
    throw new Error("COMPET_GAME_PORT_END must be greater than or equal to COMPET_GAME_PORT_START");
  }

  const dataDir = parsed.COMPET_DATA_DIR ?? path.join(cwd, "server-data");
  return {
    host: parsed.COMPET_HOST,
    port: parsed.COMPET_PORT,
    dataDir: path.normalize(dataDir).replace(/\\/g, "/"),
    tokenTtlMinutes: parsed.COMPET_TOKEN_TTL_MINUTES,
    gameServer: {
      serverRoot: parsed.COMPET_CSGO_SERVER_ROOT,
      publicConnectHost: parsed.COMPET_PUBLIC_CONNECT_HOST,
      portRange: {
        start: parsed.COMPET_GAME_PORT_START,
        end: parsed.COMPET_GAME_PORT_END,
      },
    },
  };
}
