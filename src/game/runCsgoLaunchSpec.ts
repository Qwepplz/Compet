import { existsSync } from "node:fs";
import path from "node:path";

import type { FileFingerprint } from "../shared/managedFiles.js";
import { assertNativeServerPlatform } from "../shared/serverPackageLayout.js";
import type { SourceServerExitMonitorSpec } from "./sourceServerMonitor.js";

const ENGINE_EXEC_MARKER_ENV = "COMPET_GAME_ENGINE_EXEC_MARKER";
const ATTEMPT_ID_ENV = "COMPET_GAME_ATTEMPT_ID";

interface EngineExecMarker {
  path: string;
  attemptId: string;
}

export interface RunCsgoLaunchInput {
  serverRoot: string;
  map: string;
  port: number;
  clientPort: number;
  engineExecMarker?: EngineExecMarker;
  launchScriptFingerprint?: FileFingerprint;
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
  engineExecMarker?: EngineExecMarker;
  launchScriptFingerprint?: FileFingerprint;
}

export function runCsgoLaunchEnvironment(env: NodeJS.ProcessEnv, marker?: EngineExecMarker): NodeJS.ProcessEnv {
  const cleaned = { ...env };
  delete cleaned.BASH_ENV;
  delete cleaned[ENGINE_EXEC_MARKER_ENV];
  delete cleaned[ATTEMPT_ID_ENV];
  if (marker) {
    for (const name of Object.keys(cleaned)) {
      if (name.startsWith("BASH_FUNC_")) delete cleaned[name];
    }
    delete cleaned.BASHOPTS;
    delete cleaned.SHELLOPTS;
    delete cleaned.ENV;
    cleaned[ENGINE_EXEC_MARKER_ENV] = marker.path;
    cleaned[ATTEMPT_ID_ENV] = marker.attemptId;
  }
  return cleaned;
}

export function buildRunCsgoLaunchSpec(input: RunCsgoLaunchInput): RunCsgoLaunchSpec {
  validateInput(input);
  assertNativeServerPlatform(process.platform, process.arch);
  const launchScriptPath = path.normalize(path.join(input.serverRoot, "run_csgo.sh"));
  if (!existsSync(launchScriptPath)) {
    throw new Error(`Missing run_csgo launch script: ${launchScriptPath}`);
  }

  const commonEnv = {
    ...runCsgoLaunchEnvironment(process.env, input.engineExecMarker),
    COMPET_CSGO_SERVER_ROOT: input.serverRoot,
    COMPET_GAME_MAP: input.map,
    COMPET_GAME_PORT: String(input.port),
    COMPET_GAME_CLIENT_PORT: String(input.clientPort),
  };

  return {
    command: "/bin/bash",
    args: [launchScriptPath],
    cwd: input.serverRoot,
    env: commonEnv,
    port: input.port,
    clientPort: input.clientPort,
    exitIndicatesServerExit: true,
    ...(input.engineExecMarker ? { engineExecMarker: input.engineExecMarker } : {}),
    ...(input.launchScriptFingerprint ? { launchScriptFingerprint: input.launchScriptFingerprint } : {}),
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
