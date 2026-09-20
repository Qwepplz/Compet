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

export interface IntegrityProgress {
  version: string;
  checkedFiles: number;
  totalFiles: number;
}

export interface IntegrityReport extends IntegrityProgress {
  status: "passed" | "issues" | "unavailable";
  issues: Array<{ path: string; kind: "missing" | "size_mismatch" | "hash_mismatch" | "read_failed" }>;
  error?: string;
}
