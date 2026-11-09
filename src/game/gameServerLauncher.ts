
import type { RunCsgoLaunchSpec } from "./runCsgoLaunchSpec.js";
import type { GameProcessIdentity } from "./linuxProcess.js";

export interface GameServerExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string[];
}

export interface LaunchedGameServer {
  pid?: number;
  wrapperPid?: number;
  identity?: GameProcessIdentity;
  port: number;
  clientPort: number;
  stop(): Promise<void>;
  getExitInfo(): GameServerExitInfo | undefined;
  waitForExit(): Promise<GameServerExitInfo>;
}

export interface GameServerLauncher {
  getIdentity?(serverRoot: string): GameProcessIdentity | undefined;
  launch(spec: RunCsgoLaunchSpec): Promise<LaunchedGameServer>;
}
