import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Select, Tooltip, message } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, LogLevel, LogSource } from "../../../shared/types.js";
import { logApi } from "../api/managerApi.js";
import { displayError } from "../../../../language/displayError.js";
import { useLanguage } from "../../../../language/react.js";

const MAX_VISIBLE_LOGS = 2_000;

export function LogsPage() {
  const { formatDateTime, t } = useLanguage();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LogLevel>();
  const [source, setSource] = useState<LogSource>();
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const requestIdRef = useRef(0);
  const viewerRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);

  async function load() {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const nextLogs = await logApi.recent();
      if (requestId !== requestIdRef.current) return;
      setLogs(nextLogs.slice(-MAX_VISIBLE_LOGS));
      followTailRef.current = true;
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      const text = displayError(caught, t, "errors.logsLoadFailed");
      setError(text);
      message.error(text);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    logApi.onAppended((entry) => {
      setLogs((current) => current.some((item) => item.id === entry.id)
        ? current
        : [...current, entry].slice(-MAX_VISIBLE_LOGS));
    });
    return () => logApi.removeAppendedListener();
  }, []);

  const visibleLogs = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const exactUsername = username.trim();
    return logs.filter((entry) => {
      if (level && entry.level !== level) return false;
      if (source && entry.source !== source) return false;
      if (exactUsername && entry.actor?.username !== exactUsername) return false;
      if (!normalizedQuery) return true;
      return formatSearchText(entry).toLocaleLowerCase().includes(normalizedQuery);
    });
  }, [level, logs, query, source, username]);

  const sources = useMemo(() => [...new Set(logs.map((entry) => entry.source))].sort(), [logs]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer && followTailRef.current) viewer.scrollTop = viewer.scrollHeight;
  }, [visibleLogs]);

  return (
    <div className="logs-page">
      <div className="logs-header">
        <h1 className="page-title">{t("manager.logs.title")}</h1>
        <div className="logs-toolbar">
          <Select<LogLevel>
            allowClear
            placeholder={t("manager.logs.level")}
            value={level}
            options={["debug", "info", "warn", "error"].map((value) => ({ value: value as LogLevel, label: value.toUpperCase() }))}
            className="logs-level-select"
            onChange={setLevel}
          />
          <Select<LogSource>
            allowClear
            placeholder={t("manager.logs.source")}
            value={source}
            options={sources.map((value) => ({ value, label: value }))}
            className="logs-source-select"
            onChange={setSource}
          />
          <Input
            allowClear
            placeholder={t("manager.logs.username")}
            value={username}
            className="logs-username"
            onChange={(event) => setUsername(event.target.value)}
          />
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder={t("manager.logs.filter")}
            value={query}
            className="logs-search"
            onChange={(event) => setQuery(event.target.value)}
          />
          <Tooltip title={t("manager.logs.refresh")}>
            <Button aria-label={t("manager.logs.refresh")} icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
          </Tooltip>
        </div>
      </div>
      {error && <Alert type="error" showIcon message={error} className="logs-error" />}
      <div
        ref={viewerRef}
        className="logs-viewer"
        onScroll={(event) => {
          const target = event.currentTarget;
          followTailRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
        }}
      >
        {loading && logs.length === 0 ? (
          <div className="logs-empty">{t("manager.logs.loading")}</div>
        ) : visibleLogs.length === 0 ? (
          <div className="logs-empty">{t("manager.logs.empty")}</div>
        ) : visibleLogs.map((entry) => (
          <div key={entry.id} className={`log-line log-line--${entry.level}`} title={formatLogTimestamp(entry.timestamp, formatDateTime)}>
            <span className="log-time">{formatLogTimestamp(entry.timestamp, formatDateTime)}</span>
            <span className="log-level">{entry.level.toUpperCase()}</span>
            <span className="log-source">{entry.source}</span>
            <span className="log-actor" title={formatActorTitle(entry, t)}>{formatActorLabel(entry)}</span>
            <span className="log-message">{entry.message}</span>
            {entry.context && <span className="log-context">{formatContext(entry.context)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatLogTimestamp(timestamp: string, formatDateTime: (value: string | number | Date) => string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return `${formatDateTime(date)}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function formatContext(context: NonNullable<LogEntry["context"]>): string {
  return Object.entries(context).map(([key, value]) => `${key}=${String(value)}`).join(" ");
}

function formatActorLabel(entry: LogEntry): string {
  if (!entry.actor) return "-";
  return entry.actor.role ? `${entry.actor.username} (${entry.actor.role})` : entry.actor.username;
}

function formatActorTitle(entry: LogEntry, t: ReturnType<typeof useLanguage>["t"]): string {
  if (!entry.actor) return t("manager.logs.noActor");
  return [formatActorLabel(entry), entry.actor.accountId, entry.actor.steam64].filter(Boolean).join(" · ");
}

function formatSearchText(entry: LogEntry): string {
  return [entry.timestamp, entry.level, entry.source, formatActorLabel(entry), entry.actor?.accountId, entry.actor?.steam64, entry.message, entry.context && formatContext(entry.context)].filter(Boolean).join(" ");
}
