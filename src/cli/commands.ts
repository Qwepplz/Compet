import type { ServerConfig } from "../config/config.js";
import type { ServerLayout } from "../shared/serverPackageLayout.js";
import type { DoctorReport } from "./doctor.js";
import type { AdminServerStatus } from "../server/adminStatus.js";
import { CliError, type CliAdminClient } from "./adminClient.js";
import type { ServerUpdateAction, ServerUpdateResult } from "../update/serverUpdateTypes.js";

export type CliUpdateAction = ServerUpdateAction;
export type CliUpdateResult = ServerUpdateResult;
export interface CliUpdateInput {
  action: CliUpdateAction; layout: ServerLayout; config: ServerConfig; configPath: string;
  authorizeOnline: () => Promise<void>;
}
export interface CliServices {
  layout: ServerLayout;
  env: NodeJS.ProcessEnv;
  loadConfig(configPath: string, env: NodeJS.ProcessEnv): Promise<ServerConfig>;
  inspectEnvironment(input: { config: ServerConfig; layout: ServerLayout }): Promise<DoctorReport>;
  runServer(config: ServerConfig, layout: ServerLayout): Promise<void>;
  health(baseUrl: string): Promise<unknown>;
  readVersion(): Promise<string>;
  createAdminClient(baseUrl: string): CliAdminClient;
  executeUpdate?(input: CliUpdateInput): Promise<CliUpdateResult>;
  readUpdateStatus?(input: { config: ServerConfig; layout: ServerLayout; configPath: string }): Promise<unknown>;
}

export function serverBaseUrl(config: ServerConfig): string {
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  return "https://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + config.port;
}

export async function executeCliCommand(input: {
  command: string; id?: string; configPath: string; config: ServerConfig; services: CliServices;
  withAdmin: <T>(operation: (api: CliAdminClient) => Promise<T>) => Promise<T>;
  run: () => Promise<void>;
}): Promise<{ ok: boolean; data: unknown }> {
  const { command, config, configPath, services, withAdmin } = input;
  if (command === "run") { await input.run(); return { ok: true, data: { state: "stopped" } }; }
  if (command === "config check") return { ok: true, data: { valid: true } };
  if (command === "doctor") {
    const report = await services.inspectEnvironment({ config, layout: services.layout });
    return { ok: report.ok, data: report };
  }
  if (command === "status") {
    await services.health(serverBaseUrl(config));
    return { ok: true, data: { reachable: true, version: await services.readVersion(), platform: services.layout.platform } };
  }
  if (command.startsWith("update ")) {
    const action = command.slice(7);
    if (action === "status") {
      if (!services.readUpdateStatus) throw new CliError("update_status_unavailable");
      return { ok: true, data: await services.readUpdateStatus({ config, layout: services.layout, configPath }) };
    }
    if (!services.executeUpdate) throw new CliError("update_unavailable");
    const result = await services.executeUpdate({ action: action as CliUpdateAction, config, configPath, layout: services.layout,
      authorizeOnline: () => withAdmin(async api => {
        const ready = await api.request<{ ready?: boolean }>("POST", "/admin/maintenance/prepare");
        if (ready.ready !== true) throw new CliError("maintenance_not_ready", 409);
      }) });
    if (result.status === "failed" || result.status === "blocked") throw new CliError(result.code ?? "update_failed");
    return { ok: true, data: result };
  }
  return withAdmin(async api => {
    if (command === "maintenance status") return { ok: true, data: await api.request("GET", "/admin/maintenance") };
    if (command === "maintenance enter") {
      const data = await api.request<{ ready?: boolean }>("POST", "/admin/maintenance/prepare");
      if (data.ready !== true) throw new CliError("maintenance_not_ready", 409);
      return { ok: true, data };
    }
    if (command === "maintenance leave") return { ok: true, data: await api.request("DELETE", "/admin/maintenance") };
    if (command === "matches show") return { ok: true, data: await api.request("GET", "/admin/matches/" + encodeURIComponent(input.id!)) };
    const status = await api.request<AdminServerStatus>("GET", "/admin/server/status");
    if (command === "game status") return { ok: true, data: status.game };
    if (command === "matches list") return { ok: true, data: status.matches };
    if (command === "queue status") return { ok: true, data: status.queue };
    throw new CliError("argument_invalid");
  });
}
