import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import type { ServerConfig } from "../config/config.js";
import type { ServerLayout } from "../shared/serverPackageLayout.js";
import { inspectLinuxGameRoot, inspectLinuxUdpPort } from "../game/linuxProcess.js";
import type { LifecycleSnapshot, ServerLifecycle } from "./serverLifecycle.js";

const properties = ["LoadState", "ActiveState", "UnitFileState", "MainPID", "FragmentPath", "DropInPaths",
  "NeedDaemonReload", "User", "Group", "WorkingDirectory", "KillMode", "SendSIGKILL", "ExecStart", "ControlGroup"];
const boundProperties = ["User", "Group", "WorkingDirectory", "KillMode", "SendSIGKILL"];
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function cgroupPath(value: string): string {
  if (!value.startsWith("/") || value === "/" || value.includes("\\") || /[\x00-\x20]/.test(value) ||
      path.posix.normalize(value) !== value) fail("maintenance_cgroup_unknown");
  return value;
}

export class SystemdLifecycle implements ServerLifecycle {
  private readonly serviceName: string;
  private snapshot?: LifecycleSnapshot;
  constructor(private readonly input: { layout: ServerLayout; config: ServerConfig; configPath: string; serviceName?: string; snapshot?: LifecycleSnapshot }) {
    this.serviceName = input.serviceName ?? "compet.service";
    if (input.layout.platform !== "linux-x64" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.service$/.test(this.serviceName) ||
        !path.posix.isAbsolute(input.configPath) || /[\x00-\x1f]/.test(input.configPath)) fail("maintenance_unit_invalid");
    this.snapshot = input.snapshot;
  }

