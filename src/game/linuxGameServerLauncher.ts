import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { constants } from "node:os";
import { delay } from "../shared/async.js";
import { assertPlainPath, sameFingerprint } from "../shared/managedFiles.js";
import { gameServerAttemptSchema } from "./gameServerAttempt.js";
import { GameServerStartupExitError, type GameServerLauncher, type GameServerExitInfo, type GameServerStartupState, type LaunchedGameServer } from "./gameServerLauncher.js";
import { runCsgoLaunchEnvironment, type RunCsgoLaunchSpec } from "./runCsgoLaunchSpec.js";
import {
  findLinuxGameProcess, inspectLinuxGameProcessIdentity, inspectLinuxGameRoot, inspectLinuxProcessUdpPort,
  inspectLinuxUdpPort, probeLinuxGameProcess, readLinuxProcessIdentity, type GameProcessIdentity,
} from "./linuxProcess.js";

const WRAPPER_EXIT_GRACE_MS = 1_000;
const signalNames = new Map(Object.entries(constants.signals).map(
  ([name, number]) => [number, name as NodeJS.Signals],
));

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

type StartupProbe = { attemptId: string; inspect(): Promise<GameServerStartupState> };

async function markerParentIdentity(file: string): Promise<string> {
  const directory = path.dirname(file);
  await assertPlainPath(directory);
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory()) fail("game_engine_exec_marker_conflict");
  return [info.dev, info.ino, info.mtimeNs, info.ctimeNs].join(":");
}

