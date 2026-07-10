import { Button, Typography } from "antd";
import type { ServiceStatus } from "../../../shared/types.js";

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
        <Typography.Text type="secondary">进程 PID：{status.pid ?? "-"}</Typography.Text>
      </div>
    </>
  );
}
