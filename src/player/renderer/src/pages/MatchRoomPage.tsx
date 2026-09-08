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
import { useLanguage, type LanguageContextValue } from "../../../../language/react.js";

interface MatchRoomPageProps {
  account: AccountView | null;
  room: PlayerLiveMatchStateDto | null;
  nowMs: number;
  onAcceptReady?: () => Promise<void>;
  onDeclineReady?: () => Promise<void>;
  onMapRevealComplete?: () => void;
  onCopyText?: (text: string) => Promise<void>;
}

function phaseLabel(phase: PlayerLiveMatchStateDto["phase"] | undefined, t: LanguageContextValue["t"]): string | null {
  switch (phase) {
    case "ready":
      return t("player.match.phase.ready");
    case "match_room":
      return t("player.match.phase.matchRoom");
    case "map_randomizing":
      return t("player.match.phase.mapRandomizing");
    case "server_prepare":
      return t("player.match.phase.serverPrepare");
    case "connect":
      return null;
    case "live":
      return t("player.match.phase.live");
    case "completed":
      return t("player.match.phase.completed");
    case "failed":
      return t("player.match.phase.failed");
    case "queue":
    default:
      return t("player.match.phase.waiting");
  }
}

function participantName(participant: PlayerMatchParticipantDto, fallback: string): string {
  return participantDisplayName(participant, fallback);
}

function participantBadge(participant: PlayerMatchParticipantDto, t: LanguageContextValue["t"]): { variant: "gold" | "white"; title: string } | null {
  if (participant.kind === "human") return { variant: "gold", title: t("common.labels.player") };
  if (participant.botCategory === "pro") return { variant: "white", title: t("common.labels.proBot") };
  return null;
}


function isReadyAnonymous(phase: string | undefined, participant: PlayerMatchParticipantDto, accountId: string | undefined): boolean {
  if (phase !== "ready") return false;
  if (accountId && participant.accountId === accountId) return false;
  return true;
}