async function markerMissing(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function checkedStartupWrapper(spec: RunCsgoLaunchSpec): Promise<{
  args: string[]; marker?: { path: string; attemptId: string; parent: string };
}> {
  const { engineExecMarker: marker, launchScriptFingerprint: fingerprint } = spec;
  if (!marker || !fingerprint) return { args: spec.args };
  const script = path.join(spec.cwd, "run_csgo.sh");
  if (spec.command !== "/bin/bash" || spec.args.length !== 1 || spec.args[0] !== script) fail("game_startup_wrapper_not_verified");
  await assertPlainPath(script);
  const info = await lstat(script);
  if (!info.isFile() || info.nlink !== 1 || info.size !== fingerprint.size || info.size > 64 * 1024) {
    fail("game_startup_wrapper_not_verified");
  }
  const source = await readFile(script);
  if (!sameFingerprint({ size: source.length, sha256: createHash("sha256").update(source).digest("hex") }, fingerprint)) {
    fail("game_startup_wrapper_not_verified");
  }
  const text = source.toString("utf8");
  if (!text.split("\n", 64).includes("# COMPET_GAME_ENGINE_EXEC_MARKER protocol 1")) return { args: spec.args };
  if (!path.isAbsolute(marker.path) || path.resolve(marker.path) !== marker.path || path.basename(marker.path) !== "engine-exec" ||
      path.basename(path.dirname(marker.path)) !== marker.attemptId || !gameServerAttemptSchema.shape.id.safeParse(marker.attemptId).success) {
    fail("game_engine_exec_marker_conflict");
  }
  const parent = await markerParentIdentity(marker.path);
  if (!await markerMissing(marker.path)) fail("game_engine_exec_marker_conflict");
  // Run the exact bytes checked against the managed asset. The script uses $0 for its root in this mode.
  return { args: ["-c", text, script], marker: { ...marker, parent } };
}

export class LinuxGameServerLauncher implements GameServerLauncher {
  private readonly identities = new Map<string, GameProcessIdentity>();
  private readonly startupExits = new Map<string, StartupProbe>();

  constructor(private readonly options: { onStdout?: (text: string) => void; startupTimeoutMs?: number } = {}) {}

  getIdentity(serverRoot: string): GameProcessIdentity | undefined { return this.identities.get(path.resolve(serverRoot)); }

  async inspectPendingStartupExit(serverRoot: string, attemptId: string): Promise<GameServerStartupState | undefined> {
    const root = path.resolve(serverRoot);
    const startup = this.startupExits.get(root);
    if (!startup || startup.attemptId !== attemptId) return undefined;
    const result = await startup.inspect();
    if (typeof result === "object" && this.startupExits.get(root) === startup) this.startupExits.delete(root);
    return result;
  }

  async launch(spec: RunCsgoLaunchSpec): Promise<LaunchedGameServer> {
    if (process.platform !== "linux") fail("game_platform_unsupported");
    const root = path.resolve(spec.cwd);
    if (this.startupExits.has(root)) fail("game_startup_exit_pending");
    this.identities.delete(root);
    if (await inspectLinuxUdpPort(spec.port) !== "free") fail("game_port_busy");
    const wrapper = await checkedStartupWrapper(spec);
    const pty = await import("node-pty");
    const launchEnv = runCsgoLaunchEnvironment(spec.env, wrapper.marker);
    const env = Object.fromEntries(Object.entries(launchEnv).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const attemptId = spec.engineExecMarker?.attemptId;
    const startupRootIsFree = async () =>
      await inspectLinuxGameRoot(spec.cwd) === "gone" && await inspectLinuxUdpPort(spec.port) === "free";
    let child;
    try {
      child = pty.spawn(spec.command, wrapper.args, { cwd: spec.cwd, env, cols: 120, rows: 40, name: "xterm" });
    } catch (error) {
      if (attemptId) {
        // node-pty 1.1.0 uses this exact error only when forkpty returned -1.
        const failure = error instanceof Error && error.message === "forkpty(3) failed." ? error.message : undefined;
        this.startupExits.set(root, { attemptId, inspect: async () => {
          if (!failure || !await startupRootIsFree()) return "pending";
          return { code: null, signal: null, startupFailure: "before_engine_exec", output: [failure] };
        } });
        const exitInfo = await this.inspectPendingStartupExit(root, attemptId);
        if (typeof exitInfo === "object") throw new GameServerStartupExitError(exitInfo);
      }
      throw error;
    }
    const output: string[] = [];
    let wrapperExit: { exitCode: number; signal?: number } | undefined;
    const dataListener = child.onData(text => {
      output.push(text); if (output.length > 200) output.shift();
      this.options.onStdout?.(text);
    });
    let notifyWrapperExit!: () => void;
    const wrapperExited = new Promise<void>(resolve => { notifyWrapperExit = resolve; });
    const exitListener = child.onExit(info => {
      wrapperExit = info;
      notifyWrapperExit();
    });
    const dispose = () => { dataListener.dispose(); exitListener.dispose(); };
    const readExitInfo = (requestedSignal: NodeJS.Signals | null = null): GameServerExitInfo => {
      const signalNumber = wrapperExit?.signal;
      const signal = signalNumber ? signalNames.get(signalNumber) : undefined;
      return {
        code: wrapperExit?.exitCode ?? null,
        signal: signal ?? requestedSignal,
        ...(signalNumber && !signal ? { signalNumber } : {}),
        ...(!wrapperExit ? { wrapperExitUnconfirmed: true as const } : {}),
        output: [...output],
      };
    };

    let lastIdentity: GameProcessIdentity | undefined;
    if (attemptId) {
      const readWrapper = () => readLinuxProcessIdentity(child.pid, spec.cwd).catch(() => undefined);
      const originalWrapper = await readWrapper();
      let observedExit: GameServerExitInfo | undefined;
      const startup: StartupProbe = { attemptId, inspect: async () => {
        if (observedExit) return observedExit;
        if (lastIdentity) {
          const state = await inspectLinuxGameProcessIdentity(lastIdentity);
          if (state === "alive") return "owned";
          if (state === "unknown") return "pending";
        }
        if (!wrapperExit) {
          const game = originalWrapper && await findLinuxGameProcess(child.pid, spec.cwd);
          if (!game) return "pending";
          const current = await readWrapper();
          // forkpty can return before the child establishes its own process group.
          if (!wrapperExit && current?.startTimeTicks === originalWrapper.startTimeTicks &&
              this.startupExits.get(root) === startup) {
            lastIdentity = game;
            this.identities.set(root, game);
            return "owned";
          }
          return "pending";
        }
        if (!await startupRootIsFree()) return "pending";
        const result = readExitInfo();
        const abnormal = (result.code !== null && result.code !== 0) || result.signal !== null || result.signalNumber !== undefined;
        const marker = wrapper.marker;
        // Deterministic configuration and marker errors keep the existing failure path.
        const invalidConfig = /game_(?:entry_invalid|map_invalid|port_invalid|engine_exec_marker_)|must not be empty/.test(result.output.join(""));
        if (marker && !lastIdentity && abnormal && !invalidConfig && await markerMissing(marker.path) &&
            await markerParentIdentity(marker.path).catch(error => {
              if (["ENOENT", "managed_path_linked", "managed_path_type_conflict", "game_engine_exec_marker_conflict"]
                .includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
              throw error;
            }) === marker.parent) {
          result.startupFailure = "before_engine_exec";
        }
        if (!observedExit) {
          observedExit = result;
          dispose();
        }
        return observedExit;
      } };
      this.startupExits.set(root, startup);
    }

    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 60_000);
    let identity: GameProcessIdentity | undefined;
    while (Date.now() < deadline) {
      identity = await findLinuxGameProcess(child.pid, spec.cwd);
      if (identity) {
        lastIdentity = identity;
        this.identities.set(root, identity);
      }
      if (identity && await inspectLinuxProcessUdpPort(identity, spec.port) === "owned") break;
      if (wrapperExit) break;
      await delay(50);
    }
    if (!identity || await inspectLinuxProcessUdpPort(identity, spec.port) !== "owned") {
      // A wrapper may still be able to start the game even when the port is free.
      if (attemptId) {
        const exitInfo = await this.inspectPendingStartupExit(root, attemptId);
        if (typeof exitInfo === "object") throw new GameServerStartupExitError(exitInfo);
      } else {
        dispose();
      }
      fail("game_process_not_observed");
    }
    if (attemptId) this.startupExits.delete(root);
    const ownedIdentity = identity;
    let exitInfo: GameServerExitInfo | undefined;
    let requestedSignal: NodeJS.Signals | null = null;
    const exitPromise = (async (): Promise<GameServerExitInfo> => {
      for (;;) {
        const processState = await inspectLinuxGameProcessIdentity(ownedIdentity);
        const gameAbsent = processState === "gone" || (processState === "mismatch" && wrapperExit !== undefined &&
          await inspectLinuxGameRoot(ownedIdentity.serverRoot) === "gone");
        if (gameAbsent && await inspectLinuxUdpPort(spec.port) === "free") {
          if (!wrapperExit) {
            // waitpid delivery can trail /proc and UDP observations by a turn.
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                wrapperExited,
                new Promise<void>(resolve => { timer = setTimeout(resolve, WRAPPER_EXIT_GRACE_MS); }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }
          exitInfo = readExitInfo(requestedSignal);
          dispose();
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
