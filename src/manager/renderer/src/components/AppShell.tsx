import { DashboardOutlined, FileTextOutlined, SafetyCertificateOutlined, SettingOutlined, TeamOutlined } from "@ant-design/icons";
import { Layout, Menu, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import type { MatchmakingOccupancy, ServiceStatus } from "../../../shared/types.js";
import { useLanguage } from "../../../../language/react.js";
import { serviceStatusLabel } from "../serviceStatus.js";

const statusColor: Record<ServiceStatus["state"], string> = {
  stopped: "default",
  starting: "processing",
  running: "success",
  stopping: "warning",
  failed: "error",
};
export function AppShell({ page, status, matchmakingOccupancy, children, onPageChange }: { page: string; status: ServiceStatus; matchmakingOccupancy: MatchmakingOccupancy; children: ReactNode; onPageChange: (page: string) => void }) {
  const { t } = useLanguage();
  const menuItems = [
    { key: "overview", icon: <DashboardOutlined />, label: t("manager.navigation.overview") },
    { key: "accounts", icon: <TeamOutlined />, label: t("manager.navigation.accounts") },
    { key: "logs", icon: <FileTextOutlined />, label: t("manager.navigation.logs") },
    { key: "settings", icon: <SettingOutlined />, label: t("manager.navigation.settings") },
  ];
  const occupancyBusy = matchmakingOccupancy.activeCount > 0;
  return (
    <Layout className="manager-shell">
      <Layout.Sider className="manager-sider" width={184} theme="light">
        <div className="manager-brand">{t("manager.brand")}</div>
        <Menu mode="inline" selectedKeys={[page]} items={menuItems} onClick={({ key }) => onPageChange(key)} />
      </Layout.Sider>
      <Layout>
        <Layout.Header className="manager-header">
          <Space>
            <SafetyCertificateOutlined />
            <Typography.Text strong>{t("manager.serviceAdministration")}</Typography.Text>
          </Space>
          <div className="manager-status">
            <span className={`manager-occupancy manager-occupancy--${occupancyBusy ? "busy" : "available"}`} title={t("manager.occupancy", { count: matchmakingOccupancy.activeCount })}>
              <span className="manager-occupancy-dot" />
              <span>{matchmakingOccupancy.activeCount}</span>
            </span>
            <Tag className="manager-status-tag" color={statusColor[status.state]}>{serviceStatusLabel(status.state, t)}</Tag>
            <Typography.Text className="status-url" type="secondary">{status.baseUrl}</Typography.Text>
          </div>
        </Layout.Header>
        <Layout.Content className="manager-content">{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}
