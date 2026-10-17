import { execFile } from "node:child_process";
import dgram from "node:dgram";
import { promisify } from "node:util";
import { delay } from "../shared/async.js";
import { inspectLinuxGameRoot, inspectLinuxUdpPort, probeLinuxGameProcess, type GameProcessIdentity } from "./linuxProcess.js";

export interface SourceServerExitMonitorSpec {
  host: string;
  port: number;
  intervalMs: number;
  queryTimeoutMs: number;
  missedResponsesBeforeExit: number;
  startupObservationTimeoutMs: number;
  identity?: GameProcessIdentity;
  serverRoot?: string;
}

export type SourceServerExitMonitorResult = "closed" | "not_observed";

const A2S_INFO_QUERY = Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
  Buffer.from("Source Engine Query\0", "ascii"),
]);
const execFileAsync = promisify(execFile);

export async function waitForSourceServerExit(
  spec: SourceServerExitMonitorSpec,
): Promise<SourceServerExitMonitorResult> {
  const startedAt = Date.now();
  let observed = false;
  let missedResponses = 0;
  while (true) {
    const alive = await isSourceServerObservable(spec);
    if (alive) {
      observed = true;
      missedResponses = 0;
    } else if (observed) {
      missedResponses += 1;
      if (missedResponses >= spec.missedResponsesBeforeExit) {
        return "closed";
      }
    } else if (Date.now() - startedAt >= spec.startupObservationTimeoutMs) {
      return "not_observed";
    }

    await delay(spec.intervalMs);
  }
}

export async function isSourceServerObservable(spec: SourceServerExitMonitorSpec): Promise<boolean> {
  if (process.platform === "linux") {
    const [port, processState, rootState] = await Promise.all([
      inspectLinuxUdpPort(spec.port),
      spec.identity ? probeLinuxGameProcess(spec.identity) :
        spec.serverRoot ? inspectLinuxGameRoot(spec.serverRoot) : Promise.resolve("unknown"),
      spec.serverRoot ? inspectLinuxGameRoot(spec.serverRoot) : Promise.resolve("gone"),
    ]);
    return port !== "free" || processState !== "gone" || rootState !== "gone";
  }
  const [queryAlive, ownerPid] = await Promise.all([
    querySourceServer(spec.host, spec.port, spec.queryTimeoutMs),
    findUdpPortOwnerPid(spec.port),
  ]);
  return queryAlive || ownerPid !== undefined;
}

export async function findUdpPortOwnerPid(port: number): Promise<number | undefined> {
  if (process.platform !== "win32") return undefined;

  try {
    const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "udp"], { windowsHide: true });
    return parseNetstatUdpOwnerPid(stdout, port);
  } catch {
    return undefined;
  }
}

export function parseNetstatUdpOwnerPid(output: string, port: number): number | undefined {
  const portSuffix = `:${port}`;
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== "UDP" || columns.length < 3) continue;
    const localAddress = columns[1] ?? "";
    const pidText = columns[columns.length - 1] ?? "";
    if (!localAddress.endsWith(portSuffix)) continue;
    const pid = Number(pidText);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return undefined;
}

export async function querySourceServer(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // Socket may already be closed after a send error.
      }
      resolve(alive);
    };

    const timer = setTimeout(() => done(false), timeoutMs);
    let challenges = 0;
    socket.on("message", message => {
      if (message.length === 9 && message.readUInt32LE(0) === 0xffffffff && message[4] === 0x41) {
        if (++challenges > 2) return;
        socket.send(Buffer.concat([A2S_INFO_QUERY, message.subarray(5)]), error => { if (error) done(false); });
      } else if (validInfoResponse(message)) done(true);
    });
    socket.once("error", () => done(false));
    socket.connect(port, host, () => {
      socket.send(A2S_INFO_QUERY, error => { if (error) done(false); });
    });
  });
}

function validInfoResponse(message: Buffer): boolean {
  if (message.length < 6 || message.length > 4096 || message.readUInt32LE(0) !== 0xffffffff || message[4] !== 0x49) return false;
  let offset = 6;
  const string = () => {
    const end = message.indexOf(0, offset);
    if (end < 0) return false;
    offset = end + 1; return true;
  };
  for (let n = 0; n < 4; n++) if (!string()) return false;
  offset += 9;
  if (offset > message.length || !string()) return false;
  if (offset === message.length) return true;
  const flags = message[offset++]!;
  if (flags & ~0xf1) return false;
  if (flags & 0x80) offset += 2;
  if (flags & 0x10) offset += 8;
  if (flags & 0x40) { offset += 2; if (!string()) return false; }
  if (flags & 0x20) if (!string()) return false;
  if (flags & 0x01) offset += 8;
  return offset === message.length;
}
