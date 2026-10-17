export interface LifecycleSnapshot {
  kind: "systemd" | "windows-manager";
  wasRunning: boolean;
  wasEnabled?: boolean;
  serviceName?: string;
  unitFingerprint?: { size: number; sha256: string };
  controlGroup?: string;
}

export interface ServerLifecycle {
  capture(): Promise<LifecycleSnapshot>;
  quiesce(snapshot: LifecycleSnapshot): Promise<void>;
  assertStopped(): Promise<void>;
  resume(snapshot: LifecycleSnapshot): Promise<void>;
}

export async function createServerWorkerLifecycle(input: {
  layout: import("../shared/serverPackageLayout.js").ServerLayout;
  config: import("../config/config.js").ServerConfig;
  configPath: string;
  snapshot: LifecycleSnapshot;
}): Promise<ServerLifecycle> {
  if (input.layout.platform === "linux-x64") {
    const { SystemdLifecycle } = await import("./systemdLifecycle.js");
    return new SystemdLifecycle({ ...input, serviceName: input.snapshot.serviceName });
  }
  const { WindowsManagerLifecycle } = await import("./windowsLifecycle.js");
  return new WindowsManagerLifecycle(input);
}
