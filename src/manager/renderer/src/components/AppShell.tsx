import { DashboardOutlined, FileTextOutlined, SafetyCertificateOutlined, SettingOutlined, TeamOutlined, ToolOutlined } from "@ant-design/icons";
import { Layout, Menu, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import type { ServiceStatus } from "../../../shared/types.js";

const menuItems = [
  { key: "overview", icon: <DashboardOutlined />, label: "概览" },
  { key: "accounts", icon: <TeamOutlined />, label: "账号" },
  { key: "diagnostics", icon: <ToolOutlined />, label: "诊断" },
  { key: "logs", icon: <FileTextOutlined />, label: "日志" },
  { key: "settings", icon: <SettingOutlined />, label: "设置" },
];

const statusColor: Record<ServiceStatus["state"], string> = {
  stopped: "default",
  starting: "processing",
  running: "success",
  stopping: "warning",
  failed: "error",
};
export function AppShell({ page, status, children, onPageChange }: { page: string; status: ServiceStatus; children: ReactNode; onPageChange: (page: string) => void }) {
  return (
    <Layout className="manager-shell">
      <Layout.Sider className="manager-sider" width={184} theme="light">
        <div className="manager-brand">Compet 管理器</div>
        <Menu mode="inline" selectedKeys={[page]} items={menuItems} onClick={({ key }) => onPageChange(key)} />
      </Layout.Sider>
      <Layout>
        <Layout.Header className="manager-header">
          <Space>
            <SafetyCertificateOutlined />
            <Typography.Text strong>服务端管理</Typography.Text>
          </Space>
          <Space className="status-row">
            <Tag color={statusColor[status.state]}>{status.state}</Tag>
            <Typography.Text className="status-url" type="secondary">{status.baseUrl}</Typography.Text>
          </Space>
        </Layout.Header>
        <Layout.Content className="manager-content">{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}