  private command(action: string, ...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      childProcess.execFile("systemctl", [action, ...args, this.serviceName], {
        shell: false, timeout: 155_000, maxBuffer: 1024 * 1024, encoding: "utf8",
      }, (error, stdout) => error
        ? reject(Object.assign(new Error("maintenance_systemctl_" + action + "_failed"), { code: "maintenance_systemctl_" + action + "_failed" }))
        : resolve(stdout));
    });
  }

  private async inspect() {
    const raw = await this.command("show", "--no-pager", "--property=" + properties.join(","));
    const values: Record<string, string> = {};
    for (const line of raw.trimEnd().split("\n")) {
      const separator = line.indexOf("=");
      const key = line.slice(0, separator);
      if (separator < 1 || !properties.includes(key) || key in values) fail("maintenance_unit_unknown");
      values[key] = line.slice(separator + 1);
    }
    if (properties.some(key => !(key in values)) || values.LoadState !== "loaded" ||
        !["active", "inactive", "failed"].includes(values.ActiveState!) ||
        !["enabled", "disabled"].includes(values.UnitFileState!) || values.NeedDaemonReload !== "no" ||
        !/^(0|[1-9][0-9]*)$/.test(values.MainPID!) || !Number.isSafeInteger(Number(values.MainPID)) ||
        (values.ActiveState === "active" ? Number(values.MainPID) <= 0 : values.MainPID !== "0")) fail("maintenance_unit_unknown");
    const entry = path.posix.join(this.input.layout.installRoot, "bin/compet");
    // systemctl's ExecStart machine representation does not quote argv boundaries. Refuse ambiguous paths.
    if (/[\s;{}\\]/.test(entry + this.input.configPath) || values.WorkingDirectory !== this.input.layout.installRoot ||
        !values.User || values.User === "root" || values.User === "0" ||
        values.KillMode !== "mixed" || values.SendSIGKILL !== "no") fail("maintenance_unit_mismatch");
    const expected = "{ path=" + entry + " ; argv[]=" + entry + " run --config " + this.input.configPath + " ;";
    if (!values.ExecStart?.startsWith(expected) || values.ExecStart.includes("} ;") ||
        (values.ExecStart.match(/\{ path=/g)?.length ?? 0) !== 1) fail("maintenance_unit_mismatch");
    if (values.ControlGroup) cgroupPath(values.ControlGroup);
    if (values.ActiveState === "active" && !values.ControlGroup) fail("maintenance_cgroup_unknown");
    const files = [values.FragmentPath!, ...(values.DropInPaths ? values.DropInPaths.split(" ") : [])];
    const chunks: Buffer[] = [Buffer.from(JSON.stringify({ service: this.serviceName, entry, config: this.input.configPath,
      effective: boundProperties.map(key => [key, values[key]]) }))];
    for (const file of files) {
      if (!path.posix.isAbsolute(file) && !path.isAbsolute(file) || /[\x00-\x20\\]/.test(file)) fail("maintenance_unit_unknown");
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail("maintenance_unit_unknown");
        const bytes = await fs.readFile(file);
        chunks.push(Buffer.from("\0" + file + "\0" + bytes.length + "\0"), bytes);
      } catch { fail("maintenance_unit_unknown"); }
    }
    const bytes = Buffer.concat(chunks);
    return { values, fingerprint: { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
  }

  private async assertOutside(group?: string) {
    try {
      const groups = (await fs.readFile("/proc/self/cgroup", "utf8")).trim().split("\n");
      const own = groups.find(line => line.startsWith("0::"))?.slice(3);
      if (!own?.startsWith("/")) fail("maintenance_cgroup_unknown");
      if (group && (own === group || own.startsWith(group + "/"))) fail("maintenance_worker_inside_service");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code?.startsWith("maintenance_")) throw error;
      fail("maintenance_cgroup_unknown");
    }
  }

  private async bound(snapshot: LifecycleSnapshot) {
    if (snapshot.kind !== "systemd" || snapshot.serviceName !== this.serviceName || typeof snapshot.wasRunning !== "boolean" ||
        typeof snapshot.wasEnabled !== "boolean" || !snapshot.unitFingerprint ||
        (snapshot.wasRunning && !snapshot.controlGroup)) fail("maintenance_snapshot_invalid");
    if (snapshot.controlGroup) cgroupPath(snapshot.controlGroup);
    const current = await this.inspect();
    if (current.fingerprint.size !== snapshot.unitFingerprint.size ||
        current.fingerprint.sha256.toLowerCase() !== snapshot.unitFingerprint.sha256.toLowerCase()) fail("maintenance_unit_changed");
    if (current.values.ControlGroup && snapshot.controlGroup && current.values.ControlGroup !== snapshot.controlGroup) fail("maintenance_unit_changed");
    await this.assertOutside(current.values.ControlGroup || snapshot.controlGroup);
    this.snapshot = snapshot;
    return current.values;
  }

  async capture(): Promise<LifecycleSnapshot> {
    const { values, fingerprint } = await this.inspect();
    await this.assertOutside(values.ControlGroup);
    this.snapshot = { kind: "systemd", serviceName: this.serviceName, wasRunning: values.ActiveState === "active",
      wasEnabled: values.UnitFileState === "enabled", unitFingerprint: fingerprint,
      ...(values.ControlGroup ? { controlGroup: values.ControlGroup } : {}) };
    return structuredClone(this.snapshot);
  }

  async quiesce(snapshot: LifecycleSnapshot): Promise<void> {
    const current = await this.bound(snapshot);
    if (!snapshot.wasRunning && current.ActiveState === "active" || !snapshot.wasEnabled && current.UnitFileState === "enabled") fail("maintenance_lifecycle_changed");
    if (current.ActiveState === "active") await this.command("stop");
    // A stop failure must never disable a still running service.
    await this.checkStopped(true);
    const stopped = await this.bound(snapshot);
    if (snapshot.wasEnabled && stopped.UnitFileState === "enabled") await this.command("disable");
    if ((await this.bound(snapshot)).UnitFileState !== "disabled") fail("maintenance_disable_incomplete");
    await this.assertStopped();
  }

  private async assertCgroupEmpty(group: string) {
    let count = 0;
    const visit = async (directory: string): Promise<void> => {
      if (++count > 2048) fail("maintenance_cgroup_unknown");
      let processes: string;
      try { processes = await fs.readFile(directory + "/cgroup.procs", "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; fail("maintenance_cgroup_unknown"); }
      if (processes.trim()) fail("maintenance_service_residual");
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) fail("maintenance_cgroup_unknown");
        if (entry.isDirectory()) await visit(directory + "/" + entry.name);
      }
    };
    await visit("/sys/fs/cgroup" + cgroupPath(group));
  }

  private async assertPortClosed() {
    const host = this.input.config.host === "0.0.0.0" ? "127.0.0.1" : this.input.config.host === "::" ? "::1" : this.input.config.host;
    const closed = await new Promise<boolean>(resolve => {
      const socket = net.createConnection({ host, port: this.input.config.port });
      const done = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.setTimeout(1000, () => done(false));
      socket.once("connect", () => done(false));
      socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED"));
    });
    if (!closed) fail("maintenance_external_service");
  }

  async assertStopped(): Promise<void> { await this.checkStopped(false); }

  private async checkStopped(allowEnabled: boolean): Promise<void> {
    if (!this.snapshot) fail("maintenance_snapshot_invalid");
    const current = await this.bound(this.snapshot);
    if (current.ActiveState === "active" || current.MainPID !== "0") fail("maintenance_service_running");
    if (!allowEnabled && current.UnitFileState !== "disabled") fail("maintenance_lifecycle_changed");
    if (this.snapshot.controlGroup) await this.assertCgroupEmpty(this.snapshot.controlGroup);
    await this.assertPortClosed();
    const { serverRoot, portRange } = this.input.config.gameServer;
    if (await inspectLinuxGameRoot(serverRoot) !== "gone") fail("maintenance_game_observable");
    for (let port = portRange.start; port <= portRange.end; port++) {
      if (await inspectLinuxUdpPort(port) !== "free") fail("maintenance_game_observable");
    }
  }

  async resume(snapshot: LifecycleSnapshot): Promise<void> {
    let current = await this.bound(snapshot);
    if (!snapshot.wasEnabled && current.UnitFileState === "enabled" || !snapshot.wasRunning && current.ActiveState === "active") fail("maintenance_lifecycle_changed");
    if (snapshot.wasEnabled && current.UnitFileState === "disabled") await this.command("enable");
    current = await this.bound(snapshot);
    if (snapshot.wasRunning && current.ActiveState !== "active") {
      await this.checkStopped(true);
      await this.command("start");
    }
    current = await this.bound(snapshot);
    if ((current.ActiveState === "active") !== snapshot.wasRunning || (current.UnitFileState === "enabled") !== snapshot.wasEnabled) fail("maintenance_restore_incomplete");
  }
}
