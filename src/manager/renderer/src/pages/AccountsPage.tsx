import { Button, Form, Input, Modal, Pagination, Space, Switch, Table, message } from "antd";
import type { TableProps } from "antd";
import { useEffect, useRef, useState } from "react";
import { USERNAME_PATTERN } from "../../../../accounts/accountTypes.js";
import type { AccountMatchDetail, AccountMatchHistory, AccountView, CreateAccountInput, UpdateAccountInput } from "../../../shared/types.js";
import { accountApi } from "../api/managerApi.js";

interface AccountFormValues {
  id?: string;
  username: string;
  password?: string;
  steam64?: string;
}

type MatchDetailPlayer = AccountMatchDetail["result"]["players"][number];

function rating2SortValue(player: MatchDetailPlayer): number {
  return typeof player.rating2 === "number" && Number.isFinite(player.rating2) ? player.rating2 : Number.NEGATIVE_INFINITY;
}

function sortPlayersByRating2(players: MatchDetailPlayer[]): MatchDetailPlayer[] {
  return [...players].sort((left, right) => rating2SortValue(right) - rating2SortValue(left));
}

export function AccountsPage() {
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [matchHistoryAccount, setMatchHistoryAccount] = useState<AccountView | null>(null);
  const [matchHistory, setMatchHistory] = useState<AccountMatchHistory | null>(null);
  const [matchHistoryLoading, setMatchHistoryLoading] = useState(false);
  const [matchDetail, setMatchDetail] = useState<AccountMatchDetail | null>(null);
  const [matchDetailLoading, setMatchDetailLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
  const [resettingIds, setResettingIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const updatingIdsRef = useRef<Set<string>>(new Set());
  const resettingIdsRef = useRef<Set<string>>(new Set());
  const deletingIdsRef = useRef<Set<string>>(new Set());
  const matchHistoryRequestIdRef = useRef(0);
  const matchDetailRequestIdRef = useRef(0);
  const [form] = Form.useForm<AccountFormValues>();

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

  function beginDeleting(id: string) {
    if (deletingIdsRef.current.has(id)) return false;
    deletingIdsRef.current.add(id);
    setDeletingIds(new Set(deletingIdsRef.current));
    return true;
  }

  function endDeleting(id: string) {
    deletingIdsRef.current.delete(id);
    setDeletingIds(new Set(deletingIdsRef.current));
  }

  const columns: TableProps<AccountView>["columns"] = [
    { title: "用户名", dataIndex: "username" },
    { title: "Steam64", dataIndex: "steam64", render: (value?: string) => value || "-" },
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
      title: "Dev 模式",
      dataIndex: "dev",
      render: (value: boolean | undefined, row: AccountView) => {
        if (row.role !== "player") return "-";
        const updating = updatingIds.has(row.id);
        return (
          <Switch checked={Boolean(value)} loading={updating} disabled={updating} onChange={(dev) => void toggleDev(row, dev)} />
        );
      },
    },
    {
      title: "操作",
      render: (_: unknown, row: AccountView) => {
        const resetting = resettingIds.has(row.id);
        const deleting = deletingIds.has(row.id);
        return (
          <Space>
            {row.role === "player" ? <Button onClick={() => void openMatchHistory(row, 1)}>历史战绩</Button> : null}
            {row.role === "player" ? <Button onClick={() => edit(row)}>编辑</Button> : null}
            <Button loading={resetting} disabled={resetting} onClick={() => reset(row)}>重置密码</Button>
            <Button danger loading={deleting} disabled={deleting || row.role === "admin"} onClick={() => remove(row)}>删除账号</Button>
          </Space>
        );
      },
    },
  ];

  async function openMatchHistory(account: AccountView, page: number) {
    const requestId = ++matchHistoryRequestIdRef.current;
    setMatchHistoryAccount(account);
    setMatchHistoryLoading(true);
    if (page === 1) setMatchHistory(null);
    try {
      const history = await accountApi.matches(account.id, page);
      if (requestId === matchHistoryRequestIdRef.current) setMatchHistory(history);
    } catch (error) {
      if (requestId === matchHistoryRequestIdRef.current) {
        message.error(error instanceof Error ? error.message : "读取历史战绩失败");
      }
    } finally {
      if (requestId === matchHistoryRequestIdRef.current) setMatchHistoryLoading(false);
    }
  }

  async function openMatchDetail(matchId: string) {
    if (!matchHistoryAccount) return;
    const requestId = ++matchDetailRequestIdRef.current;
    setMatchDetail(null);
    setMatchDetailLoading(true);
    try {
      const detail = await accountApi.matchDetail(matchHistoryAccount.id, matchId);
      if (requestId === matchDetailRequestIdRef.current) setMatchDetail(detail);
    } catch (error) {
      if (requestId === matchDetailRequestIdRef.current) {
        message.error(error instanceof Error ? error.message : "读取战绩详情失败");
      }
    } finally {
      if (requestId === matchDetailRequestIdRef.current) setMatchDetailLoading(false);
    }
  }

  function closeMatchHistory() {
    matchHistoryRequestIdRef.current += 1;
    setMatchHistoryAccount(null);
    setMatchHistory(null);
    setMatchHistoryLoading(false);
    closeMatchDetail();
  }

  function closeMatchDetail() {
    matchDetailRequestIdRef.current += 1;
    setMatchDetail(null);
    setMatchDetailLoading(false);
  }

  function create() {
    setIsEditing(false);
    form.resetFields();
    form.setFieldsValue({ steam64: undefined });
    setOpen(true);
  }

  function edit(row: AccountView) {
    setIsEditing(true);
    form.resetFields();
    form.setFieldsValue({
      id: row.id,
      username: row.username,
      steam64: row.steam64,
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

  async function toggleDev(row: AccountView, dev: boolean) {
    if (!beginUpdating(row.id)) return;
    try {
      await accountApi.update(row.id, { dev });
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

  function remove(row: AccountView) {
    Modal.confirm({
      title: "删除账号",
      content: `确定删除账号 ${row.username}？该账号会立即无法继续登录。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        if (!beginDeleting(row.id)) return;
        try {
          await accountApi.delete(row.id);
          message.success("账号已删除");
          await refresh();
        } catch (error) {
          message.error(error instanceof Error ? error.message : "删除账号失败");
        } finally {
          endDeleting(row.id);
        }
      },
    });
  }

  async function submit(values: AccountFormValues) {
    setSubmitting(true);
    try {
      if (values.id) {
        const input: UpdateAccountInput = {
          steam64: values.steam64?.trim() ?? "",
        };
        await accountApi.update(values.id, input);
      } else {
        const input: CreateAccountInput = {
          username: values.username.trim(),
          password: values.password ?? "",
          steam64: values.steam64?.trim() || undefined,
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

  const matchDetailTeamSections = matchDetail ? [
    {
      team: "teamA" as const,
      name: matchDetail.result.team1Name,
      score: matchDetail.result.team1Score,
      firstHalfScore: matchDetail.result.firstHalfScore?.team1Score,
      secondHalfScore: matchDetail.result.secondHalfScore?.team1Score,
      players: sortPlayersByRating2(matchDetail.result.players.filter((player) => player.team === "teamA")),
    },
    {
      team: "teamB" as const,
      name: matchDetail.result.team2Name,
      score: matchDetail.result.team2Score,
      firstHalfScore: matchDetail.result.firstHalfScore?.team2Score,
      secondHalfScore: matchDetail.result.secondHalfScore?.team2Score,
      players: sortPlayersByRating2(matchDetail.result.players.filter((player) => player.team === "teamB")),
    },
  ] : [];

  return (
    <>
      <div className="status-row">
        <h1 className="page-title">账号</h1>
        <Button type="primary" onClick={create}>创建账号</Button>
      </div>
      <Table rowKey="id" columns={columns} dataSource={accounts} loading={loading} pagination={false} />
      <Modal
        title={matchHistoryAccount ? `${matchHistoryAccount.username} 的历史战绩` : "历史战绩"}
        open={matchHistoryAccount !== null}
        footer={null}
        width={1000}
        onCancel={closeMatchHistory}
      >
        <Table
          rowKey="matchId"
          loading={matchHistoryLoading}
          dataSource={matchHistory?.matches ?? []}
          pagination={false}
          locale={{ emptyText: "暂无战绩" }}
          columns={[
            { title: "日期", dataIndex: "completedAt", render: (value: string) => new Date(value).toLocaleString() },
            { title: "地图", dataIndex: "mapName" },
            { title: "结果", render: (_, row) => row.selfWon ? "胜利" : "失败" },
            { title: "比分", render: (_, row) => row.selfTeam === "teamA" ? `${row.score.team1} : ${row.score.team2}` : `${row.score.team2} : ${row.score.team1}` },
            { title: "K/D/A", render: (_, row) => `${row.self.kills}/${row.self.deaths}/${row.self.assists}` },
            { title: "Rating", render: (_, row) => typeof row.self.rating2 === "number" ? row.self.rating2.toFixed(2) : "-" },
            { title: "操作", render: (_, row) => <Button onClick={() => void openMatchDetail(row.matchId)}>详情</Button> },
          ]}
        />
        {matchHistory && matchHistoryAccount && matchHistory.total > matchHistory.pageSize ? (
          <Pagination
            current={matchHistory.page}
            pageSize={matchHistory.pageSize}
            total={matchHistory.total}
            showLessItems
            showSizeChanger={false}
            disabled={matchHistoryLoading}
            onChange={(page) => void openMatchHistory(matchHistoryAccount, page)}
          />
        ) : null}
      </Modal>
      <Modal
        title={matchDetail ? `${matchDetail.account.username} · ${matchDetail.result.mapName}` : "战绩详情"}
        open={matchDetail !== null || matchDetailLoading}
        footer={null}
        width={1000}
        onCancel={closeMatchDetail}
      >
        {matchDetail ? (
          <div className="manager-match-detail-teams">
            {matchDetailTeamSections.map((section) => (
              <section className="manager-match-detail-team" key={section.team}>
                <header className="manager-match-detail-team-header">
                  <strong className="manager-match-detail-team-name">{section.name}</strong>
                  {section.firstHalfScore !== undefined || section.secondHalfScore !== undefined ? (
                    <div className="manager-match-detail-halves">
                      <span>上半场 <strong>{section.firstHalfScore ?? "-"}</strong></span>
                      <span>下半场 <strong>{section.secondHalfScore ?? "-"}</strong></span>
                    </div>
                  ) : null}
                  <strong
                    className={
                      section.team === matchDetail.result.winner
                        ? "manager-match-detail-score manager-match-detail-score--winner"
                        : "manager-match-detail-score manager-match-detail-score--loser"
                    }
                  >
                    {section.score}
                  </strong>
                </header>
                <Table
                  rowKey={(row) => row.steam64 || `${row.team}-${row.name}`}
                  dataSource={section.players}
                  pagination={false}
                  size="small"
                  columns={[
                    { title: "选手", dataIndex: "name" },
                    { title: "击杀", dataIndex: "kills" },
                    { title: "死亡", dataIndex: "deaths" },
                    { title: "助攻", dataIndex: "assists" },
                    { title: "伤害", dataIndex: "damage" },
                    { title: "爆头", dataIndex: "headshots" },
                    {
                      title: "Rating",
                      dataIndex: "rating2",
                      render: (value?: number) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "-",
                    },
                  ]}
                />
              </section>
            ))}
          </div>
        ) : null}
      </Modal>
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
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, message: "请输入用户名" },
              { pattern: USERNAME_PATTERN, message: "用户名只能包含大小写字母和数字" },
            ]}
          >
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
          <Form.Item name="steam64" label="Steam64"><Input /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}
