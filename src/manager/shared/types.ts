import type { AccountRole } from "../../accounts/accountTypes.js";
import type { ActivityLogInput } from "../../shared/activityLog.js";
import type { MatchSeriesResult } from "../../matchmaking/types.js";
import type { MatchHistoryEntry } from "../../records/matchHistory.js";

export type { AccountRole } from "../../accounts/accountTypes.js";
export type { LogLevel, LogSource } from "../../shared/activityLog.js";
export type ServiceState = "stopped" | "starting" | "running" | "stopping" | "failed";

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

export type ServerRootValidationErrorCode = "server_root_invalid" | "server_root_check_failed";

export type ManagerConfigSaveResult =
  | { status: "saved" }
  | { status: "error"; code: ServerRootValidationErrorCode };

export type ServerRootRecoveryErrorCode =
  | "server_root_invalid"
  | "server_root_check_failed"
  | "server_root_recovery_busy"
  | "server_root_save_failed"
  | "server_root_selection_failed";

export type ServerRootRecoveryResult =
  | { status: "saved"; serverRoot: string }
  | { status: "cancelled" }
  | { status: "error"; code: ServerRootRecoveryErrorCode };

export interface MatchmakingOccupancy {
  activeCount: number;
}

export interface LogEntry extends Omit<ActivityLogInput, "timestamp"> {
  id: string;
  timestamp: string;
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
  online?: boolean;
  inGame?: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface AccountMatchHistory {
  account: AccountView;
  matches: MatchHistoryEntry[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AccountMatchDetail {
  account: AccountView;
  result: MatchSeriesResult;
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
