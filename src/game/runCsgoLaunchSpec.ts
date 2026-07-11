import { existsSync } from "node:fs";
import path from "node:path";

import type { SourceServerExitMonitorSpec } from "./sourceServerMonitor.js";

export interface RunCsgoLaunchInput {
  serverRoot: string;
  map: string;
  port: number;
  clientPort: number;
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

const RUN_CSGO_LAUNCH_SCRIPT = "run_csgo.ps1";

export function buildRunCsgoLaunchSpec(input: RunCsgoLaunchInput): RunCsgoLaunchSpec {
  validateInput(input);
  const launchScriptPath = path.normalize(path.join(input.serverRoot, RUN_CSGO_LAUNCH_SCRIPT));
  if (!existsSync(launchScriptPath)) {
    throw new Error(`Missing run_csgo launch script: ${launchScriptPath}`);
  }

  const commonEnv = {
    ...process.env,
    COMPET_CSGO_SERVER_ROOT: input.serverRoot,
    COMPET_GAME_MAP: input.map,
    COMPET_GAME_PORT: String(input.port),
    COMPET_GAME_CLIENT_PORT: String(input.clientPort),
  };

  return {
    command: process.platform === "win32" ? "powershell.exe" : "pwsh",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launchScriptPath],
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

function validateInput(input: RunCsgoLaunchInput): void {
  requireNonEmpty("serverRoot", input.serverRoot);
  requireNonEmpty("map", input.map);
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
