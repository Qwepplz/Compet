import path from "node:path";
import fs from "node:fs/promises";
import cp from "node:child_process";
import { z } from "zod";
import { assertPlainPath } from "../desktop/main/serverManagedFiles.js";

export interface WindowsGameProcessIdentity {
  platform: "win32"; pid: number; createdAtUtc: string; executable: string;
}
const processSchema = z.object({
  pid: z.number().int().positive(), createdAtUtc: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[.]\d{7}Z$/),
  executable: z.string().min(1), commandLine: z.string().nullable().optional(),
});
const snapshotSchema = z.object({ processes: z.array(processSchema), portPids: z.array(z.number().int().positive()) });
function samePath(a: string, b: string): boolean {
  return path.isAbsolute(a) && path.isAbsolute(b) && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}
async function query(input: { pid: number } | { port: number }) {
  const filter = "pid" in input ? "ProcessId=" + input.pid : "Name='srcds.exe' OR Name='powershell.exe' OR Name='cmd.exe'";
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); " +
    "$rows=@(Get-CimInstance Win32_Process -Filter \"" + filter + "\" -ErrorAction Stop); " +
    "$processes=@($rows|ForEach-Object {@{pid=[int]$_.ProcessId;createdAtUtc=$_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ');executable=$_.ExecutablePath;commandLine=$_.CommandLine}}); " +
    ("port" in input ? "$ports=@(Get-NetUDPEndpoint -ErrorAction Stop|Where-Object {$_.LocalPort -eq " + input.port + "}|ForEach-Object {[int]$_.OwningProcess}); " : "$ports=@(); ") +
    "@{processes=$processes;portPids=$ports}|ConvertTo-Json -Depth 4 -Compress";
  const stdout = await new Promise<string>((resolve, reject) => {
    cp.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
      (error, stdout) => { if (error) reject(error); else resolve(stdout); });
  });
  return snapshotSchema.parse(JSON.parse(stdout.replace(/^\uFEFF/, "")));
}
export async function inspectWindowsGameOwner(serverRoot: string, port: number):
  Promise<{ state: "owned"; identity: WindowsGameProcessIdentity } | { state: "gone" | "unknown" }> {
  if (process.platform !== "win32" || !path.isAbsolute(serverRoot) || !Number.isInteger(port) || port < 1 || port > 65535) return { state: "unknown" };
  try {
    await assertPlainPath(serverRoot);
    const root = await fs.realpath(serverRoot), expected = path.join(root, "srcds.exe"), snapshot = await query({ port });
    const processes = snapshot.processes.filter(item => samePath(item.executable, expected));
    const owners = [...new Set(snapshot.portPids)];
    const wrapperPath = path.join(root, "run_csgo.ps1").toLowerCase();
    const wrappers = snapshot.processes.filter(item => ["powershell.exe", "cmd.exe"].includes(path.basename(item.executable).toLowerCase()));
    const pendingWrapper = wrappers.some(item => item.commandLine === undefined || item.commandLine === null || item.commandLine.toLowerCase().includes(wrapperPath));
    if (processes.length === 0 && owners.length === 0 && !pendingWrapper) return { state: "gone" };
    if (processes.length === 1 && owners.length === 1 && owners[0] === processes[0]!.pid) {
      const found = processes[0]!;
      return { state: "owned", identity: { platform: "win32", pid: found.pid, createdAtUtc: found.createdAtUtc, executable: expected } };
    }
  } catch { /* Failed queries are unknown, never a free port or absent process. */ }
  return { state: "unknown" };
}
export async function probeWindowsGameProcess(identity: WindowsGameProcessIdentity): Promise<"alive" | "gone" | "unknown"> {
  if (process.platform !== "win32" || !processSchema.safeParse(identity).success) return "unknown";
  try {
    const snapshot = await query({ pid: identity.pid });
    if (snapshot.processes.length === 0) return "gone";
    if (snapshot.processes.length !== 1) return "unknown";
    const found = snapshot.processes[0]!;
    if (found.pid === identity.pid && found.createdAtUtc === identity.createdAtUtc && samePath(found.executable, identity.executable)) return "alive";
  } catch { /* Preserve uncertainty, including inaccessible executable metadata. */ }
  return "unknown";
}
