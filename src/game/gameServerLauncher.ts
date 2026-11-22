
import type { RunCsgoLaunchSpec } from "./runCsgoLaunchSpec.js";
import type { GameProcessIdentity } from "./linuxProcess.js";

export interface GameServerExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  signalNumber?: number;
  wrapperExitUnconfirmed?: true;
  startupFailure?: "before_engine_exec" | "invalid_configuration";
  get5TakeoverLogged?: boolean;
  output: string[];
}

export class GameServerStartupExitError extends Error {
  readonly code = "game_process_not_observed";

  constructor(readonly exitInfo: GameServerExitInfo) {
    super("game_process_not_observed");
  }
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

export type GameServerStartupState = GameServerExitInfo | "pending" | "owned";

export interface GameServerLauncher {
  getIdentity?(serverRoot: string): GameProcessIdentity | undefined;
  inspectPendingStartupExit?(serverRoot: string, attemptId: string): Promise<GameServerStartupState | undefined>;
  launch(spec: RunCsgoLaunchSpec): Promise<LaunchedGameServer>;
}
