import { Button, Spin } from "antd";
import { useState } from "react";
import type { AccountView } from "../../../../manager/shared/types.js";
import type { PlayerLiveMatchStateDto, PlayerMatchParticipantDto, PlayerMatchTeamDto } from "../../../shared/types.js";
import { SteamAvatar } from "../components/SteamAvatar.js";
import { VerificationBadge } from "../components/VerificationBadge.js";
import { formatMapName, mapImageUrl } from "../mapAssets.js";
import { formatReadyCountdown } from "../matchTimers.js";
import { getSelectedMap, isAccountInReadyRoom } from "../matchRoomState.js";
import { RandomMapReel } from "../components/RandomMapReel.js";
import { participantDisplayName } from "../playerDisplay.js";

interface MatchRoomPageProps {
  account: AccountView | null;
  room: PlayerLiveMatchStateDto | null;
  nowMs: number;
  onAcceptReady?: () => Promise<void>;
  onDeclineReady?: () => Promise<void>;
  onMapRevealComplete?: () => void;
  onCopyText?: (text: string) => Promise<void>;
}

function phaseLabel(phase?: PlayerLiveMatchStateDto["phase"]): string | null {
  switch (phase) {
    case "ready":
      return "准备确认";
    case "match_room":
      return "比赛房间";
    case "map_randomizing":
      return "随机地图";
    case "server_prepare":
      return "服务器准备中";
    case "connect":
      return null;
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

function participantBadge(participant: PlayerMatchParticipantDto): { variant: "gold" | "white"; title: string } | null {
  if (participant.kind === "human") return { variant: "gold", title: "Player" };
  if (participant.botCategory === "pro") return { variant: "white", title: "Pro-Bot" };
  return null;
}


function isReadyAnonymous(phase: string | undefined, participant: PlayerMatchParticipantDto, accountId: string | undefined): boolean {
  if (phase !== "ready") return false;
  if (accountId && participant.accountId === accountId) return false;
  return true;
}

function renderTeam(team: PlayerMatchTeamDto | null | undefined, side: "left" | "right", accountId: string | undefined, phase?: string) {
  if (!team) return null;

  return (
    <section className={`faceit-team-column faceit-team-column--${side}`}>
      <div className="faceit-team-title">
        <span>Players</span>
        <div className="faceit-team-identity">
          {team.logoImage ? <img className="faceit-team-logo" src={team.logoImage} alt="" /> : null}
          <strong>{team.name}</strong>
        </div>
      </div>
      <div className="faceit-player-list">
        {team.participants.map((participant) => {
          const isSelf = Boolean(accountId && participant.accountId === accountId);
          const anonymous = isReadyAnonymous(phase, participant, accountId);
          const displayName = anonymous ? "已匹配玩家" : participantName(participant);
          const avatarLabel = anonymous ? undefined : participantName(participant);
          const avatarUrl = anonymous ? undefined : participant.steamAvatarUrl;
          const badge = anonymous ? null : participantBadge(participant);
          return (
            <div className={`faceit-player-card${isSelf ? " faceit-player-card--self" : ""}`} key={participant.id}>
              <SteamAvatar className="faceit-player-avatar" avatarUrl={avatarUrl} label={avatarLabel} />
              <div className="faceit-player-main">
                <div className="faceit-player-name-line">
                  <strong>{displayName}</strong>
                  {badge ? <VerificationBadge variant={badge.variant} title={badge.title} /> : null}
                  {!anonymous && participant.isCaptain ? (
                    <span className="faceit-captain-badge" aria-label="队长" title="队长">
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path
                          fillRule="evenodd"
                          clipRule="evenodd"
                          d="M7.5 9.333L3 4v10.667h18V4l-4.5 5.333L12 4 7.5 9.333zM21 20v-2.667H3V20h18z"
                          fill="currentColor"
                        />
                      </svg>
                    </span>
                  ) : null}
                </div>
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
  nowMs,
  onAcceptReady,
  onDeclineReady,
  onMapRevealComplete,
  onCopyText,
}: MatchRoomPageProps) {
  const connect = room?.connect;
  const selectedMap = getSelectedMap(room, nowMs);
  const roomPhase = phaseLabel(room?.phase);
  const readyCountdownStarted = room?.phase === "ready" && Boolean(room.readyDeadlineAt);
  const canUseReadyActions = isAccountInReadyRoom(room, account?.id);
  const selfReady = room?.ready?.find((entry) => entry.accountId === account?.id)?.ready === true;
  const [readyActionPending, setReadyActionPending] = useState<"accept" | "decline" | null>(null);
  const participantNames = new Map(
    [...(room?.teamA?.participants ?? []), ...(room?.teamB?.participants ?? [])]
      .flatMap((participant) => (participant.accountId ? [[participant.accountId, participantName(participant)] as const] : [])),
  );

  async function handleAcceptReady() {
    if (!onAcceptReady || !readyCountdownStarted || selfReady || readyActionPending) return;
    setReadyActionPending("accept");
    try {
      await onAcceptReady();
    } finally {
      setReadyActionPending(null);
    }
  }

  async function handleDeclineReady() {
    if (!onDeclineReady || !readyCountdownStarted || selfReady || readyActionPending) return;
    setReadyActionPending("decline");
    try {
      await onDeclineReady();
    } finally {
      setReadyActionPending(null);
    }
  }

  return (
    <div className="faceit-matchroom">
      <section className="faceit-match-header">
        <div className="faceit-match-status">
          <strong>5v5 · BO1</strong>
          {roomPhase ? <span>{roomPhase}</span> : null}
          {selectedMap ? <small>{formatMapName(selectedMap)}</small> : null}
        </div>
      </section>

      {!room ? (
        <section className="faceit-empty-room">
          <strong>暂无比赛房间</strong>
          <span>等待匹配成功后进入 Matchroom。</span>
        </section>
      ) : (
        <div className="faceit-match-grid">
          {renderTeam(room.teamA, "left", account?.id, room.phase)}

          <main className="faceit-center-panel">
            <div className="faceit-progress-line" />

            {selectedMap ? (
              <section className="faceit-final-map-preview" aria-label="最终地图">
                <span>最终地图</span>
                <strong>{formatMapName(selectedMap)}</strong>
                <span
                  className="faceit-final-map-thumb"
                  style={mapImageUrl(selectedMap) ? { backgroundImage: `url("${mapImageUrl(selectedMap)}")` } : undefined}
                  aria-hidden="true"
                />
              </section>
            ) : null}

            {room.phase === "queue" ? (
              <section className="faceit-connect-panel" aria-live="polite">
                <span>正在匹配</span>
                <strong className="faceit-countdown"><Spin /></strong>
                <small>正在确认匹配结果，请稍候。</small>
              </section>
            ) : null}

            {room.phase === "ready" ? (
              <section className="faceit-connect-panel">
                <span>{readyCountdownStarted ? "准备倒计时" : "准备倒计时启动中"}</span>
                <strong className="faceit-countdown">{readyCountdownStarted ? formatReadyCountdown(room.readyDeadlineAt, nowMs) : "--:--"}</strong>
                <div className="faceit-ready-list">
                  {(room.ready ?? []).map((entry) => (
                    <div className="faceit-ready-row" key={entry.accountId}>
                      <span>{participantNames.get(entry.accountId) ?? entry.accountId}</span>
                      <strong>{entry.ready ? "已准备" : "等待中"}</strong>
                    </div>
                  ))}
                </div>
                {canUseReadyActions ? (
                  <div className="faceit-action-row">
                    <Button
                      aria-label="准备"
                      type="primary"
                      onClick={() => void handleAcceptReady()}
                      disabled={!onAcceptReady || !readyCountdownStarted || selfReady || Boolean(readyActionPending)}
                      loading={readyActionPending === "accept"}
                    >
                      准备
                    </Button>
                    <Button
                      aria-label="拒绝本场"
                      onClick={() => void handleDeclineReady()}
                      disabled={!onDeclineReady || !readyCountdownStarted || selfReady || Boolean(readyActionPending)}
                      loading={readyActionPending === "decline"}
                    >
                      拒绝本场
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}

            {room.phase === "map_randomizing" ? (
              room.mapSelection
                ? <RandomMapReel mapSelection={room.mapSelection} onSettled={onMapRevealComplete} />
                : (
                    <section className="faceit-connect-panel" aria-live="polite">
                      <span>地图阶段</span>
                      <strong>等待所有玩家进入</strong>
                      <small>所有客户端完成页面切换后，服务器会同步启动随机地图。</small>
                    </section>
                  )
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
                {connect ? (
                  <Button
                    aria-label="复制进服指令"
                    type="primary"
                    className="faceit-connect-button"
                    onClick={() => void onCopyText?.(connect.connectCommand)}
                    disabled={!onCopyText}
                  >
                    复制进服指令
                  </Button>
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

          {renderTeam(room.teamB, "right", account?.id, room.phase)}
        </div>
      )}
    </div>
  );
}
