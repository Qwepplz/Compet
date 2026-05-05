import { Button, Card, message, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import type { BootstrapAdminInput, SavedLoginCredentials, ServiceStatus } from "../../shared/types.js";
import { managerApi } from "./api/managerApi.js";
import { AppShell } from "./components/AppShell.js";
import { AccountsPage } from "./pages/AccountsPage.js";
import { BootstrapPage } from "./pages/BootstrapPage.js";
import { ChangePasswordPage } from "./pages/ChangePasswordPage.js";
import { DiagnosticsPage } from "./pages/DiagnosticsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { LogsPage } from "./pages/LogsPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

const initialStatus: ServiceStatus = { state: "stopped", baseUrl: "https://127.0.0.1:18443" };
const implementedPages = new Set(["overview", "accounts", "diagnostics", "logs", "settings"]);

export function App() {
  const [status, setStatus] = useState<ServiceStatus>(initialStatus);
  const [page, setPage] = useState("overview");
  const [loggedIn, setLoggedIn] = useState(false);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const [savedLogin, setSavedLogin] = useState<SavedLoginCredentials | null>(null);

  useEffect(() => {
    void refreshStatus();
    void loadSavedLogin();
  }, []);

  async function loadSavedLogin() {
    try {
      setSavedLogin(await managerApi.loadSavedLogin());
    } catch {
      setSavedLogin(null);
    }
  }
  async function refreshStatus() {
    try {
      setStatus(await managerApi.serviceStatus());
    } catch (error) {
      message.error(error instanceof Error ? error.message : "读取服务状态失败");
    }
  }

  async function startService() {
    try {
      setStatus(await managerApi.startService());
    } catch (error) {
      message.error(error instanceof Error ? error.message : "启动服务失败");
      await refreshStatus();
    }
  }

  async function stopService() {
    try {
      setStatus(await managerApi.stopService());
    } catch (error) {
      message.error(error instanceof Error ? error.message : "停止服务失败");
      await refreshStatus();
    }
  }
  async function restartService() {
    try {
      setStatus(await managerApi.restartService());
    } catch (error) {
      message.error(error instanceof Error ? error.message : "重启服务失败");
      await refreshStatus();
    }
  }

  async function bootstrap(input: BootstrapAdminInput) {
    try {
      await managerApi.writeBootstrap(input);
      message.success("已写入 bootstrap 管理员文件");
      const nextStatus = await managerApi.startService();
      setStatus(nextStatus);
      if (nextStatus.state === "running") {
        await login(input.username, input.password);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "初始化管理员失败");
    }
  }

  async function login(username: string, password: string) {
    try {
      const result = await managerApi.login(username, password);
      if (result.account.mustChangePassword) {
        setPasswordChangeRequired(true);
        message.warning("请先修改初始密码");
        return;
      }
      setPasswordChangeRequired(false);
      setLoggedIn(true);
      setPage("overview");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "登录失败");
    }
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    try {
      await managerApi.changePassword(currentPassword, newPassword);
      message.success("密码已更新");
      setPasswordChangeRequired(false);
      setLoggedIn(true);
      setPage("overview");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "修改密码失败");
    }
  }
  if (status.state === "failed" && !loggedIn) {
    if (needsBootstrap(status)) {
      return <BootstrapPage onSubmit={bootstrap} />;
    }
    return <FailedStatusPage status={status} onStart={startService} onRefresh={refreshStatus} />;
  }

  if (passwordChangeRequired && !loggedIn) {
    return <ChangePasswordPage onChangePassword={changePassword} />;
  }

  if (!loggedIn) {
    return <LoginPage status={status} savedLogin={savedLogin} onStart={startService} onLogin={login} />;
  }

  return (
    <AppShell page={page} status={status} onPageChange={setPage}>
      {page === "overview" && (
        <OverviewPage status={status} onStart={startService} onStop={stopService} onRestart={restartService} />
      )}
      {page === "accounts" && <AccountsPage />}
      {page === "diagnostics" && <DiagnosticsPage />}
      {page === "logs" && <LogsPage />}
      {page === "settings" && <SettingsPage />}
      {!implementedPages.has(page) && <div className="placeholder-panel">该页面将在后续任务实现</div>}
    </AppShell>
  );
}

function needsBootstrap(status: ServiceStatus): boolean {
  const lastError = status.lastError?.toLowerCase() ?? "";
  return lastError.includes("no accounts") || lastError.includes("bootstrap-admin") || lastError.includes("missing bootstrap") || lastError.includes("缺少 bootstrap") || lastError.includes("缺少bootstrap");
}
function FailedStatusPage({ status, onStart, onRefresh }: { status: ServiceStatus; onStart: () => Promise<void>; onRefresh: () => Promise<void> }) {
  return (
    <div className="auth-page">
      <Card className="auth-card" title="服务启动失败">
        <Typography.Paragraph type="secondary">
          服务当前处于 failed 状态，请检查错误信息后重试。
        </Typography.Paragraph>
        <Typography.Paragraph className="error-text">
          {status.lastError ?? "未提供错误详情"}
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Button type="primary" block onClick={onStart}>启动/重试服务</Button>
          <Button block onClick={onRefresh}>刷新状态</Button>
        </Space>
      </Card>
    </div>
  );
}
