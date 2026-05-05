import { existsSync } from "node:fs";
import path from "node:path";

import type { SourceServerExitMonitorSpec } from "./sourceServerMonitor.js";

export interface RunCsgoLaunchInput {
  serverRoot: string;
  map: string;
  port: number;
  clientPort: number;
  serverPassword: string;
  startupCfgPath?: string;
}

export interface RunCsgoLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  port: number;
  clientPort: number;
  exitIndicatesServerExit: boolean;
  serverExitMonitor?: SourceServerExitMonitorSpec;
}

export function buildRunCsgoLaunchSpec(input: RunCsgoLaunchInput): RunCsgoLaunchSpec {
  validateInput(input);
  const mapBatPath = path.normalize(path.join(input.serverRoot, `${input.map}.bat`));
  if (!existsSync(mapBatPath)) {
    throw new Error(`Missing map launch bat for ${input.map}: ${mapBatPath}`);
  }

  const commonEnv = {
    ...process.env,
    COMPET_CSGO_SERVER_ROOT: input.serverRoot,
    COMPET_MATCH_CFG: input.startupCfgPath ?? "",
    COMPET_GAME_MAP: input.map,
    COMPET_GAME_PORT: String(input.port),
    COMPET_GAME_CLIENT_PORT: String(input.clientPort),
    COMPET_GAME_PASSWORD: input.serverPassword,
  };

  return {
    command: process.platform === "win32" ? "powershell.exe" : mapBatPath,
    args: process.platform === "win32"
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `& '${escapePowerShellSingleQuoted(mapBatPath)}'`]
      : [],
    cwd: input.serverRoot,
    env: commonEnv,
    port: input.port,
    clientPort: input.clientPort,
    exitIndicatesServerExit: false,
    serverExitMonitor: {
      host: "127.0.0.1",
      port: input.port,
      intervalMs: 1_000,
      queryTimeoutMs: 750,
      missedResponsesBeforeExit: 3,
      startupObservationTimeoutMs: 60_000,
    },
  };
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function validateInput(input: RunCsgoLaunchInput): void {
  requireNonEmpty("serverRoot", input.serverRoot);
  requireNonEmpty("map", input.map);
  requireNonEmpty("serverPassword", input.serverPassword);
  requireValidPort("port", input.port);
  requireValidPort("clientPort", input.clientPort);
}

function requireNonEmpty(name: string, value: string): void {
  if (value.trim() === "") {
    throw new Error(`${name} must not be empty`);
  }
}

function requireValidPort(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid TCP/UDP port`);
  }
}
