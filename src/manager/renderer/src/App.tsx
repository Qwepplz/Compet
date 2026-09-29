import { Button, Card, message, Space, Spin, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import type { BootstrapAdminInput, MatchmakingOccupancy, SavedLoginCredentials, ServerRootRecoveryErrorCode, ServiceStatus } from "../../shared/types.js";
import { isManagerAuthRequired, managerApi } from "./api/managerApi.js";
import { AppShell } from "./components/AppShell.js";
import { AccountsPage } from "./pages/AccountsPage.js";
import { BootstrapPage } from "./pages/BootstrapPage.js";
import { ChangePasswordPage } from "./pages/ChangePasswordPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { LogsPage } from "./pages/LogsPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { displayError } from "../../../language/displayError.js";
import { useLanguage } from "../../../language/react.js";

const initialStatus: ServiceStatus = { state: "stopped", baseUrl: "https://127.0.0.1:18443" };
const initialMatchmakingOccupancy: MatchmakingOccupancy = { activeCount: 0 };
const MATCHMAKING_OCCUPANCY_POLL_MS = 2_000;
const serverRootRecoveryErrorMessages = {
  server_root_invalid: "errors.serverRootInvalid",
  server_root_check_failed: "errors.serverRootCheckFailed",
  server_root_recovery_busy: "errors.serverRootRecoveryBusy",
  server_root_save_failed: "errors.serverRootSaveFailed",
  server_root_selection_failed: "errors.serverRootSelectionFailed",
} as const satisfies Record<ServerRootRecoveryErrorCode, string>;

export function App() {
  const { t } = useLanguage();
  const [status, setStatus] = useState<ServiceStatus>(initialStatus);
  const [page, setPage] = useState("overview");
  const [loggedIn, setLoggedIn] = useState(false);
  const [bootstrapRequired, setBootstrapRequired] = useState<boolean | null>(null);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const [savedLogin, setSavedLogin] = useState<SavedLoginCredentials | null>(null);
  const [serviceActionPending, setServiceActionPending] = useState(false);
  const [serverRootRecoveryPending, setServerRootRecoveryPending] = useState(false);
  const serviceActionLock = useRef(false);
  const [matchmakingOccupancy, setMatchmakingOccupancy] = useState<MatchmakingOccupancy>(initialMatchmakingOccupancy);

  useEffect(() => {
    void refreshStatus();
    void loadSavedLogin();
    void refreshBootstrapRequired();
  }, []);

  useEffect(() => {
    const handleAuthRequired = () => {
      setLoggedIn(false);
      setPasswordChangeRequired(false);
      setPage("overview");
      setMatchmakingOccupancy(initialMatchmakingOccupancy);
      message.warning(t("manager.auth.loginExpired"));
    };

    managerApi.onAuthRequired(handleAuthRequired);
    return () => managerApi.removeAuthRequiredListener();
  }, [t]);

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
      message.error(displayError(error, t, "errors.serviceStatusLoadFailed"));
    }
  }
  async function refreshBootstrapRequired() {
    try {
      setBootstrapRequired(await managerApi.bootstrapRequired());
    } catch (error) {
      setBootstrapRequired(false);
      message.error(displayError(error, t, "errors.bootstrapStatusLoadFailed"));
    }
  }

  function beginServiceAction() {
    if (serviceActionLock.current) return false;
    serviceActionLock.current = true;
    setServiceActionPending(true);
    return true;
  }
  function finishServiceAction() {
    serviceActionLock.current = false;
    setServiceActionPending(false);
  }
  async function refreshFailedStatus() {
    if (!beginServiceAction()) return;
    try {
      await refreshStatus();
    } finally {
      finishServiceAction();
    }
  }
  async function changeServerRoot() {
    if (!beginServiceAction()) return;
    setServerRootRecoveryPending(true);
    try {
      const result = await managerApi.selectAndSaveServerRoot();
      if (result.status === "saved") {
        message.success(t("manager.service.serverRootSaved"));
        return;
      }
      if (result.status === "cancelled") return;
      message.error(t(serverRootRecoveryErrorMessages[result.code]));
    } catch (error) {
      message.error(displayError(error, t, "errors.serverRootRecoveryFailed"));
    } finally {
      setServerRootRecoveryPending(false);
      finishServiceAction();
    }
  }

  async function startService() {
    if (!beginServiceAction()) return;
    try {
      const nextStatus = await managerApi.startService();
      setStatus(nextStatus);
      if (loggedIn && nextStatus.state === "running") {
        await reauthenticateAfterServiceRestart();
      }
    } catch (error) {
      message.error(displayError(error, t, "errors.serviceStartFailed"));
      await refreshStatus();
    } finally {
      finishServiceAction();
    }
  }

  async function stopService() {
    if (!beginServiceAction()) return;
    try {
      setStatus(await managerApi.stopService());
    } catch (error) {
      message.error(displayError(error, t, "errors.serviceStopFailed"));
      await refreshStatus();
    } finally {
      finishServiceAction();
    }
  }
  async function restartService() {
    if (!beginServiceAction()) return;
    setPage("overview");
    try {
      const nextStatus = await managerApi.restartService();
      setStatus(nextStatus);
      if (nextStatus.state === "running") {
        await reauthenticateAfterServiceRestart();
      }
    } catch (error) {
      message.error(displayError(error, t, "errors.serviceRestartFailed"));
      await refreshStatus();
    } finally {
      finishServiceAction();
    }
  }

  async function bootstrap(input: BootstrapAdminInput) {
    if (!beginServiceAction()) return;
    let bootstrapWritten = false;
    try {
      await managerApi.writeBootstrap(input);
      bootstrapWritten = true;
      message.success(t("manager.auth.bootstrapWritten"));
      const nextStatus = await managerApi.startService();
      setStatus(nextStatus);
      if (nextStatus.state === "running") {
        await login(input.username, input.password, nextStatus);
      }
      setBootstrapRequired(false);
    } catch (error) {
      if (bootstrapWritten) {
        await refreshStatus();
        setBootstrapRequired(false);
      }
      message.error(displayError(error, t, "errors.bootstrapFailed"));
    } finally {
      finishServiceAction();
    }
  }

  async function login(username: string, password: string, knownStatus: ServiceStatus = status) {
    if (knownStatus.state !== "running") {
      try {
        const nextStatus = await managerApi.startService();
        setStatus(nextStatus);
        if (nextStatus.state !== "running") {
          message.error(t("errors.serviceStartFailed"));
          return;
        }
      } catch (error) {
        await refreshStatus();
        message.error(displayError(error, t, "errors.serviceStartFailed"));
        return;
      }
    }

    try {
      const result = await managerApi.login(username, password);
      setSavedLogin({ username, password });
      if (result.account.mustChangePassword) {
        setPasswordChangeRequired(true);
        message.warning(t("manager.auth.changePasswordRequired"));
        return;
      }
      setPasswordChangeRequired(false);
      setLoggedIn(true);
      setPage("overview");
    } catch (error) {
      message.error(displayError(error, t, "errors.loginFailed"));
    }
  }

  async function reauthenticateAfterServiceRestart() {
    const credentials = savedLogin ?? await managerApi.loadSavedLogin().catch(() => null);
    if (!credentials?.username || !credentials.password) {
      setLoggedIn(false);
      setPasswordChangeRequired(false);
      setPage("overview");
      message.warning(t("errors.restartReauthFailed"));
      return;
    }

    try {
      const result = await managerApi.login(credentials.username, credentials.password);
      setSavedLogin(credentials);
      if (result.account.mustChangePassword) {
        setLoggedIn(false);
        setPasswordChangeRequired(true);
        setPage("overview");
        message.warning(t("errors.restartReauthFailed"));
        return;
      }
      setPasswordChangeRequired(false);
      setLoggedIn(true);
    } catch (error) {
      setLoggedIn(false);
      setPasswordChangeRequired(false);
      setPage("overview");
      message.error(displayError(error, t, "errors.restartReauthFailed"));
    }
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    try {
      await managerApi.changePassword(currentPassword, newPassword);
      message.success(t("manager.auth.passwordUpdated"));
      setSavedLogin((credentials) => credentials ? { ...credentials, password: newPassword } : credentials);
      setPasswordChangeRequired(false);
      setLoggedIn(true);
      setPage("overview");
    } catch (error) {
      if (!isManagerAuthRequired()) message.error(displayError(error, t, "errors.passwordChangeFailed"));
    }
  }

  if (bootstrapRequired === null) {
    return <div className="auth-page"><Spin size="large" /></div>;
  }

  if (bootstrapRequired && !loggedIn) {
    return <BootstrapPage onSubmit={bootstrap} pending={serviceActionPending} />;
  }

  if (status.state === "failed" && !loggedIn) {
    return (
      <FailedStatusPage
        status={status}
        onStart={startService}
        onRefresh={refreshFailedStatus}
        onChangeServerRoot={changeServerRoot}
        pending={serviceActionPending}
        recoveryPending={serverRootRecoveryPending}
      />
    );
  }

  if (passwordChangeRequired && !loggedIn) {
    return <ChangePasswordPage onChangePassword={changePassword} />;
  }

  if (!loggedIn) {
    return <LoginPage status={status} savedLogin={savedLogin} onLogin={login} />;
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

function FailedStatusPage({
  status,
  onStart,
  onRefresh,
  onChangeServerRoot,
  pending,
  recoveryPending,
}: {
  status: ServiceStatus;
  onStart: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onChangeServerRoot: () => Promise<void>;
  pending: boolean;
  recoveryPending: boolean;
}) {
  const { t } = useLanguage();
  return (
    <div className="auth-page">
      <Card className="auth-card" title={t("manager.service.startFailedTitle")}>
        <Typography.Paragraph type="secondary">
          {t("manager.service.startFailedDescription")}
        </Typography.Paragraph>
        <Typography.Paragraph className="error-text">
          {status.lastError ?? t("manager.service.noErrorDetails")}
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Button type="primary" block onClick={onStart} disabled={pending}>{t("manager.service.startRetry")}</Button>
          <Button block onClick={onRefresh} disabled={pending}>{t("manager.service.refreshStatus")}</Button>
          <Button block onClick={onChangeServerRoot} disabled={pending} loading={recoveryPending}>{t(recoveryPending ? "manager.service.changingServerRoot" : "manager.service.changeServerRoot")}</Button>
        </Space>
      </Card>
    </div>
  );
}
