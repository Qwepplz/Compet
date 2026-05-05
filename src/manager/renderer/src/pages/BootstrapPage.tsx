import { Button, Card, Form, Input, Typography } from "antd";
import type { BootstrapAdminInput } from "../../../shared/types.js";

export function BootstrapPage({ onSubmit }: { onSubmit: (input: BootstrapAdminInput) => Promise<void> }) {
  return (
    <div className="auth-page">
      <Card className="auth-card" title="初始化管理员">
        <Typography.Paragraph type="secondary">
          服务尚未发现可用管理员账号。创建 bootstrap 文件后会自动尝试启动服务。
        </Typography.Paragraph>
        <Form<BootstrapAdminInput> layout="vertical" onFinish={onSubmit}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}> 
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, min: 8, message: "请输入至少 8 位密码" }]}> 
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名">
            <Input autoComplete="name" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            创建并启动服务
          </Button>
        </Form>
      </Card>
    </div>
  );
}
