import { Alert, Button, Table, Tag, message } from "antd";
import type { TableProps } from "antd";
import { useState } from "react";
import type { DiagnosticResult, DiagnosticStatus } from "../../../shared/types.js";
import { managerApi } from "../api/managerApi.js";

const statusColor: Record<DiagnosticStatus, string> = {
  pass: "green",
  warn: "gold",
  fail: "red",
  unavailable: "default",
};

const columns: TableProps<DiagnosticResult>["columns"] = [
  { title: "项目", dataIndex: "label" },
  {
    title: "状态",
    dataIndex: "status",
    render: (status: DiagnosticStatus) => <Tag color={statusColor[status]}>{status}</Tag>,
  },
  { title: "摘要", dataIndex: "summary" },
  {
    title: "详情",
    dataIndex: "detail",
    render: (detail?: string) => <span style={{ whiteSpace: "pre-wrap" }}>{detail || "-"}</span>,
  },
];

export function DiagnosticsPage() {
  const [results, setResults] = useState<DiagnosticResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function runDiagnostics() {
    if (loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const config = await managerApi.loadConfig();
      setResults(await managerApi.runDiagnostics({
        serverRoot: config.serverRoot,
        recordsDir: config.dataDir,
      }));
    } catch (caught) {
      const messageText = caught instanceof Error ? caught.message : "运行诊断失败";
      setError(messageText);
      message.error(messageText);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="status-row" style={{ marginBottom: 12 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>诊断</h1>
        <Button type="primary" loading={loading} disabled={loading} onClick={() => void runDiagnostics()}>
          运行诊断
        </Button>
      </div>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Table
        rowKey="id"
        columns={columns}
        dataSource={results}
        loading={loading}
        pagination={false}
        locale={{ emptyText: "尚未运行诊断" }}
      />
    </>
  );
}
