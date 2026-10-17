import path from "node:path";
import { assertServerRoots, type ServerLayout } from "../shared/serverPackageLayout.js";
import { isSemver } from "../shared/version.js";
import { z } from "zod";
import { DEFAULT_PROFILE_BASE_URL } from "../profiles/humanProfileIndex.js";
import { defaultPublicConnectHost } from "../shared/network.js";

export interface GameServerConfig {
  serverRoot: string;
  publicConnectHost: string;
  portRange: { start: number; end: number };
}

export interface ServerConfig {
  readonly requiredClientVersion: string;
  host: string;
  port: number;
  dataDir: string;
  tokenTtlMinutes: number;
  profileBaseUrl: string;
  gameServer: GameServerConfig;
}

const detectedPublicConnectHost = defaultPublicConnectHost();

export const serverConfigSchema = z.strictObject({
  requiredClientVersion: z.string().refine(isSemver, "Invalid SemVer"),
  host: z.string().min(1).default("0.0.0.0"),
  port: z.number().int().positive().max(65535).default(8443),
  dataDir: z.string().min(1),
  tokenTtlMinutes: z.number().int().positive().default(1440),
  profileBaseUrl: z.string().url().default(DEFAULT_PROFILE_BASE_URL),
  gameServer: z.strictObject({
    serverRoot: z.string(),
    publicConnectHost: z.string().min(1).default(detectedPublicConnectHost),
    portRange: z.strictObject({
      start: z.number().int().positive().max(65535).default(27015),
      end: z.number().int().positive().max(65535).default(27030),
    }).refine(range => range.end >= range.start, "Invalid port range"),
  }),
});

const numberFromEnv = (schema: z.ZodType<number>) =>
  z.preprocess(value => value === undefined ? undefined : Number(value), schema).default(schema.parse(undefined));
const gameSchema = serverConfigSchema.shape.gameServer.shape;
const envSchema = z.object({
  COMPET_REQUIRED_CLIENT_VERSION: serverConfigSchema.shape.requiredClientVersion,
  COMPET_HOST: serverConfigSchema.shape.host,
  COMPET_PORT: numberFromEnv(serverConfigSchema.shape.port),
  COMPET_DATA_DIR: serverConfigSchema.shape.dataDir.optional(),
  COMPET_TOKEN_TTL_MINUTES: numberFromEnv(serverConfigSchema.shape.tokenTtlMinutes),
  COMPET_PROFILE_BASE_URL: serverConfigSchema.shape.profileBaseUrl,
  COMPET_CSGO_SERVER_ROOT: gameSchema.serverRoot.default(""),
  COMPET_PUBLIC_CONNECT_HOST: gameSchema.publicConnectHost,
  COMPET_GAME_PORT_START: numberFromEnv(gameSchema.portRange.shape.start),
  COMPET_GAME_PORT_END: numberFromEnv(gameSchema.portRange.shape.end),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ServerConfig {
  const parsed = envSchema.parse(env);
  if (parsed.COMPET_GAME_PORT_END < parsed.COMPET_GAME_PORT_START) {
    throw new Error("COMPET_GAME_PORT_END must be greater than or equal to COMPET_GAME_PORT_START");
  }

  const dataDir = parsed.COMPET_DATA_DIR ?? path.join(cwd, "server-data");
  return serverConfigSchema.parse({
    requiredClientVersion: parsed.COMPET_REQUIRED_CLIENT_VERSION,
    host: parsed.COMPET_HOST,
    port: parsed.COMPET_PORT,
    dataDir: path.normalize(dataDir).replace(/\\/g, "/"),
    tokenTtlMinutes: parsed.COMPET_TOKEN_TTL_MINUTES,
    profileBaseUrl: parsed.COMPET_PROFILE_BASE_URL,
    gameServer: {
      serverRoot: parsed.COMPET_CSGO_SERVER_ROOT,
      publicConnectHost: parsed.COMPET_PUBLIC_CONNECT_HOST,
      portRange: {
        start: parsed.COMPET_GAME_PORT_START,
        end: parsed.COMPET_GAME_PORT_END,
      },
    },
  });
}

export function assertServerConfigPaths(config: ServerConfig, layout: ServerLayout): void {
  assertServerRoots({ platform: layout.platform, installRoot: layout.installRoot,
    dataDir: config.dataDir, serverRoot: config.gameServer.serverRoot });
}
