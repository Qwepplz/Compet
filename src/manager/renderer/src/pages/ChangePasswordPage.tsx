import { Button, Card, Form, Input, Typography } from "antd";
import { useState } from "react";

interface ChangePasswordValues {
  currentPassword: string;
  newPassword: string;
}

export function ChangePasswordPage({ onChangePassword }: { onChangePassword: (currentPassword: string, newPassword: string) => Promise<void> }) {
  const [pending, setPending] = useState(false);

  async function handleFinish(values: ChangePasswordValues) {
    if (pending) return;
    setPending(true);
    try {
      await onChangePassword(values.currentPassword, values.newPassword);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="auth-page">
      <Card className="auth-card" title="修改初始密码">
        <Typography.Paragraph type="secondary">
          该管理员账号首次登录前需要设置新密码。
        </Typography.Paragraph>
        <Form<ChangePasswordValues> layout="vertical" onFinish={handleFinish}>
          <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: "请输入当前密码" }]}> 
            <Input.Password autoComplete="current-password" disabled={pending} />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 8, message: "请输入至少 8 位新密码" }]}> 
            <Input.Password autoComplete="new-password" disabled={pending} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={pending}>
            保存并进入
          </Button>
        </Form>
      </Card>
    </div>
  );
}
