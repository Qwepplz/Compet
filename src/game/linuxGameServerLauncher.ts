import path from "node:path";
import { delay } from "../shared/async.js";
import type { GameServerLauncher, GameServerExitInfo, LaunchedGameServer } from "./gameServerLauncher.js";
import type { RunCsgoLaunchSpec } from "./runCsgoLaunchSpec.js";
import { findLinuxGameProcess, inspectLinuxProcessUdpPort, inspectLinuxUdpPort, probeLinuxGameProcess, type GameProcessIdentity } from "./linuxProcess.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

export class LinuxGameServerLauncher implements GameServerLauncher {
  private readonly identities = new Map<string, GameProcessIdentity>();
  getIdentity(serverRoot: string): GameProcessIdentity | undefined { return this.identities.get(path.resolve(serverRoot)); }
  constructor(private readonly options: { onStdout?: (text: string) => void; startupTimeoutMs?: number } = {}) {}

  async launch(spec: RunCsgoLaunchSpec): Promise<LaunchedGameServer> {
    if (process.platform !== "linux") fail("game_platform_unsupported");
    if (await inspectLinuxUdpPort(spec.port) !== "free") fail("game_port_busy");
    const pty = await import("node-pty");
    const env = Object.fromEntries(Object.entries(spec.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const child = pty.spawn(spec.command, spec.args, { cwd: spec.cwd, env, cols: 120, rows: 40, name: "xterm" });
    const output: string[] = [];
    let wrapperExit: { exitCode: number; signal?: number } | undefined;
    const dataListener = child.onData(text => {
      output.push(text); if (output.length > 200) output.shift();
      this.options.onStdout?.(text);
    });
    const exitListener = child.onExit(info => { wrapperExit = info; });
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 60_000);
    let identity;
    while (Date.now() < deadline) {
      identity = await findLinuxGameProcess(child.pid, spec.cwd);
      if (identity) this.identities.set(path.resolve(spec.cwd), identity);
      if (identity && await inspectLinuxProcessUdpPort(identity, spec.port) === "owned") break;
      if (wrapperExit) break;
      await delay(50);
    }
    if (!identity || await inspectLinuxProcessUdpPort(identity, spec.port) !== "owned") {
      // The wrapper or an unknown child may still own the terminal. Do not terminate it
      // without a complete game identity; recovery must retain the pending match.
      fail("game_process_not_observed");
    }
    const ownedIdentity = identity;
    let exitInfo: GameServerExitInfo | undefined;
    let requestedSignal: NodeJS.Signals | null = null;
    const exitPromise = (async (): Promise<GameServerExitInfo> => {
      for (;;) {
        if (await probeLinuxGameProcess(ownedIdentity) === "gone" && await inspectLinuxUdpPort(spec.port) === "free") {
          exitInfo = { code: wrapperExit?.exitCode ?? null,
            signal: requestedSignal ?? (wrapperExit?.signal === 15 ? "SIGTERM" : null), output: [...output] };
          dataListener.dispose(); exitListener.dispose();
          return exitInfo;
        }
        await delay(100);
      }
    })();
    return {
      pid: identity.pid, wrapperPid: child.pid, identity: ownedIdentity,
      port: spec.port, clientPort: spec.clientPort,
      getExitInfo: () => exitInfo,
      waitForExit: () => exitPromise,
      stop: async () => {
        const state = await probeLinuxGameProcess(ownedIdentity);
        if (state === "unknown") fail("game_process_not_owned");
        if (state === "alive") { requestedSignal = "SIGTERM"; process.kill(ownedIdentity.pid, "SIGTERM"); }
        const stopDeadline = Date.now() + 5_000;
        while (!exitInfo && Date.now() < stopDeadline) await delay(50);
        if (!exitInfo) fail("game_shutdown_timeout");
      },
    };
  }
}
