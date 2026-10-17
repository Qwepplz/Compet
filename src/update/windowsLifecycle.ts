import path from "node:path";
import { spawn } from "node:child_process";
import { assertPlainPath } from "../desktop/main/serverManagedFiles.js";
import { assertServicePortClosed, type ManagedServiceProcess } from "../manager/main/serviceProcess.js";
import type { ServerLayout } from "../shared/serverPackageLayout.js";
import type { ServerConfig } from "../config/config.js";
import { captureUpdateProcess, type UpdateProcessIdentity } from "./serverTransaction.js";
import { assertWindowsInstallationQuiet, listWindowsInstallationProcesses } from "./windowsProcesses.js";
import { updateFailure } from "./serverUpdateTypes.js";
import type { LifecycleSnapshot, ServerLifecycle } from "./serverLifecycle.js";

export class WindowsManagerLifecycle implements ServerLifecycle {
  private managerProcesses: UpdateProcessIdentity[] = [];
  private captured?: LifecycleSnapshot;
  constructor(private readonly input: { layout: ServerLayout; config: ServerConfig; service?: ManagedServiceProcess; closeOfflineAccounts?: () => Promise<void> }) {
    if (input.layout.platform !== "win32-x64") updateFailure("maintenance_lifecycle_invalid");
  }
  async capture(): Promise<LifecycleSnapshot> {
    const state = this.input.service?.status();
    if (state && !["running", "stopped"].includes(state.state) || state?.state === "running" && !state.pid) updateFailure("maintenance_service_busy");
    if (this.input.service) {
      const electron = path.join(this.input.layout.installRoot, "runtime/electron/electron.exe").toLowerCase();
      this.managerProcesses = (await listWindowsInstallationProcesses(this.input.layout.installRoot)).filter(p => p.executable.toLowerCase() === electron);
    } else await this.assertStopped();
    return this.captured = { kind: "windows-manager", wasRunning: state?.state === "running" };
  }
  async quiesce(snapshot: LifecycleSnapshot): Promise<void> {
    this.validate(snapshot);
    if (this.captured && this.captured.wasRunning !== snapshot.wasRunning) updateFailure("maintenance_lifecycle_invalid");
    await this.input.closeOfflineAccounts?.();
    const state = this.input.service?.status();
    if (state?.state === "running") {
      if (!snapshot.wasRunning || (await this.input.service!.stop()).state !== "stopped") updateFailure("maintenance_stop_failed");
    } else if (state && state.state !== "stopped") updateFailure("maintenance_service_busy");
    await this.assertStopped();
  }
  async assertStopped(): Promise<void> {
    const state = this.input.service?.status();
    if (state && state.state !== "stopped") updateFailure("maintenance_service_busy");
    const own = await captureUpdateProcess(process.pid);
    if (!own) updateFailure("maintenance_process_unknown");
    await assertWindowsInstallationQuiet([this.input.layout.installRoot, ...(this.input.config.gameServer.serverRoot ? [this.input.config.gameServer.serverRoot] : [])], [...this.managerProcesses, own]);
    await assertServicePortClosed(this.input.config);
  }
  async resume(snapshot: LifecycleSnapshot): Promise<void> {
    this.validate(snapshot);
    await this.assertStopped();
    if (this.input.service) return; // The current Manager already owns its GUI.
    const executable = path.join(this.input.layout.installRoot, "Compet Server Manager.exe");
    await assertPlainPath(executable);
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, [], { detached: true, windowsHide: true, stdio: "ignore", cwd: this.input.layout.installRoot, env });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
  }
  private validate(snapshot: LifecycleSnapshot) {
    if (snapshot.kind !== "windows-manager" || typeof snapshot.wasRunning !== "boolean" ||
        ["wasEnabled", "serviceName", "unitFingerprint", "controlGroup"].some(key => key in snapshot)) updateFailure("maintenance_lifecycle_invalid");
  }
}
