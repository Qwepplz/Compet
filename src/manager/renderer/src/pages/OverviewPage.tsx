import { Button, Typography } from "antd";
import type { ServiceStatus } from "../../../shared/types.js";
import { useLanguage } from "../../../../language/react.js";

export function OverviewPage({ status, onStart, onStop, onRestart }: { status: ServiceStatus; onStart: () => Promise<void>; onStop: () => Promise<void>; onRestart: () => Promise<void> }) {
  const { t } = useLanguage();
  const busy = status.state === "starting" || status.state === "stopping";
  const running = status.state === "running";
  return (
    <>
      <h1 className="page-title">{t("manager.navigation.overview")}</h1>
      <div className="action-bar">
        <Button type="primary" onClick={onStart} disabled={running || busy}>{t("manager.overview.start")}</Button>
        <Button onClick={onStop} disabled={!running || busy}>{t("manager.overview.stop")}</Button>
        <Button onClick={onRestart} disabled={busy}>{t("manager.overview.restart")}</Button>
        <Typography.Text type="secondary">{t("manager.overview.pid", { pid: status.pid ?? "-" })}</Typography.Text>
      </div>
    </>
  );
}
