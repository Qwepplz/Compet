export const SERVER_ACTIVITY_PREFIX = "@compet-activity ";

export const LOG_LEVELS = ["info", "warn", "error", "debug"] as const;
export const LOG_SOURCES = ["manager", "server", "auth", "realtime", "account", "friend", "party", "matchmaking", "match", "game"] as const;

export type LogLevel = typeof LOG_LEVELS[number];
export type LogSource = typeof LOG_SOURCES[number];

export interface LogActor {
  accountId?: string;
  username: string;
  role?: "admin" | "player";
  steam64?: string;
}

export interface ActivityLogInput {
  timestamp?: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  actor?: LogActor;
  context?: Record<string, string | number | boolean | null>;
}

export function isActivityLogInput(value: unknown): value is ActivityLogInput {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ActivityLogInput>;
  return typeof entry.message === "string"
    && LOG_LEVELS.includes(entry.level as LogLevel)
    && LOG_SOURCES.includes(entry.source as LogSource);
}
