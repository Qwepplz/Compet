import { Button, Card, Form, Input, Typography } from "antd";
import { useState } from "react";
import { useLanguage } from "../../../../language/react.js";

interface ChangePasswordValues {
  currentPassword: string;
  newPassword: string;
}

export function ChangePasswordPage({ onChangePassword }: { onChangePassword: (currentPassword: string, newPassword: string) => Promise<void> }) {
  const { t } = useLanguage();
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
      <Card className="auth-card" title={t("manager.auth.changePasswordTitle")}>
        <Typography.Paragraph type="secondary">
          {t("manager.auth.changePasswordDescription")}
        </Typography.Paragraph>
        <Form<ChangePasswordValues> layout="vertical" onFinish={handleFinish}>
          <Form.Item name="currentPassword" label={t("common.labels.currentPassword")} rules={[{ required: true, message: t("common.labels.currentPassword") }]}>
            <Input.Password autoComplete="current-password" disabled={pending} />
          </Form.Item>
          <Form.Item name="newPassword" label={t("common.labels.newPassword")} rules={[{ required: true, min: 8, message: t("manager.accounts.passwordRule") }]}>
            <Input.Password autoComplete="new-password" disabled={pending} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={pending}>
            {t("common.actions.saveAndEnter")}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