function renderTeam(
  team: PlayerMatchTeamDto | null | undefined,
  side: "left" | "right",
  accountId: string | undefined,
  phase: string | undefined,
  t: LanguageContextValue["t"],
) {
  if (!team) return null;

  return (
    <section className={`faceit-team-column faceit-team-column--${side}`}>
      <div className="faceit-team-title">
        <span>{t("common.labels.players")}</span>
        <div className="faceit-team-identity">
          {team.logoImage ? <img className="faceit-team-logo" src={team.logoImage} alt="" /> : null}
          <strong>{team.name}</strong>
        </div>
      </div>
      <div className="faceit-player-list">
        {team.participants.map((participant) => {
          const isSelf = Boolean(accountId && participant.accountId === accountId);
          const anonymous = isReadyAnonymous(phase, participant, accountId);
          const displayName = anonymous ? t("player.match.anonymousPlayer") : participantName(participant, t("common.player.unknown"));
          const avatarLabel = anonymous ? undefined : participantName(participant, t("common.player.unknown"));
          const avatarUrl = anonymous ? undefined : participant.steamAvatarUrl;
          const badge = anonymous ? null : participantBadge(participant, t);
          return (
            <div className={`faceit-player-card${isSelf ? " faceit-player-card--self" : ""}`} key={participant.id}>
              <SteamAvatar className="faceit-player-avatar" avatarUrl={avatarUrl} label={avatarLabel} />
              <div className="faceit-player-main">
                <div className="faceit-player-name-line">
                  <strong>{displayName}</strong>
                  {badge ? <VerificationBadge variant={badge.variant} title={badge.title} /> : null}
                  {!anonymous && participant.isCaptain ? (
                    <span className="faceit-captain-badge" aria-label={t("common.labels.captain")} title={t("common.labels.captain")}>
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
  const { t } = useLanguage();
  const connect = room?.connect;
  const selectedMap = getSelectedMap(room, nowMs);
  const roomPhase = phaseLabel(room?.phase, t);
  const readyCountdownStarted = room?.phase === "ready" && Boolean(room.readyDeadlineAt);
  const canUseReadyActions = isAccountInReadyRoom(room, account?.id);
  const selfReady = room?.ready?.find((entry) => entry.accountId === account?.id)?.ready === true;
  const [readyActionPending, setReadyActionPending] = useState<"accept" | "decline" | null>(null);
  const participantNames = new Map(
    [...(room?.teamA?.participants ?? []), ...(room?.teamB?.participants ?? [])]
      .flatMap((participant) => (participant.accountId ? [[participant.accountId, participantName(participant, t("common.player.unknown"))] as const] : [])),
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
          <strong>{t("player.match.format")}</strong>
          {roomPhase ? <span>{roomPhase}</span> : null}
          {selectedMap ? <small>{formatMapName(selectedMap)}</small> : null}
        </div>
      </section>

      {!room ? (
        <section className="faceit-empty-room">
          <strong>{t("player.match.roomEmpty")}</strong>
          <span>{t("player.match.roomWaiting")}</span>
        </section>
      ) : (
        <div className="faceit-match-grid">
          {renderTeam(room.teamA, "left", account?.id, room.phase, t)}

          <main className="faceit-center-panel">
            <div className="faceit-progress-line" />

            {selectedMap ? (
              <section className="faceit-final-map-preview" aria-label={t("player.match.finalMap")}>
                <span>{t("player.match.finalMap")}</span>
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
                <span>{t("common.state.matching")}</span>
                <strong className="faceit-countdown"><Spin /></strong>
                <small>{t("player.match.waitingForResult")}</small>
              </section>
            ) : null}

            {room.phase === "ready" ? (
              <section className="faceit-connect-panel">
                <span>{readyCountdownStarted ? t("player.match.readyCountdown") : t("player.match.readyCountdownStarting")}</span>
                <strong className="faceit-countdown">{readyCountdownStarted ? formatReadyCountdown(room.readyDeadlineAt, nowMs) : "--:--"}</strong>
                <div className="faceit-ready-list">
                  {(room.ready ?? []).map((entry) => (
                    <div className="faceit-ready-row" key={entry.accountId}>
                      <span>{participantNames.get(entry.accountId) ?? entry.accountId}</span>
                      <strong>{entry.ready ? t("common.state.ready") : t("common.state.waiting")}</strong>
                    </div>
                  ))}
                </div>
                {canUseReadyActions ? (
                  <div className="faceit-action-row">
                    <Button
                      aria-label={t("player.match.ready")}
                      type="primary"
                      onClick={() => void handleAcceptReady()}
                      disabled={!onAcceptReady || !readyCountdownStarted || selfReady || Boolean(readyActionPending)}
                      loading={readyActionPending === "accept"}
                    >
                      {t("player.match.ready")}
                    </Button>
                    <Button
                      aria-label={t("player.match.decline")}
                      onClick={() => void handleDeclineReady()}
                      disabled={!onDeclineReady || !readyCountdownStarted || selfReady || Boolean(readyActionPending)}
                      loading={readyActionPending === "decline"}
                    >
                      {t("player.match.decline")}
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
                      <span>{t("player.match.mapStage")}</span>
                      <strong>{t("player.match.waitingPlayers")}</strong>
                      <small>{t("player.match.mapStageWaiting")}</small>
                    </section>
                  )
            ) : null}

            {room.phase === "match_room" || room.phase === "server_prepare" ? (
              <section className="faceit-connect-panel">
                <span>{room.phase === "server_prepare" ? t("common.labels.server") : t("common.labels.match")}</span>
                <strong>{room.phase === "server_prepare" ? t("player.match.phase.serverPrepare") : t("player.match.finalTeams")}</strong>
                <small>{t("player.match.waitingGet5")}</small>
              </section>
            ) : null}

            {room.phase === "connect" || room.phase === "live" ? (
              <section className="faceit-connect-panel">
                {connect ? (
                  <Button
                    aria-label={t("player.match.copyConnectCommand")}
                    type="primary"
                    className="faceit-connect-button"
                    onClick={() => void onCopyText?.(connect.connectCommand)}
                    disabled={!onCopyText}
                  >
                    {t("player.match.copyConnectCommand")}
                  </Button>
                ) : (
                  <small>{t("player.match.connectUnavailable")}</small>
                )}
              </section>
            ) : null}

            {room.phase === "completed" || room.phase === "failed" ? (
              <section className="faceit-connect-panel">
                <span>{room.phase === "completed" ? t("common.status.matchCompleted") : t("common.status.matchFailed")}</span>
                <strong>{room.phase === "completed" ? t("player.match.completedTitle") : t("player.match.failedTitle")}</strong>
                <small>{t("player.match.endedConnectInvalid")}</small>
              </section>
            ) : null}
          </main>

          {renderTeam(room.teamB, "right", account?.id, room.phase, t)}
        </div>
      )}
    </div>
  );
}
