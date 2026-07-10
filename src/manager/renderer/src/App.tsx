import { Button, Card, message, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import type { BootstrapAdminInput, MatchmakingOccupancy, SavedLoginCredentials, ServiceStatus } from "../../shared/types.js";
import { managerApi } from "./api/managerApi.js";
import { AppShell } from "./components/AppShell.js";
import { AccountsPage } from "./pages/AccountsPage.js";
import { BootstrapPage } from "./pages/BootstrapPage.js";
import { ChangePasswordPage } from "./pages/ChangePasswordPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { LogsPage } from "./pages/LogsPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

const initialStatus: ServiceStatus = { state: "stopped", baseUrl: "https://127.0.0.1:18443" };
const initialMatchmakingOccupancy: MatchmakingOccupancy = { activeCount: 0 };
const MATCHMAKING_OCCUPANCY_POLL_MS = 2_000;

export function App() {
  const [status, setStatus] = useState<ServiceStatus>(initialStatus);
  const [page, setPage] = useState("overview");
  const [loggedIn, setLoggedIn] = useState(false);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const [savedLogin, setSavedLogin] = useState<SavedLoginCredentials | null>(null);
  const [serviceActionPending, setServiceActionPending] = useState(false);
  const [matchmakingOccupancy, setMatchmakingOccupancy] = useState<MatchmakingOccupancy>(initialMatchmakingOccupancy);

  useEffect(() => {
    void refreshStatus();
    void loadSavedLogin();
  }, []);

  useEffect(() => {
    if (!loggedIn || status.state !== "running") {
      setMatchmakingOccupancy(initialMatchmakingOccupancy);
      return;
    }

    let cancelled = false;
    const refreshMatchmakingOccupancy = async () => {
      try {
        const nextOccupancy = await managerApi.matchmakingOccupancy();
        if (!cancelled) setMatchmakingOccupancy(nextOccupancy);
      } catch {
        if (!cancelled) setMatchmakingOccupancy(initialMatchmakingOccupancy);
      }
    };

    void refreshMatchmakingOccupancy();
    const timer = window.setInterval(refreshMatchmakingOccupancy, MATCHMAKING_OCCUPANCY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loggedIn, status.state]);

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
    if (serviceActionPending) return;
    setServiceActionPending(true);
    try {
      const nextStatus = await managerApi.startService();
      setStatus(nextStatus);
      if (loggedIn && nextStatus.state === "running") {
        await reauthenticateAfterServiceRestart();
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "启动服务失败");
      await refreshStatus();
    } finally {
      setServiceActionPending(false);
    }
  }

  async function stopService() {
    if (serviceActionPending) return;
    setServiceActionPending(true);
    try {
      setStatus(await managerApi.stopService());
    } catch (error) {
      message.error(error instanceof Error ? error.message : "停止服务失败");
      await refreshStatus();
    } finally {
      setServiceActionPending(false);
    }
  }
  async function restartService() {
    if (serviceActionPending) return;
    setServiceActionPending(true);
    setPage("overview");
    try {
      const nextStatus = await managerApi.restartService();
      setStatus(nextStatus);
      if (nextStatus.state === "running") {
        await reauthenticateAfterServiceRestart();
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "重启服务失败");
      await refreshStatus();
    } finally {
      setServiceActionPending(false);
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
      setSavedLogin({ username, password });
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

  async function reauthenticateAfterServiceRestart() {
    const credentials = savedLogin ?? await managerApi.loadSavedLogin().catch(() => null);
    if (!credentials?.username || !credentials.password) {
      setLoggedIn(false);
      setPasswordChangeRequired(false);
      setPage("overview");
      message.warning("服务已重启，请重新登录");
      return;
    }

    try {
      const result = await managerApi.login(credentials.username, credentials.password);
      setSavedLogin(credentials);
      if (result.account.mustChangePassword) {
        setLoggedIn(false);
        setPasswordChangeRequired(true);
        setPage("overview");
        message.warning("服务已重启，请先修改密码");
        return;
      }
      setPasswordChangeRequired(false);
      setLoggedIn(true);
    } catch (error) {
      setLoggedIn(false);
      setPasswordChangeRequired(false);
      setPage("overview");
      message.error(error instanceof Error ? `服务已重启，请重新登录：${error.message}` : "服务已重启，请重新登录");
    }
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    try {
      await managerApi.changePassword(currentPassword, newPassword);
      message.success("密码已更新");
      setSavedLogin((credentials) => credentials ? { ...credentials, password: newPassword } : credentials);
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
    <AppShell page={page} status={status} matchmakingOccupancy={matchmakingOccupancy} onPageChange={(nextPage) => {
      if (!serviceActionPending) setPage(nextPage);
    }}>
      {page === "overview" && (
        <OverviewPage status={status} onStart={startService} onStop={stopService} onRestart={restartService} />
      )}
      {page === "accounts" && <AccountsPage />}
      {page === "logs" && <LogsPage />}
      {page === "settings" && <SettingsPage />}
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
