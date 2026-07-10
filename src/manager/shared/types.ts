import type { AccountRole } from "../../accounts/accountTypes.js";

export type { AccountRole } from "../../accounts/accountTypes.js";
export type ServiceState = "stopped" | "starting" | "running" | "stopping" | "failed";
export type LogLevel = "info" | "warn" | "error" | "debug";
export type DiagnosticStatus = "pass" | "warn" | "fail" | "unavailable";

export interface ManagerConfig {
  host: string;
  port: number;
  dataDir: string;
  tokenTtlMinutes: number;
  serverCommand: string;
  serverArgs: string[];
  serverRoot: string;
  publicConnectHost: string;
  gamePortStart: number;
  gamePortEnd: number;
  steamAccountToken: string;
}

export interface ServiceStatus {
  state: ServiceState;
  pid?: number;
  baseUrl: string;
  lastError?: string;
}

export interface MatchmakingOccupancy {
  activeCount: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: "manager" | "server" | "diagnostics";
  message: string;
}
export interface DiagnosticResult {
  id: string;
  label: string;
  status: DiagnosticStatus;
  summary: string;
  detail?: string;
}

export interface BootstrapAdminInput {
  username: string;
  password: string;
}

export interface LoginResult {
  account: AccountView;
}

export interface SavedLoginCredentials {
  username?: string;
  password?: string;
}

export interface AccountView {
  id: string;
  username: string;
  displayName: string;
  steam64?: string;
  steamPersonaName?: string;
  steamAvatarUrl?: string;
  role: AccountRole;
  enabled: boolean;
  dev?: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface CreateAccountInput {
  username: string;
  password: string;
  steam64?: string;
}

export interface UpdateAccountInput {
  steam64?: string;
  enabled?: boolean;
  dev?: boolean;
}
