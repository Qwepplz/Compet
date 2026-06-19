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
