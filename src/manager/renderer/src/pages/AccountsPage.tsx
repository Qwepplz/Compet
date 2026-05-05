import { Button, Form, Input, Modal, Select, Space, Switch, Table, message } from "antd";
import type { TableProps } from "antd";
import { useEffect, useRef, useState } from "react";
import type { AccountRole, AccountView, CreateAccountInput, UpdateAccountInput } from "../../../shared/types.js";
import { accountApi } from "../api/managerApi.js";

interface AccountFormValues {
  id?: string;
  username: string;
  password?: string;
  displayName?: string;
  steam64?: string;
  role: AccountRole;
}

export function AccountsPage() {
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
  const [resettingIds, setResettingIds] = useState<Set<string>>(new Set());
  const [revokingIds, setRevokingIds] = useState<Set<string>>(new Set());
  const updatingIdsRef = useRef<Set<string>>(new Set());
  const resettingIdsRef = useRef<Set<string>>(new Set());
  const revokingIdsRef = useRef<Set<string>>(new Set());
  const [form] = Form.useForm<AccountFormValues>();
  const role = Form.useWatch("role", form);

  async function refresh() {
    setLoading(true);
    try {
      setAccounts(await accountApi.list());
    } catch (error) {
      message.error(error instanceof Error ? error.message : "读取账号失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function beginUpdating(id: string) {
    if (updatingIdsRef.current.has(id)) return false;
    updatingIdsRef.current.add(id);
    setUpdatingIds(new Set(updatingIdsRef.current));
    return true;
  }

  function endUpdating(id: string) {
    updatingIdsRef.current.delete(id);
    setUpdatingIds(new Set(updatingIdsRef.current));
  }

  function beginResetting(id: string) {
    if (resettingIdsRef.current.has(id)) return false;
    resettingIdsRef.current.add(id);
    setResettingIds(new Set(resettingIdsRef.current));
    return true;
  }

  function endResetting(id: string) {
    resettingIdsRef.current.delete(id);
    setResettingIds(new Set(resettingIdsRef.current));
  }

  function beginRevoking(id: string) {
    if (revokingIdsRef.current.has(id)) return false;
    revokingIdsRef.current.add(id);
    setRevokingIds(new Set(revokingIdsRef.current));
    return true;
  }

  function endRevoking(id: string) {
    revokingIdsRef.current.delete(id);
    setRevokingIds(new Set(revokingIdsRef.current));
  }

  const columns: TableProps<AccountView>["columns"] = [
    { title: "用户名", dataIndex: "username" },
    { title: "显示名", dataIndex: "displayName" },
    { title: "Steam64", dataIndex: "steam64", render: (value?: string) => value || "-" },
    { title: "角色", dataIndex: "role" },
    {
      title: "启用",
      dataIndex: "enabled",
      render: (value: boolean, row: AccountView) => {
        const updating = updatingIds.has(row.id);
        return (
          <Switch checked={value} loading={updating} disabled={updating} onChange={(enabled) => void toggleEnabled(row, enabled)} />
        );
      },
    },
    {
      title: "操作",
      render: (_: unknown, row: AccountView) => {
        const resetting = resettingIds.has(row.id);
        const revoking = revokingIds.has(row.id);
        return (
          <Space>
            <Button onClick={() => edit(row)}>编辑</Button>
            <Button loading={resetting} disabled={resetting} onClick={() => reset(row)}>重置密码</Button>
            <Button loading={revoking} disabled={revoking} onClick={() => revoke(row)}>撤销会话</Button>
          </Space>
        );
      },
    },
  ];

  function create() {
    setIsEditing(false);
    form.resetFields();
    form.setFieldsValue({ role: "player", steam64: undefined });
    setOpen(true);
  }

  function edit(row: AccountView) {
    setIsEditing(true);
    form.resetFields();
    form.setFieldsValue({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      steam64: row.steam64,
      role: row.role,
    });
    setOpen(true);
  }

  async function toggleEnabled(row: AccountView, enabled: boolean) {
    if (!beginUpdating(row.id)) return;
    try {
      await accountApi.update(row.id, { enabled });
    } catch (error) {
      message.error(error instanceof Error ? error.message : "更新账号失败");
    } finally {
      await refresh();
      endUpdating(row.id);
    }
  }

  async function reset(row: AccountView) {
    if (!beginResetting(row.id)) return;
    try {
      const password = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      await accountApi.resetPassword(row.id, password);
      Modal.info({ title: "临时密码", content: password });
    } catch (error) {
      message.error(error instanceof Error ? error.message : "重置密码失败");
    } finally {
      endResetting(row.id);
    }
  }

  async function revoke(row: AccountView) {
    if (!beginRevoking(row.id)) return;
    try {
      const result = await accountApi.revokeSessions(row.id);
      message.success(`已撤销 ${result.revoked} 个会话`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "撤销会话失败");
    } finally {
      endRevoking(row.id);
    }
  }

  async function submit(values: AccountFormValues) {
    setSubmitting(true);
    try {
      if (values.id) {
        const input: UpdateAccountInput = {
          displayName: values.displayName?.trim() || undefined,
          steam64: values.role === "player" ? values.steam64?.trim() ?? "" : "",
          role: values.role,
        };
        await accountApi.update(values.id, input);
      } else {
        const input: CreateAccountInput = {
          username: values.username.trim(),
          password: values.password ?? "",
          displayName: values.displayName?.trim() || values.username.trim(),
          steam64: values.role === "player" ? values.steam64?.trim() || undefined : undefined,
          role: values.role,
        };
        await accountApi.create(input);
      }
      setOpen(false);
      await refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存账号失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="status-row">
        <h1 className="page-title">账号</h1>
        <Button type="primary" onClick={create}>创建账号</Button>
      </div>
      <Table rowKey="id" columns={columns} dataSource={accounts} loading={loading} pagination={false} />
      <Modal
        title="账号"
        open={open}
        onOk={() => form.submit()}
        onCancel={() => setOpen(false)}
        confirmLoading={submitting}
        destroyOnClose
      >
        <Form<AccountFormValues> form={form} layout="vertical" onFinish={submit}>
          <Form.Item name="id" hidden><Input /></Form.Item>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input disabled={isEditing} />
          </Form.Item>
          {!isEditing && (
            <Form.Item
              name="password"
              label="初始密码"
              rules={[
                { required: true, message: "请输入初始密码" },
                { min: 8, message: "初始密码至少 8 位" },
              ]}
            >
              <Input.Password />
            </Form.Item>
          )}
          <Form.Item name="displayName" label="显示名"><Input /></Form.Item>
          <Form.Item name="role" label="角色" initialValue="player">
            <Select options={[{ value: "player", label: "player" }, { value: "admin", label: "admin" }]} />
          </Form.Item>
          {role === "player" ? <Form.Item name="steam64" label="Steam64"><Input /></Form.Item> : null}
        </Form>
      </Modal>
    </>
  );
}
