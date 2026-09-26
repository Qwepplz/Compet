import type { TranslationKey, Translator } from "./types.js";

const errorKeys = {
  account_already_logged_in: "errors.accountAlreadyLoggedIn",
  account_disabled: "errors.accountDisabled",
  player_login_required: "errors.playerLoginRequired",
  manager_login_required: "errors.managerLoginRequired",
  login_rate_limited: "errors.loginRateLimited",
  invalid_credentials: "errors.invalidCredentials",
  username_already_exists: "errors.usernameAlreadyExists",
  steam64_already_exists: "errors.steam64AlreadyExists",
  invalid_current_password: "errors.invalidCurrentPassword",
  friendship_already_exists: "errors.friendshipAlreadyExists",
  friend_request_already_pending: "errors.friendRequestAlreadyPending",
  party_owner_required: "errors.partyOwnerRequired",
  steam64_required_for_matchmaking: "errors.steam64RequiredForMatchmaking",
  matchmaking_already_active: "errors.matchmakingAlreadyActive",
  resource_not_found: "errors.resourceNotFound",
  service_unavailable: "errors.serviceUnavailable",
  match_failed: "errors.matchFailed",
  integrity_unavailable: "player.integrity.environmentUnsupported",
  integrity_installation_invalid: "player.integrity.installationInvalid",
  integrity_manifest_unavailable: "player.integrity.manifestUnavailable",
  integrity_manifest_mismatch: "player.integrity.versionMismatch",
  integrity_version_changed: "player.integrity.versionMismatch",
  integrity_manifest_invalid: "player.integrity.manifestInvalid",
  update_manifest_file_invalid: "player.integrity.manifestInvalid",
  update_manifest_path_or_hash_invalid: "player.integrity.manifestInvalid",
  update_file_url_invalid: "player.integrity.manifestInvalid",
  update_manifest_origin_invalid: "player.integrity.manifestInvalid",
  integrity_timeout: "player.integrity.timeout",
  integrity_path_outside: "player.integrity.pathOutside",
  update_busy: "player.integrity.busy",
  integrity_match_active: "player.integrity.matchActive",
  integrity_party_leave_required: "player.integrity.partyLeaveRequired",
  integrity_match_state_unavailable: "player.integrity.matchStateUnavailable",
  integrity_scan_required: "player.integrity.scanRequired",
  update_cancelled: "player.integrity.cancelled",
  update_download_failed: "player.integrity.downloadFailed",
  update_download_timeout: "player.integrity.timeout",
  update_file_hash_mismatch: "player.integrity.fileMismatch",
  update_helper_missing: "player.integrity.helperInvalid",
  update_helper_invalid: "player.integrity.helperInvalid",
  update_helper_spawn_failed: "player.integrity.helperInvalid",
  update_transaction_pending: "player.integrity.transactionPending",
  maintenance_helper_invalid: "player.integrity.helperInvalid",
  maintenance_manifest_invalid: "player.integrity.manifestInvalid",
  maintenance_verification_timeout: "player.integrity.timeout",
  maintenance_verification_failed: "player.integrity.verificationFailed",
  maintenance_recovery_failed: "player.integrity.recoveryFailed",
  maintenance_backup_invalid: "player.integrity.backupInvalid",
  maintenance_journal_invalid: "player.integrity.journalInvalid",
  maintenance_identity_invalid: "player.integrity.identityInvalid",
  maintenance_cleanup_pending: "player.integrity.cleanupPending",
  maintenance_transaction_invalid: "player.integrity.transactionInvalid",
  maintenance_summary_invalid: "player.integrity.summaryInvalid",
  maintenance_incomplete: "player.integrity.transactionPending",
  maintenance_apply_failed: "player.integrity.applyFailed",
  maintenance_rolled_back: "player.integrity.applyFailed",
  maintenance_interrupted: "player.integrity.applyFailed",
  maintenance_wait_timeout: "player.integrity.timeout",
} satisfies Record<string, TranslationKey>;

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function displayError(error: unknown, t: Translator, fallbackKey: TranslationKey): string {
  const code = errorCode(error);
  const key = code ? errorKeys[code as keyof typeof errorKeys] : undefined;
  return t(key ?? fallbackKey);
}
