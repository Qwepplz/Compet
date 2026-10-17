import childProcess from "node:child_process";
import path from "node:path";
import { assertPlainPath } from "../desktop/main/serverManagedFiles.js";
import { updateFailure } from "./serverUpdateTypes.js";
import type { UpdateProcessIdentity } from "./serverTransaction.js";

export async function listWindowsInstallationProcesses(root: string | string[]): Promise<UpdateProcessIdentity[]> {
  if (process.platform !== "win32") updateFailure("server_platform_unsupported");
  const roots = [...new Set((Array.isArray(root) ? root : [root]).map(value => path.win32.normalize(value)))];
  if (!roots.length || roots.some(value => !path.win32.isAbsolute(value))) updateFailure("maintenance_process_unknown");
  for (const value of roots) await assertPlainPath(value);
  const encodedRoots = Buffer.from(JSON.stringify(roots), "utf8").toString("base64");
  const script = "$ErrorActionPreference='Stop';$roots=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedRoots + "'))|ConvertFrom-Json;$prefixes=@(foreach($rootValue in $roots){([string]$rootValue).TrimEnd('\\')+'\\'});$items=@();Get-CimInstance Win32_Process|ForEach-Object{$p=$_;if(!$p.ExecutablePath){if($p.Name -match '^(node|electron|srcds|srcds_win64)\\.exe$'){throw 'process identity unavailable'}}else{$owned=$false;foreach($prefix in $prefixes){if($p.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$owned=$true;break}};if($owned){if(!$p.CreationDate){throw 'process identity unavailable'};$items += [pscustomobject]@{pid=[int]$p.ProcessId;startTime=$p.CreationDate.ToUniversalTime().Ticks.ToString();executable=$p.ExecutablePath}}}};ConvertTo-Json -InputObject @($items) -Compress";
  const command = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  await assertPlainPath(command);
  const output = await new Promise<string>((resolve, reject) => childProcess.execFile(command,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8" },
    (error, stdout) => error ? reject(Object.assign(Error("maintenance_process_unknown"), { code: "maintenance_process_unknown" })) : resolve(stdout)));
  const raw: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
  if (!Array.isArray(raw) || raw.some(p => !p || !Number.isSafeInteger(p.pid) || p.pid <= 0 ||
      typeof p.startTime !== "string" || !/^[0-9]+$/.test(p.startTime) || typeof p.executable !== "string" ||
      !roots.some(value => path.win32.normalize(p.executable).toLowerCase().startsWith(value.toLowerCase() + path.sep)))) updateFailure("maintenance_process_unknown");
  return raw as UpdateProcessIdentity[];
}
export async function assertWindowsInstallationQuiet(root: string | string[], allowed: UpdateProcessIdentity[] = []): Promise<void> {
  for (const actual of await listWindowsInstallationProcesses(root)) {
    if (!allowed.some(p => p.pid === actual.pid && p.startTime === actual.startTime && p.executable.toLowerCase() === actual.executable.toLowerCase()))
      updateFailure("maintenance_process_busy");
  }
}
