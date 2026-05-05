import { Button, Tag } from "antd";
import type { ReactNode } from "react";
import type { ServiceStatus } from "../../../shared/types.js";

const stateColor: Record<ServiceStatus["state"], string> = {
  stopped: "default",
  starting: "processing",
  running: "success",
  stopping: "warning",
  failed: "error",
};

export function OverviewPage({ status, onStart, onStop, onRestart }: { status: ServiceStatus; onStart: () => Promise<void>; onStop: () => Promise<void>; onRestart: () => Promise<void> }) {
  const busy = status.state === "starting" || status.state === "stopping";
  const running = status.state === "running";
  return (
    <>
      <h1 className="page-title">概览</h1>
      <div className="action-bar">
        <Button type="primary" onClick={onStart} disabled={running || busy}>启动</Button>
        <Button onClick={onStop} disabled={!running || busy}>停止</Button>
        <Button onClick={onRestart} disabled={busy}>重启</Button>
      </div>
      <div className="overview-grid">
        <Metric label="状态" value={<Tag color={stateColor[status.state]}>{status.state}</Tag>} />
        <Metric label="地址" value={status.baseUrl} />
        <Metric label="进程 PID" value={status.pid ? String(status.pid) : "-"} />
        <Metric label="版本" value={status.version ?? "-"} />
        <Metric label="证书指纹" value={status.certificateFingerprintSha256 ?? "-"} />
        <Metric label="最近错误" value={status.lastError ?? "-"} />
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return <div className="metric"><div className="metric-label">{label}</div><div className="metric-value">{value}</div></div>;
}
