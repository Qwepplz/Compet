import { Button, Spin } from "antd";
import { useState } from "react";
import type { AccountView } from "../../../../manager/shared/types.js";
import type { PlayerLiveMatchStateDto, PlayerMatchParticipantDto, PlayerMatchTeamDto } from "../../../shared/types.js";
import { SteamAvatar } from "../components/SteamAvatar.js";
import { VerificationBadge } from "../components/VerificationBadge.js";
import { RankmeBadges } from "../components/RankmeBadges.js";
import { formatMapName, mapImageUrl } from "../mapAssets.js";
import { formatReadyCountdown } from "../matchTimers.js";
import { getSelectedMap, getMatchPresentationPhase, isAccountInReadyRoom } from "../matchRoomState.js";
import { participantDisplayName } from "../playerDisplay.js";
import { useLanguage, type LanguageContextValue } from "../../../../language/react.js";

interface MatchRoomPageProps {
  account: AccountView | null;
  room: PlayerLiveMatchStateDto | null;
  nowMs: number;
  active?: boolean;
  onAcceptReady?: () => Promise<void>;
  onDeclineReady?: () => Promise<void>;
  onCopyText?: (text: string) => Promise<void>;
}

function phaseLabel(phase: PlayerLiveMatchStateDto["phase"] | undefined, t: LanguageContextValue["t"]): string | null {
  switch (phase) {
    case "ready":
      return t("player.match.phase.ready");
    case "match_room":
      return t("player.match.phase.matchRoom");
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

function participantBadge(participant: PlayerMatchParticipantDto): { variant: "gold" | "white" } | null {
  if (participant.kind === "human") return { variant: "gold" };
  if (participant.botCategory === "pro") return { variant: "white" };
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
          {team.logoImage ? <img className="faceit-team-logo" src={team.logoImage} draggable={false} /> : null}
          <strong>{team.name}</strong>
        </div>
      </div>
      <div className="faceit-player-list">
        {team.participants.map((participant) => {
          const isSelf = Boolean(accountId && participant.accountId === accountId);
          const anonymous = isReadyAnonymous(phase, participant, accountId);
          const displayName = anonymous ? t("player.match.anonymousPlayer") : participantName(participant, t("common.player.unknown"));
          const avatarUrl = anonymous ? undefined : participant.steamAvatarUrl;
          const badge = anonymous ? null : participantBadge(participant);
          return (
            <div className={`faceit-player-card${isSelf ? " faceit-player-card--self" : ""}`} key={participant.id}>
              <SteamAvatar className="faceit-player-avatar" avatarUrl={avatarUrl} />
              <div className="faceit-player-main">
                <div className="faceit-player-name-line">
                  <strong>{displayName}</strong>
                  {badge ? <VerificationBadge variant={badge.variant} /> : null}
                  {!anonymous && participant.isCaptain ? (
                    <span className="faceit-captain-badge">
                      <svg viewBox="0 0 24 24">
                        <path
                          fillRule="evenodd"
                          clipRule="evenodd"
                          d="M7.5 9.333L3 4v10.667h18V4l-4.5 5.333L12 4 7.5 9.333zM21 20v-2.667H3V20h18z"
                          fill="currentColor"
                        />
                      </svg>
                    </span>
                  ) : null}
                  {anonymous ? null : <RankmeBadges standing={participant.rankmeStanding} />}
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
  active = true,
  onAcceptReady,
  onDeclineReady,
  onCopyText,
}: MatchRoomPageProps) {
  const { t } = useLanguage();
  const selection = room?.mapSelection;
  const panelProps = (name: string, visible: boolean) => ({
    "data-flow-panel": name,
    inert: !active || !visible,
    className: `match-flow-panel${active && visible ? " is-active" : ""}`,
  });
  const connect = room?.connect;
  const selectedMap = getSelectedMap(room);
  const presentationPhase = getMatchPresentationPhase(room);
  const roomPhase = phaseLabel(presentationPhase, t);
  const readyCountdownStarted = active && room?.phase === "ready" && Boolean(room.readyStartsAt && room.readyDeadlineAt) && nowMs >= Date.parse(room.readyStartsAt!) && nowMs < Date.parse(room.readyDeadlineAt!);
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
          {renderTeam(room.teamA, "left", account?.id, presentationPhase, t)}

          <main className="faceit-center-panel">
            <div className="faceit-progress-line" />

            <div {...panelProps("final", Boolean(selectedMap))}>
              <section className="faceit-final-map-preview">
                <span>{t("player.match.finalMap")}</span>
                <strong>{selection ? formatMapName(selection.finalMap) : null}</strong>
                <span
                  className="faceit-final-map-thumb"
                  style={selection && mapImageUrl(selection.finalMap) ? { backgroundImage: `url("${mapImageUrl(selection.finalMap)}")` } : undefined}
                />
              </section>
            </div>

            {room.phase === "queue" ? (
              <section className="faceit-connect-panel">
                <span>{t("common.state.matching")}</span>
                <strong className="faceit-countdown"><Spin /></strong>
                <small>{t("player.match.waitingForResult")}</small>
              </section>
            ) : null}

            <div {...panelProps("ready", presentationPhase === "ready")}>
              <section className="faceit-connect-panel">
                <span>{readyCountdownStarted ? t("player.match.readyCountdown") : t("player.match.readyCountdownStarting")}</span>
                <strong className="faceit-countdown">{readyCountdownStarted ? formatReadyCountdown(room.readyDeadlineAt, nowMs) : "--:--"}</strong>
                <div className="faceit-ready-list">
                  {(room.ready ?? []).map((entry) => (
                    <div className="faceit-ready-row" key={entry.accountId}>
                      <span>{entry.accountId === account?.id ? participantNames.get(entry.accountId) ?? t("common.player.unknown") : t("player.match.anonymousPlayer")}</span>
                      <strong>{entry.ready ? t("common.state.ready") : t("common.state.waiting")}</strong>
                    </div>
                  ))}
                </div>
                {canUseReadyActions ? (
                  <div className="faceit-action-row">
                    <Button
                      type="primary"
                      onClick={() => void handleAcceptReady()}
                      disabled={!onAcceptReady || !readyCountdownStarted || selfReady || Boolean(readyActionPending)}
                      loading={readyActionPending === "accept"}
                    >
                      {t("player.match.ready")}
                    </Button>
                    <Button
                      onClick={() => void handleDeclineReady()}
                      disabled={!onDeclineReady || !readyCountdownStarted || selfReady || Boolean(readyActionPending)}
                      loading={readyActionPending === "decline"}
                    >
                      {t("player.match.decline")}
                    </Button>
                  </div>
                ) : null}
              </section>
            </div>

            <div {...panelProps("waiting", presentationPhase === "match_room" || presentationPhase === "server_prepare")}>
              <section className="faceit-connect-panel">
                <span>{presentationPhase === "server_prepare" ? t("common.labels.server") : t("common.labels.match")}</span>
                <strong>{presentationPhase === "server_prepare" ? t("player.match.phase.serverPrepare") : t("player.match.finalTeams")}</strong>
                <small>{t("player.match.waitingGet5")}</small>
              </section>
            </div>

            <div {...panelProps("connect", presentationPhase === "connect" || presentationPhase === "live")}>
              <section className="faceit-connect-panel">
                  <Button
                    type="primary"
                    className="faceit-connect-button"
                    onClick={() => { if (active && connect && (presentationPhase === "connect" || presentationPhase === "live")) void onCopyText?.(connect.connectCommand); }}
                    disabled={!active || !connect || !onCopyText || (presentationPhase !== "connect" && presentationPhase !== "live")}
                  >
                    {t("player.match.copyConnectCommand")}
                  </Button>
                {!connect ? <small>{t("player.match.connectUnavailable")}</small> : null}
              </section>
            </div>

            {room.phase === "completed" || room.phase === "failed" ? (
              <section className="faceit-connect-panel">
                <span>{room.phase === "completed" ? t("common.status.matchCompleted") : t("common.status.matchFailed")}</span>
                <strong>{room.phase === "completed" ? t("player.match.completedTitle") : t("player.match.failedTitle")}</strong>
                <small>{t("player.match.endedConnectInvalid")}</small>
              </section>
            ) : null}
          </main>

          {renderTeam(room.teamB, "right", account?.id, presentationPhase, t)}
        </div>
      )}
    </div>
  );
}
