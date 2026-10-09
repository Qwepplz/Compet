import { Alert, Button, Card, Input, Space, Table, Typography, message } from "antd";
import type { TableProps } from "antd";
import { useEffect, useRef, useState } from "react";
import type { PlayerMarkView } from "../../../shared/types.js";
import { isManagerAuthRequired, playerMarkApi } from "../api/managerApi.js";
import { displayError } from "../../../../language/displayError.js";
import { useLanguage } from "../../../../language/react.js";

export function PlayerMarksPage({ serviceRunning }: { serviceRunning: boolean }) {
  const { formatDateTime, t } = useLanguage();
  const [players, setPlayers] = useState<PlayerMarkView[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
  const updatingIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(false);
  const runningRef = useRef(serviceRunning);
  const requestRef = useRef(0);
  const lifecycleRef = useRef(0);
  const refreshAfterUpdatesRef = useRef(false);
  runningRef.current = serviceRunning;

  async function refresh() {
    if (!mountedRef.current || !runningRef.current) return;
    if (updatingIdsRef.current.size > 0) {
      refreshAfterUpdatesRef.current = true;
      return;
    }
    refreshAfterUpdatesRef.current = false;
    const request = ++requestRef.current;
    const current = () => mountedRef.current && runningRef.current && request === requestRef.current;
    setLoading(true);
    try {
      const next = await playerMarkApi.list();
      if (current()) {
        setPlayers(next);
        setLoadError(null);
      }
    } catch (error) {
      if (current() && !isManagerAuthRequired()) {
        const text = displayError(error, t, "errors.accountLoadFailed");
        setLoadError(text);
        message.error(text);
      }
    } finally {
      if (current()) setLoading(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    lifecycleRef.current += 1;
    if (serviceRunning) void refresh();
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      requestRef.current += 1;
    };
  }, [serviceRunning]);

  async function update(row: PlayerMarkView) {
    const id = row.accountId;
    if (!mountedRef.current || !runningRef.current || updatingIdsRef.current.has(id)) return;
    updatingIdsRef.current.add(id);
    requestRef.current += 1;
    setLoading(false);
    setUpdatingIds(new Set(updatingIdsRef.current));
    const lifecycle = lifecycleRef.current;
    const current = () => mountedRef.current && runningRef.current && lifecycle === lifecycleRef.current;
    try {
      const authority = await playerMarkApi.update(id, !row.marked);
      if (current()) {
        setPlayers(previous => previous.map(player => player.accountId === id ? authority : player));
        refreshAfterUpdatesRef.current = true;
      }
    } catch (error) {
      if (current() && !isManagerAuthRequired()) message.error(displayError(error, t, "errors.accountUpdateFailed"));
    } finally {
      updatingIdsRef.current.delete(id);
      if (mountedRef.current) {
        setUpdatingIds(new Set(updatingIdsRef.current));
        if (runningRef.current && updatingIdsRef.current.size === 0 && refreshAfterUpdatesRef.current) {
          await refresh();
        }
      }
    }
  }

  const query = search.trim().toLowerCase();
  const filtered = players.filter(player => [player.username, player.displayName, player.steam64]
    .some(value => value.toLowerCase().includes(query)));
  const columns: TableProps<PlayerMarkView>["columns"] = [
    { title: t("manager.accounts.username"), dataIndex: "username" },
    { title: "Steam64", dataIndex: "steam64", render: (value: string) => value || "—" },
    { title: t("manager.playerMarks.abnormalStreak"), dataIndex: "abnormalStreak" },
    { title: t("manager.playerMarks.status"), dataIndex: "marked", render: (marked: boolean) => t(marked ? "manager.playerMarks.marked" : "manager.playerMarks.unmarked") },
    { title: t("manager.playerMarks.markedAt"), dataIndex: "markedAt", render: (value: string | null) => value ? formatDateTime(value) : "—" },
    {
      title: t("manager.accounts.actions"),
      render: (_: unknown, row: PlayerMarkView) => (
        <Button disabled={!serviceRunning || updatingIds.has(row.accountId)} loading={updatingIds.has(row.accountId)} onClick={() => update(row)}>
          {t(row.marked ? "manager.playerMarks.unmark" : "manager.playerMarks.mark")}
        </Button>
      ),
    },
  ];

  return (
    <Card title={t("manager.navigation.playerMarks")}>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Paragraph type="secondary">{t("manager.playerMarks.description")}</Typography.Paragraph>
        <Space>
          <Input.Search value={search} onChange={event => setSearch(event.target.value)} placeholder={t("manager.playerMarks.search")} allowClear />
          <Button onClick={refresh} loading={loading} disabled={!serviceRunning || updatingIds.size > 0}>{t("common.actions.reload")}</Button>
        </Space>
        {!serviceRunning && <Alert type="warning" message={t("manager.playerMarks.unavailable")} />}
        {serviceRunning && loadError && <Alert type="error" message={loadError} />}
        <Table<PlayerMarkView> rowKey="accountId" columns={columns} dataSource={serviceRunning ? filtered : []} loading={serviceRunning && loading} pagination={{ pageSize: 20 }} scroll={{ x: 800 }} />
      </Space>
    </Card>
  );
}
