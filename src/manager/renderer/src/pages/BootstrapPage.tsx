import { Button, Card, Form, Input, Typography } from "antd";
import type { BootstrapAdminInput } from "../../../shared/types.js";
import { useLanguage } from "../../../../language/react.js";

export function BootstrapPage({ onSubmit, pending }: { onSubmit: (input: BootstrapAdminInput) => Promise<void>; pending: boolean }) {
  const { t } = useLanguage();
  return (
    <div className="auth-page">
      <Card className="auth-card" title={t("manager.auth.bootstrapTitle")}>
        <Typography.Paragraph type="secondary">
          {t("manager.auth.bootstrapDescription")}
        </Typography.Paragraph>
        <Form<BootstrapAdminInput> layout="vertical" onFinish={onSubmit} disabled={pending}>
          <Form.Item name="username" label={t("manager.auth.bootstrapUsername")} rules={[{ required: true, message: t("common.labels.username") }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label={t("manager.auth.bootstrapPassword")} rules={[{ required: true, min: 8, message: t("manager.accounts.passwordRule") }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={pending}>
            {t("manager.auth.bootstrapSubmit")}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
