import { Button, Card, Form, Input, Space, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import type { SavedLoginCredentials, ServiceStatus } from "../../../shared/types.js";
import { useLanguage } from "../../../../language/react.js";
import { serviceStatusLabel } from "../serviceStatus.js";

interface LoginValues {
  username: string;
  password: string;
}

const statusColor: Record<ServiceStatus["state"], string> = {
  stopped: "default",
  starting: "processing",
  running: "success",
  stopping: "warning",
  failed: "error",
};
export function LoginPage({ status, savedLogin, onLogin }: { status: ServiceStatus; savedLogin: SavedLoginCredentials | null; onLogin: (username: string, password: string) => Promise<void> }) {
  const { t } = useLanguage();
  const [form] = Form.useForm<LoginValues>();
  const [loginPending, setLoginPending] = useState(false);

  useEffect(() => {
    form.setFieldsValue({
      username: savedLogin?.username,
      password: savedLogin?.password,
    });
  }, [form, savedLogin]);

  async function handleLogin(values: LoginValues) {
    if (loginPending) return;
    setLoginPending(true);
    try {
      await onLogin(values.username, values.password);
    } finally {
      setLoginPending(false);
    }
  }

  return (
    <div className="auth-page">
      <Card className="auth-card" title={t("manager.auth.loginTitle")}>
        <Space className="status-row" style={{ marginBottom: 12 }}>
          <Tag color={statusColor[status.state]}>{serviceStatusLabel(status.state, t)}</Tag>
          <Typography.Text className="status-url" type="secondary">{status.baseUrl}</Typography.Text>
        </Space>
        <Form<LoginValues> form={form} layout="vertical" onFinish={handleLogin}>
          <Form.Item name="username" label={t("common.labels.username")} rules={[{ required: true, message: t("common.labels.username") }]}>
            <Input autoComplete="username" disabled={loginPending} />
          </Form.Item>
          <Form.Item name="password" label={t("common.labels.password")} rules={[{ required: true, message: t("common.labels.password") }]}>
            <Input.Password autoComplete="current-password" disabled={loginPending} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loginPending} disabled={loginPending}>
            {t("common.actions.login")}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
