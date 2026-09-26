export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  changedFiles: number;
  changedBytes: number;
  manifestUrl: string;
}

export interface UpdateInstallResult extends UpdateCheckResult {
  installing: boolean;
}

export type MaintenanceStage = "checking" | "downloading" | "preparing" | "verifying";
export type MaintenanceAction = "none" | "repair" | "update";

export interface IntegrityProgress {
  version: string;
  checkedFiles: number;
  totalFiles: number;
  stage: MaintenanceStage;
  downloadedBytes: number;
  totalDownloadBytes: number;
}

export interface IntegrityReport extends IntegrityProgress {
  currentVersion: string;
  action: MaintenanceAction;
  changedFiles: number;
  changedBytes: number;
  status: "passed" | "issues" | "unavailable";
  issues: Array<{ path: string; kind: "missing" | "size_mismatch" | "hash_mismatch" | "read_failed" }>;
  error?: string;
}

export type MaintenanceStartResult =
  | { status: "installing" }
  | { status: "refresh_required" | "no_changes"; report: IntegrityReport }
  | { status: "failed" | "cancelled"; error?: string };
