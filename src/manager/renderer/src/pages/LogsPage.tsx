import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Select, Tooltip, message } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, LogLevel, LogSource } from "../../../shared/types.js";
import { logApi } from "../api/managerApi.js";

const LIVE_LOG = "__live__";
const MAX_VISIBLE_LOGS = 2_000;

export function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [selection, setSelection] = useState(LIVE_LOG);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LogLevel>();
  const [source, setSource] = useState<LogSource>();
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const requestIdRef = useRef(0);
  const viewerRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const selectionRef = useRef(LIVE_LOG);

  async function load(nextSelection = selection) {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const [nextLogs, nextFiles] = await Promise.all([
        nextSelection === LIVE_LOG ? logApi.recent() : logApi.readFile(nextSelection),
        logApi.listFiles(),
      ]);
      if (requestId !== requestIdRef.current) return;
      setLogs(nextLogs.slice(-MAX_VISIBLE_LOGS));
      setFiles(nextFiles);
      followTailRef.current = true;
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      const text = caught instanceof Error ? caught.message : "读取日志失败";
      setError(text);
      message.error(text);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(LIVE_LOG);
    logApi.onAppended((entry) => {
      if (selectionRef.current !== LIVE_LOG) return;
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
        <h1 className="page-title">日志</h1>
        <div className="logs-toolbar">
          <Select
            value={selection}
            options={[
              { value: LIVE_LOG, label: "实时日志" },
              ...files.map((name) => ({ value: name, label: name })),
            ]}
            loading={loading}
            className="logs-file-select"
            onChange={(value) => {
              selectionRef.current = value;
              setSelection(value);
              void load(value);
            }}
          />
          <Select<LogLevel>
            allowClear
            placeholder="级别"
            value={level}
            options={["debug", "info", "warn", "error"].map((value) => ({ value: value as LogLevel, label: value.toUpperCase() }))}
            className="logs-level-select"
            onChange={setLevel}
          />
          <Select<LogSource>
            allowClear
            placeholder="来源"
            value={source}
            options={sources.map((value) => ({ value, label: value }))}
            className="logs-source-select"
            onChange={setSource}
          />
          <Input
            allowClear
            placeholder="用户名"
            value={username}
            className="logs-username"
            onChange={(event) => setUsername(event.target.value)}
          />
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="筛选日志"
            value={query}
            className="logs-search"
            onChange={(event) => setQuery(event.target.value)}
          />
          <Tooltip title="刷新">
            <Button aria-label="刷新" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
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
          <div className="logs-empty">读取中...</div>
        ) : visibleLogs.length === 0 ? (
          <div className="logs-empty">暂无日志</div>
        ) : visibleLogs.map((entry) => (
          <div key={entry.id} className={`log-line log-line--${entry.level}`} title={entry.timestamp}>
            <span className="log-time">{formatTime(entry.timestamp)}</span>
            <span className="log-level">{entry.level.toUpperCase()}</span>
            <span className="log-source">{entry.source}</span>
            <span className="log-actor" title={formatActorTitle(entry)}>{formatActorLabel(entry)}</span>
            <span className="log-message">{entry.message}</span>
            {entry.context && <span className="log-context">{formatContext(entry.context)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return `${date.toLocaleTimeString("zh-CN", { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function formatContext(context: NonNullable<LogEntry["context"]>): string {
  return Object.entries(context).map(([key, value]) => `${key}=${String(value)}`).join(" ");
}

function formatActorLabel(entry: LogEntry): string {
  if (!entry.actor) return "-";
  return entry.actor.role ? `${entry.actor.username} (${entry.actor.role})` : entry.actor.username;
}

function formatActorTitle(entry: LogEntry): string {
  if (!entry.actor) return "无操作者";
  return [formatActorLabel(entry), entry.actor.accountId, entry.actor.steam64].filter(Boolean).join(" · ");
}

function formatSearchText(entry: LogEntry): string {
  return [entry.timestamp, entry.level, entry.source, formatActorLabel(entry), entry.actor?.accountId, entry.actor?.steam64, entry.message, entry.context && formatContext(entry.context)].filter(Boolean).join(" ");
}
