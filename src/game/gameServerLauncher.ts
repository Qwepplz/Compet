import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { RunCsgoLaunchSpec } from "./runCsgoLaunchSpec.js";

export interface GameServerExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string[];
}

export interface LaunchedGameServer {
  pid?: number;
  port: number;
  clientPort: number;
  stop(): Promise<void>;
  getExitInfo(): GameServerExitInfo | undefined;
  waitForExit(): Promise<GameServerExitInfo>;
}

export interface GameServerLauncher {
  launch(spec: RunCsgoLaunchSpec): Promise<LaunchedGameServer>;
}

export interface NodeGameServerLauncherOptions {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  startupGraceMs?: number;
}

const DEFAULT_STARTUP_GRACE_MS = 1_500;

export class NodeGameServerLauncher implements GameServerLauncher {
  constructor(private readonly options: NodeGameServerLauncherOptions = {}) {}

  async launch(spec: RunCsgoLaunchSpec): Promise<LaunchedGameServer> {
    const recentOutput: string[] = [];
    const pushOutput = (chunk: string) => {
      recentOutput.push(chunk);
      if (recentOutput.length > 200) {
        recentOutput.shift();
      }
    };
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: false,
    });
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      pushOutput(text);
      this.options.onStdout?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      pushOutput(text);
      this.options.onStderr?.(text);
    });

    return new Promise<LaunchedGameServer>((resolve, reject) => {
      let settled = false;
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      let launched: LaunchedGameServer | undefined;

      const cleanupStartupListeners = () => {
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = undefined;
        }
        child.removeListener("error", onError);
        child.removeListener("spawn", onSpawn);
        child.removeListener("close", onEarlyClose);
      };

      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupStartupListeners();
        reject(error);
      };
      const onEarlyClose = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanupStartupListeners();
        if (code === 0 && signal === null && launched) {
          resolve(launched);
          return;
        }
        reject(new Error(formatStartupExit(code, signal, recentOutput)));
      };
      const onSpawn = () => {
        launched = new NodeLaunchedGameServer({
          child,
          port: spec.port,
          clientPort: spec.clientPort,
          recentOutput,
        });
        child.on("error", (error: Error) => this.options.onStderr?.(String(error)));
        startupTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanupStartupListeners();
          resolve(launched!);
        }, this.options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS);
      };

      child.once("error", onError);
      child.once("spawn", onSpawn);
      child.once("close", onEarlyClose);
    });
  }
}

function formatStartupExit(code: number | null, signal: NodeJS.Signals | null, output: string[]): string {
  const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
  const recentOutput = output.join("").trim();
  return [
    `Game server launch process exited during startup with ${status}.`,
    ...(recentOutput ? [`Recent output:\n${recentOutput}`] : []),
  ].join("\n");
}

class NodeLaunchedGameServer implements LaunchedGameServer {
  public readonly pid?: number;
  public readonly port: number;
  public readonly clientPort: number;
  private exitInfo?: GameServerExitInfo;
  private readonly exitInfoPromise: Promise<GameServerExitInfo>;

  constructor(
    private readonly input: {
      child: ChildProcessWithoutNullStreams;
      port: number;
      clientPort: number;
      recentOutput: string[];
    },
  ) {
    this.pid = input.child.pid;
    this.port = input.port;
    this.clientPort = input.clientPort;
    this.exitInfoPromise = new Promise<GameServerExitInfo>((resolve) => {
      const resolveExit = (code: number | null, signal: NodeJS.Signals | null) => {
        this.exitInfo = {
          code,
          signal,
          output: [...this.input.recentOutput],
        };
        resolve(this.exitInfo);
      };

      if (this.input.child.exitCode !== null || this.input.child.signalCode !== null) {
        resolveExit(this.input.child.exitCode, this.input.child.signalCode);
        return;
      }

      this.input.child.once("exit", resolveExit);
    });
  }

  async stop(): Promise<void> {
    if (this.input.child.exitCode !== null || this.input.child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.input.child.kill("SIGKILL");
        resolve();
      }, 5_000);

      this.input.child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.input.child.kill("SIGTERM");
    });
  }

  getExitInfo(): GameServerExitInfo | undefined {
    return this.exitInfo;
  }

  waitForExit(): Promise<GameServerExitInfo> {
    return this.exitInfoPromise;
  }
}
