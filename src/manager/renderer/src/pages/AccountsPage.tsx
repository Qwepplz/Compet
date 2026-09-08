import { Button, Form, Input, Modal, Pagination, Space, Switch, Table, message } from "antd";
import type { TableProps } from "antd";
import { useEffect, useRef, useState } from "react";
import { USERNAME_PATTERN } from "../../../../accounts/accountTypes.js";
import type { AccountMatchDetail, AccountMatchHistory, AccountView, CreateAccountInput, UpdateAccountInput } from "../../../shared/types.js";
import { accountApi, isManagerAuthRequired } from "../api/managerApi.js";
import { displayError } from "../../../../language/displayError.js";
import { useLanguage } from "../../../../language/react.js";
import type { TranslationKey, Translator } from "../../../../language/types.js";

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

function showAccountError(error: unknown, t: Translator, fallback: TranslationKey): void {
  if (isManagerAuthRequired()) return;
  message.error(displayError(error, t, fallback));
}

interface AccountStatusLabels {
  unavailable: string;
  inGameOnline: string;
  inGameOffline: string;
  online: string;
  offline: string;
}

export function AccountStatus({
  online,
  inGame,
  labels,
}: Pick<AccountView, "online" | "inGame"> & { labels: AccountStatusLabels }) {
  if (typeof online !== "boolean" || typeof inGame !== "boolean") {
    return <span title={labels.unavailable} aria-label={labels.unavailable}>—</span>;
  }

  const color = inGame
    ? (online ? "#fa8c16" : "#ff4d4f")
    : (online ? "#52c41a" : "#8c8c8c");
  const label = inGame
    ? (online ? labels.inGameOnline : labels.inGameOffline)
    : (online ? labels.online : labels.offline);

  return (
    <span
      role="img"
      aria-label={label}
      style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", backgroundColor: color }}
    />
  );
}

export function withoutAccountPresence(account: AccountView): AccountView {
  const nextAccount = { ...account };
  delete nextAccount.online;
  delete nextAccount.inGame;
  return nextAccount;
}

