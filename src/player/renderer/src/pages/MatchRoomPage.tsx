import { Button } from "antd";
import { useEffect, useState } from "react";
import type { AccountView } from "../../../../manager/shared/types.js";
import type { PlayerLiveMatchStateDto, PlayerMatchParticipantDto, PlayerMatchTeamDto } from "../../../shared/types.js";
import { SteamAvatar } from "../components/SteamAvatar.js";
import { participantDisplayName } from "../playerDisplay.js";

interface MatchRoomPageProps {
  account: AccountView | null;
  room: PlayerLiveMatchStateDto | null;
  onAcceptReady?: () => Promise<void>;
  onDeclineReady?: () => Promise<void>;
  onApplyVeto?: (roomId: string, action: "ban" | "pick", map: string) => Promise<void>;
  onCopyText?: (text: string) => Promise<void>;
}

function formatCountdown(deadlineAt: string | undefined, nowMs: number): string {
  if (!deadlineAt) return "--:--";
  const deadlineMs = new Date(deadlineAt).getTime();
  if (!Number.isFinite(deadlineMs)) return "--:--";
  const remainingMs = deadlineMs - nowMs;
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(remainingSeconds / 60).toString().padStart(2, "0");
  const seconds = (remainingSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatMapName(map: string): string {
  return map.replace(/^de_/, "").replace(/_/g, " ").toUpperCase();
}

function phaseLabel(phase?: PlayerLiveMatchStateDto["phase"]): string {
  switch (phase) {
    case "ready":
      return "准备确认";
    case "match_room":
      return "比赛房间";
    case "map_banpick":
      return "地图禁选";
    case "server_prepare":
      return "服务器准备中";
    case "connect":
      return "可以进服";
    case "live":
      return "比赛进行中";
    case "completed":
      return "已结束";
    case "failed":
      return "失败";
    case "queue":
    default:
      return "等待中";
  }
}

function participantName(participant: PlayerMatchParticipantDto): string {
  return participantDisplayName(participant);
}

function participantMeta(participant: PlayerMatchParticipantDto): string {
  return participant.kind === "human" ? "STEAM 玩家" : "BOT";
}

function mapThumbClass(map: string): string {
  return `faceit-map-thumb faceit-map-thumb--${map.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
}

function renderTeam(team: PlayerMatchTeamDto | null | undefined, side: "left" | "right") {
  if (!team) return null;

  return (
    <section className={`faceit-team-column faceit-team-column--${side}`}>
      <div className="faceit-team-title">
        <span>Players</span>
        <strong>{team.name}</strong>
      </div>
      <div className="faceit-player-list">
        {team.participants.map((participant) => (
          <div className="faceit-player-card" key={participant.id}>
            <SteamAvatar className="faceit-player-avatar" avatarUrl={participant.steamAvatarUrl} label={participantName(participant)} />
            <div className="faceit-player-main">
              <strong>{participantName(participant)}</strong>
              <span>{participantMeta(participant)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function MatchRoomPage({
  account,
  room,
  onAcceptReady,
  onDeclineReady,
  onApplyVeto,
  onCopyText,
}: MatchRoomPageProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const connect = room?.connect;
  const currentActor = room?.veto?.current;
  const canApplyCurrentVeto = Boolean(
    account?.id && currentActor?.actorType === "human" && currentActor.actorAccountId === account.id,
  );
  const currentMap = room?.connect?.map ?? room?.veto?.finalMap ?? room?.veto?.availableMaps[0] ?? "de_mirage";
  const roomPhase = phaseLabel(room?.phase);
  const participantNames = new Map(
    [...(room?.teamA?.participants ?? []), ...(room?.teamB?.participants ?? [])]
      .flatMap((participant) => (participant.accountId ? [[participant.accountId, participantName(participant)] as const] : [])),
  );
  const actorLabel = currentActor
    ? currentActor.actorAccountId
      ? participantNames.get(currentActor.actorAccountId) ?? currentActor.actorName
      : "系统选择"
    : undefined;

  return (
    <div className="faceit-matchroom">
      <header className="faceit-matchroom-top">
        <h2>比赛房间</h2>
        <nav>
          <span className="faceit-nav-active">MATCH</span>
        </nav>
      </header>

      <section className="faceit-match-header">
        <div className="faceit-team-summary">
          <strong>Team {room?.teamA?.name ?? "alpha"}</strong>
          <span>{room?.teamA?.participants.length ?? 0} 名玩家</span>
        </div>
        <div className="faceit-match-status">
          <strong>5v5 · BO1</strong>
          <span>{roomPhase}</span>
          <small>{formatMapName(currentMap)}</small>
        </div>
        <div className="faceit-team-summary faceit-team-summary--right">
          <strong>Team {room?.teamB?.name ?? "beta"}</strong>
          <span>{room?.teamB?.participants.length ?? 0} 名玩家</span>
        </div>
      </section>

      {!room ? (
        <section className="faceit-empty-room">
          <strong>暂无比赛房间</strong>
          <span>等待匹配成功后进入 Matchroom。</span>
        </section>
      ) : (
        <div className="faceit-match-grid">
          {renderTeam(room.teamA, "left")}

          <main className="faceit-center-panel">
            <div className="faceit-progress-line" />

            {room.phase === "ready" ? (
              <section className="faceit-connect-panel">
                <span>准备倒计时</span>
                <strong className="faceit-countdown">{formatCountdown(room.readyDeadlineAt, nowMs)}</strong>
                <div className="faceit-ready-list">
                  {(room.ready ?? []).map((entry) => (
                    <div className="faceit-ready-row" key={entry.accountId}>
                      <span>{participantNames.get(entry.accountId) ?? entry.accountId}</span>
                      <strong>{entry.ready ? "已准备" : "等待中"}</strong>
                    </div>
                  ))}
                </div>
                {account?.id && room.humanAccountIds?.includes(account.id) ? (
                  <div className="faceit-action-row">
                    <Button aria-label="准备" type="primary" onClick={() => void onAcceptReady?.()} disabled={!onAcceptReady}>
                      准备
                    </Button>
                    <Button aria-label="拒绝本场" onClick={() => void onDeclineReady?.()} disabled={!onDeclineReady}>
                      拒绝本场
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}

            {room.phase === "map_banpick" ? (
              <section className="faceit-connect-panel">
                <span>Map Veto</span>
                <strong>{actorLabel ? `Actor: ${actorLabel}` : "Waiting"}</strong>
                <small>{currentActor ? `${currentActor.actorTeamId} · ${currentActor.action}` : "等待操作"}</small>
                <strong className="faceit-countdown">{formatCountdown(currentActor?.deadlineAt, nowMs)}</strong>
                <small>剩余 {formatCountdown(currentActor?.deadlineAt, nowMs)}</small>
                <div className="faceit-map-pool">
                  {room.veto?.mapPool.map((map) => {
                    const actionLabel = currentActor?.action === "pick" ? "PICK" : "BAN";
                    const isAvailable = room.veto?.availableMaps.includes(map) ?? false;
                    const historyEntry = room.veto?.history.find((entry) => entry.map === map);
                    const cardActionLabel = isAvailable ? actionLabel : historyEntry?.action === "pick" ? "PICKED" : "BANNED";
                    const mapName = formatMapName(map);
                    return (
                      <Button
                        className={`faceit-map-card${isAvailable ? "" : " faceit-map-card--removed"}`}
                        aria-label={`${cardActionLabel} ${mapName}`}
                        key={map}
                        disabled={!onApplyVeto || !canApplyCurrentVeto || !isAvailable}
                        onClick={() => void onApplyVeto?.(room.id, currentActor?.action ?? "ban", map)}
                      >
                        <span className={mapThumbClass(map)} aria-hidden="true" />
                        <span className="faceit-map-card-main">
                          <span>{cardActionLabel}</span>
                          <strong>{mapName}</strong>
                        </span>
                      </Button>
                    );
                  })}
                </div>
                {room.veto?.finalMap ? (
                  <div className="faceit-server-box">
                    <span>Final Map</span>
                    <strong>{formatMapName(room.veto.finalMap)}</strong>
                  </div>
                ) : null}
              </section>
            ) : null}

            {room.phase === "match_room" || room.phase === "server_prepare" ? (
              <section className="faceit-connect-panel">
                <span>{room.phase === "server_prepare" ? "Server" : "Match"}</span>
                <strong>{room.phase === "server_prepare" ? "服务器准备中" : "最终分队"}</strong>
                <small>等待 get5 比赛配置加载完成。</small>
              </section>
            ) : null}

            {room.phase === "connect" || room.phase === "live" || room.phase === "completed" || room.phase === "failed" ? (
              <section className="faceit-connect-panel">
                <span>Time To Connect</span>
                <strong className="faceit-countdown faceit-countdown--ready">{connect ? "READY" : "--:--"}</strong>
                {connect ? (
                  <>
                    <Button
                      aria-label="复制进服指令"
                      type="primary"
                      className="faceit-connect-button"
                      onClick={() => void onCopyText?.(connect.connectCommand)}
                      disabled={!onCopyText}
                    >
                      复制进服指令
                    </Button>
                  </>
                ) : (
                  <small>连接信息尚未下发。</small>
                )}
              </section>
            ) : null}
          </main>

          {renderTeam(room.teamB, "right")}
        </div>
      )}
    </div>
  );
}
