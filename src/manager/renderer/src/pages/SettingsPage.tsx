import { Alert, Button, Form, Input, InputNumber, Space, Spin, message } from "antd";
import { useEffect, useState } from "react";
import type { ManagerConfig } from "../../../shared/types.js";
import { managerApi, type UpdateCheckResult } from "../api/managerApi.js";
import { displayError } from "../../../../language/displayError.js";
import { LanguageSelector } from "../../../../language/LanguageSelector.js";
import { useLanguage } from "../../../../language/react.js";

interface SettingsFormValues {
  dataDir: string;
  host: string;
  port: number;
  tokenTtlMinutes: number;
  serverRoot: string;
  publicConnectHost: string;
  gamePortStart: number;
  steamAccountToken: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SettingsPage() {
  const { language, setLanguage, t } = useLanguage();
  const [form] = Form.useForm<SettingsFormValues>();
  const [loadedConfig, setLoadedConfig] = useState<ManagerConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [currentVersion, setCurrentVersion] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [languageSaving, setLanguageSaving] = useState(false);

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
        steamAccountToken: config.steamAccountToken,
      });
    } catch (caught) {
      const messageText = displayError(caught, t, "errors.configLoadFailed");
      setError(messageText);
      message.error(messageText);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadConfig();
    void managerApi.getVersion().then(setCurrentVersion);
  }, []);

  async function selectServerRoot() {
    try {
      const selected = await managerApi.selectServerRoot();
      if (selected) {
        form.setFieldsValue({ serverRoot: selected });
      }
    } catch (caught) {
      const messageText = displayError(caught, t, "errors.configSelectRootFailed");
      message.error(messageText);
    }
  }

  async function submit(values: SettingsFormValues) {
    if (!loadedConfig) {
      message.error(t("manager.settings.notLoaded"));
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
        steamAccountToken: values.steamAccountToken.trim(),
      };
      await managerApi.saveConfig(nextConfig);
      setLoadedConfig(nextConfig);
      message.success(t("manager.settings.saved"));
    } catch (caught) {
      const messageText = displayError(caught, t, "errors.configSaveFailed");
      setError(messageText);
      message.error(messageText);
    } finally {
      setSubmitting(false);
    }
  }

  async function checkUpdate() {
    setCheckingUpdate(true);
    setUpdateResult(null);
    try {
      const result = await managerApi.checkUpdate();
      setUpdateResult(result);
      message.success(result.updateAvailable ? t("manager.settings.updateFound") : t("manager.settings.latest"));
    } catch (caught) {
      const messageText = displayError(caught, t, "errors.updateCheckFailed");
      message.error(messageText);
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function installUpdate() {
    setInstallingUpdate(true);
    try {
      await managerApi.installUpdate();
      message.info(t("manager.settings.updateDownloaded"));
    } catch (caught) {
      const messageText = displayError(caught, t, "errors.updateInstallFailed");
      message.error(messageText);
      setInstallingUpdate(false);
    }
  }

  async function changeLanguage(nextLanguage: typeof language) {
    if (nextLanguage === language || languageSaving) return;
    setLanguageSaving(true);
    try {
      await setLanguage(nextLanguage);
    } catch {
      message.error(t("errors.languageSaveFailed"));
    } finally {
      setLanguageSaving(false);
    }
  }

  return (
    <div className="settings-page">
      <h1 className="page-title">{t("manager.settings.titleLabel")}</h1>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <div className="settings-body">
        <div className="manager-language-setting">
          <span>{t("common.language.label")}</span>
          <LanguageSelector
            disabled={languageSaving}
            onChange={(nextLanguage) => void changeLanguage(nextLanguage)}
          />
        </div>
        <Spin spinning={loading}>
          <Form<SettingsFormValues>
            form={form}
            layout="vertical"
            onFinish={submit}
            disabled={loading || submitting}
            className="settings-form"
            style={{ maxWidth: 560 }}
          >
            <Form.Item name="dataDir" label={t("manager.settings.dataDir")} rules={[{ required: true, whitespace: true, message: t("manager.settings.validation.required") }]}>
              <Input />
            </Form.Item>
            <Form.Item name="host" label={t("manager.settings.host")} rules={[{ required: true, whitespace: true, message: t("manager.settings.validation.required") }]}>
              <Input />
            </Form.Item>
            <Form.Item
              name="port"
              label={t("manager.settings.matchPort")}
              rules={[
                { required: true, message: t("manager.settings.validation.port") },
                { type: "number", min: 1, max: 65535, message: t("manager.settings.validation.portRange") },
              ]}
            >
              <InputNumber min={1} max={65535} precision={0} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item
              name="tokenTtlMinutes"
              label={t("manager.settings.tokenLifetime")}
              rules={[
                { required: true, message: t("manager.settings.validation.tokenLifetime") },
                { type: "number", min: 1, message: t("manager.settings.validation.tokenMinimum") },
              ]}
            >
              <InputNumber min={1} precision={0} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label={t("manager.settings.serverRoot")} required>
              <Space.Compact style={{ width: "100%" }}>
                <Form.Item name="serverRoot" noStyle rules={[{ required: true, whitespace: true, message: t("manager.settings.validation.serverRoot") }]}>
                  <Input />
                </Form.Item>
                <Button onClick={() => void selectServerRoot()} disabled={loading || submitting}>
                  {t("manager.settings.chooseDirectory")}
                </Button>
              </Space.Compact>
            </Form.Item>
            <Form.Item name="publicConnectHost" label={t("manager.settings.publicHost")} rules={[{ required: true, whitespace: true, message: t("manager.settings.validation.publicHost") }]}>
              <Input />
            </Form.Item>
            <Form.Item name="steamAccountToken" label={t("manager.settings.steamToken")}>
              <Input.Password autoComplete="off" />
            </Form.Item>
            <Space size={12} align="start">
              <Form.Item name="gamePortStart" label={t("manager.settings.gamePort")} rules={[{ required: true, message: t("manager.settings.validation.port") }, { type: "number", min: 1, max: 65535, message: t("manager.settings.validation.portRange") }]}>
                <InputNumber min={1} max={65535} precision={0} style={{ width: 180 }} />
              </Form.Item>
            </Space>
            <Form.Item label={t("manager.settings.softwareUpdate")}>
              <div className="settings-version">{t("manager.settings.currentVersion", { version: currentVersion || t("common.state.loading") })}</div>
              <Space.Compact>
                <Button size="small" onClick={() => void checkUpdate()} loading={checkingUpdate} disabled={loading || submitting || checkingUpdate}>
                  {t("manager.settings.checkUpdate")}
                </Button>
                <Button
                  size="small"
                  type="primary"
                  onClick={() => void installUpdate()}
                  loading={installingUpdate}
                  disabled={loading || submitting || checkingUpdate || installingUpdate || updateResult?.updateAvailable !== true}
                >
                  {t("manager.settings.downloadInstall")}
                </Button>
              </Space.Compact>
            </Form.Item>
            {updateResult ? (
              <Alert
                type={updateResult.updateAvailable ? "info" : "success"}
                showIcon
                message={
                  updateResult.updateAvailable
                    ? t("manager.settings.updateSummary", {
                        version: updateResult.latestVersion,
                        files: updateResult.changedFiles,
                        bytes: formatBytes(updateResult.changedBytes),
                      })
                    : t("manager.settings.latestSummary", { version: updateResult.currentVersion })
                }
              />
            ) : null}
            <div className="settings-actions">
              <Space>
                <Button type="primary" htmlType="submit" loading={submitting} disabled={loading || submitting || !loadedConfig}>
                  {t("common.actions.save")}
                </Button>
                <Button onClick={() => void loadConfig()} disabled={loading || submitting}>
                  {t("common.actions.reload")}
                </Button>
              </Space>
            </div>
          </Form>
        </Spin>
      </div>
    </div>
  );
}
