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
