import { Button, Card, Form, Input, Space, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import type { SavedLoginCredentials, ServiceStatus } from "../../../shared/types.js";

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
export function LoginPage({ status, savedLogin, onStart, onLogin }: { status: ServiceStatus; savedLogin: SavedLoginCredentials | null; onStart: () => Promise<void>; onLogin: (username: string, password: string) => Promise<void> }) {
  const [form] = Form.useForm<LoginValues>();
  const [startPending, setStartPending] = useState(false);
  const [loginPending, setLoginPending] = useState(false);
  const serviceReady = status.state === "running";

  useEffect(() => {
    form.setFieldsValue({
      username: savedLogin?.username,
      password: savedLogin?.password,
    });
  }, [form, savedLogin]);

  async function handleStart() {
    if (startPending) return;
    setStartPending(true);
    try {
      await onStart();
    } finally {
      setStartPending(false);
    }
  }

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
      <Card className="auth-card" title="管理员登录">
        <Space className="status-row" style={{ marginBottom: 12 }}>
          <Tag color={statusColor[status.state]}>{status.state}</Tag>
          <Typography.Text className="status-url" type="secondary">{status.baseUrl}</Typography.Text>
        </Space>
        <Form<LoginValues> form={form} layout="vertical" onFinish={handleLogin}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}> 
            <Input autoComplete="username" disabled={!serviceReady || loginPending} />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}> 
            <Input.Password autoComplete="current-password" disabled={!serviceReady || loginPending} />
          </Form.Item>
          <Space style={{ width: "100%" }} direction="vertical">
            <Button type="primary" htmlType="submit" block loading={loginPending} disabled={!serviceReady || startPending}>
              登录
            </Button>
            <Button block onClick={handleStart} loading={startPending} disabled={status.state === "running" || status.state === "starting" || loginPending}>
              启动服务
            </Button>
          </Space>
        </Form>
      </Card>
    </div>
  );
}
