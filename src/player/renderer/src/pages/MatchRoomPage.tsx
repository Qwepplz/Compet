import { Button } from "antd";
import { useEffect, useState } from "react";
import type { AccountView } from "../../../../manager/shared/types.js";
import type { PlayerLiveMatchStateDto, PlayerMatchParticipantDto, PlayerMatchTeamDto } from "../../../shared/types.js";
import { SteamAvatar } from "../components/SteamAvatar.js";
import { formatMapName } from "../mapDisplay.js";
import { participantDisplayName } from "../playerDisplay.js";

interface MatchRoomPageProps {
  account: AccountView | null;
  room: PlayerLiveMatchStateDto | null;
  onAcceptReady?: () => Promise<void>;
  onDeclineReady?: () => Promise<void>;
  onApplyVeto?: (roomId: string, action: "ban" | "pick", map: string) => Promise<void>;
  onCopyText?: (text: string) => Promise<void>;
}

function formatCountdown(deadlineAt: string | undefined, nowMs: number, maxSeconds?: number): string {
  if (!deadlineAt) return "--:--";
  const deadlineMs = new Date(deadlineAt).getTime();
  if (!Number.isFinite(deadlineMs)) return "--:--";
  const remainingMs = deadlineMs - nowMs;
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const displayedSeconds = Math.min(maxSeconds ?? remainingSeconds, remainingSeconds);
  const minutes = Math.floor(displayedSeconds / 60).toString().padStart(2, "0");
  const seconds = (displayedSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
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
  if (participant.kind === "human") return "Player";
  return participant.botCategory === "pro" ? "Pro-Bot" : "BOT";
}

function mapThumbClass(map: string): string {
  return `faceit-map-thumb faceit-map-thumb--${map.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
}

function vetoPrompt(
  currentActor: NonNullable<PlayerLiveMatchStateDto["veto"]>["current"] | undefined,
  canApplyCurrentVeto: boolean,
  isOwnTeamVeto: boolean,
): string {
  if (!currentActor) return "等待操作";
  if (!isOwnTeamVeto) return currentActor.action === "pick" ? "你的对手正在选择地图" : "你的对手正在禁用地图";
  if (canApplyCurrentVeto) return currentActor.action === "pick" ? "轮到您选择地图" : "轮到您封禁地图";
  return currentActor.action === "pick" ? "正在等待队长选择地图" : "正在等待队长封禁地图";
}

function renderTeam(team: PlayerMatchTeamDto | null | undefined, side: "left" | "right", accountId: string | undefined) {
  if (!team) return null;

  return (
    <section className={`faceit-team-column faceit-team-column--${side}`}>
      <div className="faceit-team-title">
        <span>Players</span>
        <strong>{team.name}</strong>
      </div>
      <div className="faceit-player-list">
        {team.participants.map((participant) => {
          const isSelf = Boolean(accountId && participant.accountId === accountId);
          return (
            <div className={`faceit-player-card${isSelf ? " faceit-player-card--self" : ""}`} key={participant.id}>
              <SteamAvatar className="faceit-player-avatar" avatarUrl={participant.steamAvatarUrl} label={participantName(participant)} />
              <div className="faceit-player-main">
                <div className="faceit-player-name-line">
                  <strong>{participantName(participant)}</strong>
                  {participant.isCaptain ? (
                    <span className="faceit-captain-badge" aria-label="队长" title="队长">C</span>
                  ) : null}
                </div>
                <span>{participantMeta(participant)}</span>
              </div>
            </div>
          );
        })}
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
  const finalMap = room?.veto?.finalMap;
  const selectedMap = finalMap ?? connect?.map;
  const currentActor = room?.veto?.current;
  const accountTeamId = account?.id && room?.teamA?.participants.some((participant) => participant.accountId === account.id)
    ? "teamA"
    : account?.id && room?.teamB?.participants.some((participant) => participant.accountId === account.id)
      ? "teamB"
      : undefined;
  const isOwnTeamVeto = Boolean(accountTeamId && currentActor?.actorTeamId === accountTeamId);
  const canApplyCurrentVeto = Boolean(
    account?.id && currentActor?.actorType === "human" && currentActor.actorAccountId === account.id,
  );
  const currentMap = selectedMap ?? room?.veto?.availableMaps[0] ?? "de_mirage";
  const roomPhase = phaseLabel(room?.phase);
  const readyCountdownStarted = room?.phase === "ready" && Boolean(room.readyDeadlineAt);
  const participantNames = new Map(
    [...(room?.teamA?.participants ?? []), ...(room?.teamB?.participants ?? [])]
      .flatMap((participant) => (participant.accountId ? [[participant.accountId, participantName(participant)] as const] : [])),
  );
  const actorLabel = currentActor
    ? currentActor.actorAccountId
      ? participantNames.get(currentActor.actorAccountId) ?? currentActor.actorName
      : currentActor.actorName
    : undefined;
  const teamNameById = new Map([
    ["teamA", room?.teamA?.name ?? "Team A"],
    ["teamB", room?.teamB?.name ?? "Team B"],
  ] as const);
  const actorTeamName = currentActor ? teamNameById.get(currentActor.actorTeamId) : undefined;
  const currentVetoPrompt = vetoPrompt(currentActor, canApplyCurrentVeto, isOwnTeamVeto);

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
          <strong>{room?.teamA?.name ?? "Team A"}</strong>
          <span>{room?.teamA?.participants.length ?? 0} 名玩家</span>
        </div>
        <div className="faceit-match-status">
          <strong>5v5 · BO1</strong>
          <span>{roomPhase}</span>
          <small>{formatMapName(currentMap)}</small>
        </div>
        <div className="faceit-team-summary faceit-team-summary--right">
          <strong>{room?.teamB?.name ?? "Team B"}</strong>
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
          {renderTeam(room.teamA, "left", account?.id)}

          <main className="faceit-center-panel">
            <div className="faceit-progress-line" />

            {selectedMap ? (
              <section className="faceit-final-map-preview" aria-label="最终地图">
                <span>最终地图</span>
                <strong>{formatMapName(selectedMap)}</strong>
                <span className={`faceit-final-map-thumb ${mapThumbClass(selectedMap)}`} aria-hidden="true" />
              </section>
            ) : null}

            {room.phase === "ready" ? (
              <section className="faceit-connect-panel">
                <span>{readyCountdownStarted ? "准备倒计时" : "等待所有玩家进入房间"}</span>
                <strong className="faceit-countdown">{readyCountdownStarted ? formatCountdown(room.readyDeadlineAt, nowMs) : "--:--"}</strong>
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
                    <Button aria-label="准备" type="primary" onClick={() => void onAcceptReady?.()} disabled={!onAcceptReady || !readyCountdownStarted}>
                      准备
                    </Button>
                    <Button aria-label="拒绝本场" onClick={() => void onDeclineReady?.()} disabled={!onDeclineReady || !readyCountdownStarted}>
                      拒绝本场
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}

            {room.phase === "map_banpick" ? (
              <section className="faceit-connect-panel faceit-veto-panel">
                <div className="faceit-veto-status">
                  <strong>{currentVetoPrompt}</strong>
                  <span>{formatCountdown(currentActor?.deadlineAt, nowMs, 30)}</span>
                  <small>{actorLabel ? `队长：${actorLabel}${actorTeamName ? ` · ${actorTeamName}` : ""}` : "等待操作"}</small>
                </div>
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
                        <span className="faceit-map-card-layout">
                          <span className={mapThumbClass(map)} aria-hidden="true" />
                          <span className="faceit-map-card-main">
                            <strong>{mapName}</strong>
                          </span>
                          <span className="faceit-map-card-action">{cardActionLabel}</span>
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {room.phase === "match_room" || room.phase === "server_prepare" ? (
              <section className="faceit-connect-panel">
                <span>{room.phase === "server_prepare" ? "Server" : "Match"}</span>
                <strong>{room.phase === "server_prepare" ? "服务器准备中" : "最终分队"}</strong>
                <small>等待 get5 比赛配置加载完成。</small>
              </section>
            ) : null}

            {room.phase === "connect" || room.phase === "live" ? (
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

            {room.phase === "completed" || room.phase === "failed" ? (
              <section className="faceit-connect-panel">
                <span>{room.phase === "completed" ? "Match Completed" : "Match Failed"}</span>
                <strong>{room.phase === "completed" ? "比赛已结束" : "比赛已关闭"}</strong>
                <small>本场已结束，进服指令已失效。</small>
              </section>
            ) : null}
          </main>

          {renderTeam(room.teamB, "right", account?.id)}
        </div>
      )}
    </div>
  );
}