export function AccountsPage() {
  const { language, formatDateTime, t } = useLanguage();
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
  const mountedRef = useRef(false);
  const accountRequestIdRef = useRef(0);
  const accountRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [form] = Form.useForm<AccountFormValues>();

  function clearAccountRefreshTimer() {
    if (accountRefreshTimerRef.current === null) return;
    clearTimeout(accountRefreshTimerRef.current);
    accountRefreshTimerRef.current = null;
  }

  async function refresh(background = false) {
    const requestId = ++accountRequestIdRef.current;
    clearAccountRefreshTimer();
    if (!mountedRef.current) return;
    const current = () => mountedRef.current && requestId === accountRequestIdRef.current;
    if (!background) setLoading(true);
    try {
      const nextAccounts = await accountApi.list();
      if (current()) setAccounts(nextAccounts);
    } catch (error) {
      if (current()) {
        setAccounts((currentAccounts) => currentAccounts.map(withoutAccountPresence));
        if (!background) showAccountError(error, t, "errors.accountLoadFailed");
      }
    } finally {
      if (!current()) return;
      if (!background) setLoading(false);
      if (!isManagerAuthRequired()) {
        accountRefreshTimerRef.current = setTimeout(() => {
          void refresh(true);
        }, 3_000);
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      accountRequestIdRef.current += 1;
      clearAccountRefreshTimer();
    };
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
    { title: t("manager.accounts.username"), dataIndex: "username" },
    { title: "Steam64", dataIndex: "steam64", render: (value?: string) => value || "-" },
    {
      title: t("manager.accounts.status"),
      width: 72,
      align: "center",
      render: (_: unknown, row: AccountView) => (
        <AccountStatus
          online={row.online}
          inGame={row.inGame}
          labels={{
            unavailable: t("manager.accounts.unavailable"),
            inGameOnline: t("manager.accounts.status.inGameOnline"),
            inGameOffline: t("manager.accounts.status.inGameOffline"),
            online: t("manager.accounts.status.online"),
            offline: t("manager.accounts.status.offline"),
          }}
        />
      ),
    },
    {
      title: t("manager.accounts.enabled"),
      dataIndex: "enabled",
      render: (value: boolean, row: AccountView) => {
        const updating = updatingIds.has(row.id);
        return (
          <Switch checked={value} loading={updating} disabled={updating} onChange={(enabled) => void toggleEnabled(row, enabled)} />
        );
      },
    },
    {
      title: t("manager.accounts.devMode"),
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
      title: t("manager.accounts.actions"),
      render: (_: unknown, row: AccountView) => {
        const resetting = resettingIds.has(row.id);
        const deleting = deletingIds.has(row.id);
        return (
          <Space>
            {row.role === "player" ? <Button onClick={() => void openMatchHistory(row, 1)}>{t("manager.accounts.history")}</Button> : null}
            {row.role === "player" ? <Button onClick={() => edit(row)}>{t("manager.accounts.edit")}</Button> : null}
            <Button loading={resetting} disabled={resetting} onClick={() => reset(row)}>{t("manager.accounts.resetPassword")}</Button>
            <Button danger loading={deleting} disabled={deleting || row.role === "admin"} onClick={() => remove(row)}>{t("manager.accounts.delete")}</Button>
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
      showAccountError(error, t, "errors.accountHistoryLoadFailed");
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
        showAccountError(error, t, "errors.accountResultLoadFailed");
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
      showAccountError(error, t, "errors.accountUpdateFailed");
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
      showAccountError(error, t, "errors.accountUpdateFailed");
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
      Modal.info({ title: t("manager.accounts.temporaryPassword"), content: password });
    } catch (error) {
      showAccountError(error, t, "errors.accountResetFailed");
    } finally {
      endResetting(row.id);
    }
  }

  function remove(row: AccountView) {
    Modal.confirm({
      title: t("manager.accounts.deleteTitle"),
      content: t("manager.accounts.deleteConfirm", { username: row.username }),
      okText: t("common.actions.delete"),
      okButtonProps: { danger: true },
      cancelText: t("common.actions.cancel"),
      onOk: async () => {
        if (!beginDeleting(row.id)) return;
        try {
          await accountApi.delete(row.id);
          message.success(t("manager.accounts.deleted"));
          await refresh();
        } catch (error) {
      showAccountError(error, t, "errors.accountDeleteFailed");
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
      showAccountError(error, t, "errors.accountUpdateFailed");
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
        <h1 className="page-title">{t("manager.navigation.accounts")}</h1>
        <Button type="primary" onClick={create}>{t("manager.accounts.create")}</Button>
      </div>
      <Table rowKey="id" columns={columns} dataSource={accounts} loading={loading} pagination={false} />
      <Modal
        title={matchHistoryAccount ? t("manager.accounts.historyTitle", { username: matchHistoryAccount.username }) : t("manager.accounts.history")}
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
          locale={{ emptyText: t("manager.accounts.historyEmpty") }}
          columns={[
            { title: t("common.labels.date"), dataIndex: "completedAt", render: (value: string) => formatDateTime(value) },
            { title: t("common.labels.map"), dataIndex: "mapName" },
            { title: t("common.labels.result"), render: (_, row) => row.selfWon ? t("manager.accounts.win") : t("manager.accounts.loss") },
            { title: t("common.labels.score"), render: (_, row) => row.selfTeam === "teamA" ? `${row.score.team1} : ${row.score.team2}` : `${row.score.team2} : ${row.score.team1}` },
            { title: t("common.labels.kda"), render: (_, row) => `${row.self.kills}/${row.self.deaths}/${row.self.assists}` },
            { title: t("common.labels.rating"), render: (_, row) => typeof row.self.rating2 === "number" ? row.self.rating2.toFixed(2) : "-" },
            { title: t("common.labels.operations"), render: (_, row) => <Button onClick={() => void openMatchDetail(row.matchId)}>{t("manager.accounts.detail")}</Button> },
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
        title={matchDetail ? `${matchDetail.account.username} · ${matchDetail.result.mapName}` : t("manager.accounts.resultDetailsTitle")}
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
                      <span>{t("common.labels.firstHalf")} <strong>{section.firstHalfScore ?? "-"}</strong></span>
                      <span>{t("common.labels.secondHalf")} <strong>{section.secondHalfScore ?? "-"}</strong></span>
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
                    { title: t("common.labels.player"), dataIndex: "name" },
                    { title: t("common.labels.kills"), dataIndex: "kills" },
                    { title: t("common.labels.deaths"), dataIndex: "deaths" },
                    { title: t("common.labels.assists"), dataIndex: "assists" },
                    { title: t("common.labels.damage"), dataIndex: "damage" },
                    { title: t("common.labels.headshots"), dataIndex: "headshots" },
                    {
                      title: t("common.labels.rating"),
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
        title={t("manager.accounts.editTitle")}
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
            label={t("manager.accounts.selectUsername")}
            rules={[
              { required: true, message: t("common.labels.username") },
              { pattern: USERNAME_PATTERN, message: t("manager.accounts.usernameRule") },
            ]}
          >
            <Input disabled={isEditing} />
          </Form.Item>
          {!isEditing && (
            <Form.Item
              name="password"
              label={t("manager.accounts.initialPassword")}
              rules={[
                { required: true, message: t("manager.accounts.initialPassword") },
                { min: 8, message: t("manager.accounts.passwordRule") },
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
