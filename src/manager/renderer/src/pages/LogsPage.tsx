import { Alert, Button, List, Select, Space, Tag, Typography, message } from "antd";
import { useEffect, useRef, useState } from "react";
import type { LogEntry, LogLevel } from "../../../shared/types.js";
import { logApi } from "../api/managerApi.js";

const levelColor: Record<LogLevel, string> = {
  debug: "default",
  info: "blue",
  warn: "gold",
  error: "red",
};

export function LogsPage() {
  const [recentLogs, setRecentLogs] = useState<LogEntry[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>();
  const [fileContent, setFileContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [error, setError] = useState<string>();
  const readRequestIdRef = useRef(0);

  async function refresh() {
    setLoading(true);
    setError(undefined);
    try {
      const [nextRecentLogs, nextFiles] = await Promise.all([logApi.recent(), logApi.listFiles()]);
      setRecentLogs(nextRecentLogs);
      setFiles(nextFiles);
      if (selectedFile && !nextFiles.includes(selectedFile)) {
        setSelectedFile(undefined);
        setFileContent("");
      }
    } catch (caught) {
      const messageText = caught instanceof Error ? caught.message : "读取日志失败";
      setError(messageText);
      message.error(messageText);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function readFile(name?: string) {
    const requestId = ++readRequestIdRef.current;
    setSelectedFile(name);
    setFileContent("");
    setError(undefined);
    if (!name) {
      setReadingFile(false);
      return;
    }
    setReadingFile(true);
    try {
      const content = await logApi.readFile(name);
      if (readRequestIdRef.current === requestId) {
        setFileContent(content);
      }
    } catch (caught) {
      if (readRequestIdRef.current !== requestId) return;
      const messageText = caught instanceof Error ? caught.message : "读取历史日志失败";
      setError(messageText);
      message.error(messageText);
    } finally {
      if (readRequestIdRef.current === requestId) {
        setReadingFile(false);
      }
    }
  }

  return (
    <>
      <div className="status-row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>日志</h1>
        <Button loading={loading} disabled={loading || readingFile} onClick={() => void refresh()}>
          刷新
        </Button>
      </div>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Select
          allowClear
          placeholder="选择历史日志"
          value={selectedFile}
          options={files.map((name) => ({ value: name, label: name }))}
          loading={loading || readingFile}
          disabled={loading || readingFile}
          style={{ width: 320, maxWidth: "100%" }}
          onChange={(value) => void readFile(value)}
        />
        <List
          bordered
          loading={loading}
          dataSource={recentLogs}
          locale={{ emptyText: "暂无最近日志" }}
          renderItem={(entry) => (
            <List.Item>
              <Space size={8} wrap>
                <Typography.Text type="secondary">{entry.timestamp}</Typography.Text>
                <Tag>{entry.source}</Tag>
                <Tag color={levelColor[entry.level]}>{entry.level}</Tag>
                <Typography.Text>{entry.message}</Typography.Text>
              </Space>
            </List.Item>
          )}
        />
        {selectedFile && (
          <div>
            <div className="status-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <Typography.Text strong>{selectedFile}</Typography.Text>
              <Typography.Text copyable={{ text: fileContent }} disabled={!fileContent || readingFile}>
                复制内容
              </Typography.Text>
            </div>
            <pre
              style={{
                margin: 0,
                minHeight: 220,
                maxHeight: 420,
                overflow: "auto",
                padding: 12,
                borderRadius: 8,
                background: "#111827",
                color: "#e5e7eb",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {readingFile ? "读取中..." : fileContent}
            </pre>
          </div>
        )}
      </Space>
    </>
  );
}
