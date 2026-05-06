import { Alert, Button, Form, Input, InputNumber, Space, Spin, message } from "antd";
import { useEffect, useState } from "react";
import type { ManagerConfig } from "../../../shared/types.js";
import { managerApi } from "../api/managerApi.js";

interface SettingsFormValues {
  dataDir: string;
  host: string;
  port: number;
  tokenTtlMinutes: number;
  serverRoot: string;
  publicConnectHost: string;
  gamePortStart: number;
}

export function SettingsPage() {
  const [form] = Form.useForm<SettingsFormValues>();
  const [loadedConfig, setLoadedConfig] = useState<ManagerConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function loadConfig() {
    setLoading(true);
    setError(undefined);
    try {
      const config = await managerApi.loadConfig();
      setLoadedConfig(config);
      form.setFieldsValue({
        dataDir: config.dataDir,
        host: config.host,
        port: config.port,
        tokenTtlMinutes: config.tokenTtlMinutes,
        serverRoot: config.serverRoot,
        publicConnectHost: config.publicConnectHost,
        gamePortStart: config.gamePortStart,
      });
    } catch (caught) {
      const messageText = caught instanceof Error ? caught.message : "读取配置失败";
      setError(messageText);
      message.error(messageText);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadConfig();
  }, []);

  async function selectServerRoot() {
    try {
      const selected = await managerApi.selectServerRoot();
      if (selected) {
        form.setFieldsValue({ serverRoot: selected });
      }
    } catch (caught) {
      const messageText = caught instanceof Error ? caught.message : "选择目录失败";
      message.error(messageText);
    }
  }

  async function submit(values: SettingsFormValues) {
    if (!loadedConfig) {
      message.error("配置尚未加载");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const nextConfig: ManagerConfig = {
        ...loadedConfig,
        dataDir: values.dataDir.trim(),
        host: values.host.trim(),
        port: values.port,
        tokenTtlMinutes: values.tokenTtlMinutes,
        serverRoot: values.serverRoot.trim(),
        publicConnectHost: values.publicConnectHost.trim(),
        gamePortStart: values.gamePortStart,
        gamePortEnd: values.gamePortStart,
      };
      await managerApi.saveConfig(nextConfig);
      setLoadedConfig(nextConfig);
      message.success("配置已保存，重启托管服务后生效");
    } catch (caught) {
      const messageText = caught instanceof Error ? caught.message : "保存配置失败";
      setError(messageText);
      message.error(messageText);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="settings-page">
      <h1 className="page-title">设置</h1>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <div className="settings-body">
        <Spin spinning={loading}>
          <Form<SettingsFormValues>
            form={form}
            layout="vertical"
            onFinish={submit}
            disabled={loading || submitting}
            className="settings-form"
            style={{ maxWidth: 560 }}
          >
            <Form.Item name="dataDir" label="数据目录" rules={[{ required: true, whitespace: true, message: "请输入数据目录" }]}>
              <Input />
            </Form.Item>
            <Form.Item name="host" label="匹配服务绑定 IP" rules={[{ required: true, whitespace: true, message: "请输入匹配服务绑定 IP" }]}>
              <Input />
            </Form.Item>
            <Form.Item
              name="port"
              label="匹配服务端口"
              rules={[
                { required: true, message: "请输入端口" },
                { type: "number", min: 1, max: 65535, message: "端口范围为 1-65535" },
              ]}
            >
              <InputNumber min={1} max={65535} precision={0} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item
              name="tokenTtlMinutes"
              label="Token 有效期分钟"
              rules={[
                { required: true, message: "请输入 Token 有效期" },
                { type: "number", min: 1, message: "Token 有效期至少 1 分钟" },
              ]}
            >
              <InputNumber min={1} precision={0} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label="CSGO 服务端目录" required>
              <Space.Compact style={{ width: "100%" }}>
                <Form.Item name="serverRoot" noStyle rules={[{ required: true, whitespace: true, message: "请输入 CSGO 服务端目录" }]}>
                  <Input />
                </Form.Item>
                <Button onClick={() => void selectServerRoot()} disabled={loading || submitting}>
                  选择目录
                </Button>
              </Space.Compact>
            </Form.Item>
            <Form.Item name="publicConnectHost" label="游戏服对外 IP / 域名" rules={[{ required: true, whitespace: true, message: "请输入游戏服对外 IP 或域名" }]}>
              <Input />
            </Form.Item>
            <Space size={12} align="start">
              <Form.Item name="gamePortStart" label="游戏服端口" rules={[{ required: true, message: "请输入端口" }, { type: "number", min: 1, max: 65535, message: "端口范围为 1-65535" }]}>
                <InputNumber min={1} max={65535} precision={0} style={{ width: 180 }} />
              </Form.Item>
            </Space>
            <div className="settings-actions">
              <Space>
                <Button type="primary" htmlType="submit" loading={submitting} disabled={loading || submitting || !loadedConfig}>
                  保存
                </Button>
                <Button onClick={() => void loadConfig()} disabled={loading || submitting}>
                  重新加载
                </Button>
              </Space>
            </div>
          </Form>
        </Spin>
      </div>
    </div>
  );
}
