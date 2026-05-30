import { EventEmitter } from "node:events";
import { spawn as nodeSpawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ManagerConfig, ServiceStatus } from "../shared/types.js";

type SpawnFn = typeof nodeSpawn;
type ManagedChildProcess = ChildProcessByStdio<null, Readable, Readable>;
type ServiceEvents = "log" | "status";

export class ManagedServiceProcess extends EventEmitter {
  private child?: ManagedChildProcess;
  private stopPromise?: Promise<ServiceStatus>;
  private readonly stoppingChildren = new WeakSet<ManagedChildProcess>();
  private readonly stderrBuffers = new WeakMap<ManagedChildProcess, string>();
  private current: ServiceStatus = { state: "stopped", baseUrl: "https://127.0.0.1:8443" };

  constructor(private readonly cwd: string, private readonly spawnFn: SpawnFn = nodeSpawn) {
    super();
  }

  async start(config: ManagerConfig): Promise<ServiceStatus> {
    if (this.child) return this.current;
    this.setStatus({ state: "starting", baseUrl: this.baseUrl(config) });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      COMPET_HOST: config.host,
      COMPET_PORT: String(config.port),
      COMPET_DATA_DIR: config.dataDir,
      COMPET_TOKEN_TTL_MINUTES: String(config.tokenTtlMinutes),
      COMPET_CSGO_SERVER_ROOT: config.serverRoot,
      COMPET_STEAM_ACCOUNT_TOKEN: config.steamAccountToken,
      COMPET_PUBLIC_CONNECT_HOST: config.publicConnectHost,
      COMPET_GAME_PORT_START: String(config.gamePortStart),
      COMPET_GAME_PORT_END: String(config.gamePortEnd),
    };
    if (this.shouldRunAsElectronNode(config.serverCommand)) {
      env.ELECTRON_RUN_AS_NODE = "1";
    }
    try {
      const child = this.spawnFn(config.serverCommand, config.serverArgs, { cwd: this.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      this.bindChild(child, config);
      this.setStatus({ state: "running", pid: child.pid, baseUrl: this.baseUrl(config) });
      return this.current;
    } catch (error) {
      this.setStatus({ state: "failed", baseUrl: this.baseUrl(config), lastError: this.errorMessage(error) });
      throw error;
    }
  }

  async stop(): Promise<ServiceStatus> {
    if (!this.child) return this.current;
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    this.stoppingChildren.add(child);
    this.setStatus({ ...this.current, state: "stopping" });
    this.stopPromise = new Promise<ServiceStatus>((resolve) => {
      child.once("exit", () => {
        this.stopPromise = undefined;
        resolve(this.current);
      });
    });
    child.kill();
    return this.stopPromise;
  }

  status(): ServiceStatus {
    return this.current;
  }

  private bindChild(child: ManagedChildProcess, config: ManagerConfig): void {
    child.stdout.on("data", (chunk) => this.emit("log" satisfies ServiceEvents, "server", "info", String(chunk)));
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      this.appendStderr(child, text);
      this.emit("log" satisfies ServiceEvents, "server", "error", text);
    });
    child.on("exit", (code) => {
      const wasStopping = this.stoppingChildren.has(child);
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      if (!wasStopping && code !== 0) {
        this.setStatus({ state: "failed", baseUrl: this.baseUrl(config), lastError: this.exitFailureMessage(child, code) });
      } else {
        this.setStatus({ state: "stopped", baseUrl: this.baseUrl(config) });
      }
    });
  }

  private baseUrl(config: ManagerConfig): string {
    const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    return `https://${host}:${config.port}`;
  }

  private shouldRunAsElectronNode(command: string): boolean {
    return Boolean(process.versions.electron) && path.resolve(command) === path.resolve(process.execPath);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private appendStderr(child: ManagedChildProcess, chunk: string): void {
    const next = `${this.stderrBuffers.get(child) ?? ""}${chunk}`;
    this.stderrBuffers.set(child, next.slice(-4_096));
  }

  private exitFailureMessage(child: ManagedChildProcess, code: number | null): string {
    const summary = this.stderrSummary(this.stderrBuffers.get(child) ?? "");
    return summary ? `${summary} (exit code ${code ?? "unknown"})` : `server exit code ${code ?? "unknown"}`;
  }

  private stderrSummary(buffer: string): string | undefined {
    const lines = buffer
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "^" && !line.startsWith("at "));
    const explicitError = lines.find((line) => /error:/iu.test(line));
    return explicitError ?? lines.at(-1);
  }

  private setStatus(status: ServiceStatus): void {
    this.current = status;
    this.emit("status" satisfies ServiceEvents, status);
  }
}
