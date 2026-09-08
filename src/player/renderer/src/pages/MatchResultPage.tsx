import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button } from "antd";
import type { CSSProperties } from "react";
import type { PlayerMatchPlayerResultDto, PlayerMatchResultDto } from "../../../shared/types.js";
import { SteamAvatar } from "../components/SteamAvatar.js";
import { VerificationBadge } from "../components/VerificationBadge.js";
import { useLanguage, type LanguageContextValue } from "../../../../language/react.js";

interface MatchResultPageProps {
  result: PlayerMatchResultDto;
  selfSteam64?: string;
  onBackHome: () => void;
}

const MIN_RATING2_PROGRESS = 8;

function playerName(player: PlayerMatchPlayerResultDto, fallback: string): string {
  return player.name || fallback;
}

function formatResultMapName(map: string): string {
  return map.replace(/^de_/, "").replace(/_/g, " ").toLowerCase();
}

function formatAdr(damage: number, totalRounds: number): string {
  return totalRounds > 0 ? (damage / totalRounds).toFixed(1) : "0.0";
}

function formatKillDeathRatio(kills: number, deaths: number): string {
  return deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
}

function formatKillsPerRound(kills: number, totalRounds: number): string {
  return totalRounds > 0 ? (kills / totalRounds).toFixed(2) : "0.00";
}

function formatHeadshotPercent(headshots: number, kills: number): string {
  return kills > 0 ? `${Math.round((headshots / kills) * 100)}%` : "0%";
}

function displayedRating2Value(rating2: number | undefined): number | null {
  return typeof rating2 === "number" && Number.isFinite(rating2) ? Number(rating2.toFixed(2)) : null;
}

function formatRating2(rating2: number | undefined): string {
  const displayed = displayedRating2Value(rating2);
  return displayed === null ? "-" : displayed.toFixed(2);
}

function playerBadge(player: PlayerMatchPlayerResultDto, t: LanguageContextValue["t"]): { variant: "gold" | "white"; title: string } | null {
  if (player.kind === "human") return { variant: "gold", title: t("common.labels.player") };
  if (player.botCategory === "pro") return { variant: "white", title: t("common.labels.proBot") };
  return null;
}

function rating2SortValue(player: PlayerMatchPlayerResultDto): number {
  return typeof player.rating2 === "number" && Number.isFinite(player.rating2) ? player.rating2 : Number.NEGATIVE_INFINITY;
}

function sortPlayersByRating2(players: PlayerMatchPlayerResultDto[]): PlayerMatchPlayerResultDto[] {
  return [...players].sort((left, right) => rating2SortValue(right) - rating2SortValue(left));
}

function rating2Tone(rating2: number | undefined): "low" | "mid" | "high" | "elite" | null {
  const displayed = displayedRating2Value(rating2);
  if (displayed === null) return null;
  if (displayed < 0.9) return "low";
  if (displayed < 1.3) return "mid";
  if (displayed < 1.8) return "high";
  return "elite";
}

function rating2Progress(rating2: number | undefined): number | null {
  const displayed = displayedRating2Value(rating2);
  if (displayed === null) return null;
  const progress = Math.min(100, Math.max(0, ((displayed - 0.55) / 1.25) * 100));
  return Math.max(MIN_RATING2_PROGRESS, progress);
}

export function MatchResultPage({ result, selfSteam64, onBackHome }: MatchResultPageProps) {
  const { t, formatDateTime } = useLanguage();
  const totalRounds = result.team1Score + result.team2Score;
  const teamSections = [
    {
      team: "teamA" as const,
      name: result.team1Name,
      logoImage: result.team1LogoImage,
      score: result.team1Score,
      firstHalfScore: result.firstHalfScore?.team1Score,
      secondHalfScore: result.secondHalfScore?.team1Score,
      players: sortPlayersByRating2(result.players.filter((player) => player.team === "teamA")),
    },
    {
      team: "teamB" as const,
      name: result.team2Name,
      logoImage: result.team2LogoImage,
      score: result.team2Score,
      firstHalfScore: result.firstHalfScore?.team2Score,
      secondHalfScore: result.secondHalfScore?.team2Score,
      players: sortPlayersByRating2(result.players.filter((player) => player.team === "teamB")),
    },
  ];

  return (
    <div className="match-result-page">
      <section className="match-result-meta" aria-label={t("player.match.result")}>
        <span>{t("common.labels.bo1")}</span>
        <span>{formatDateTime(result.completedAt)}</span>
        <span>{formatResultMapName(result.mapName)}</span>
      </section>

      <section className="match-result-content">
        <Button className="match-result-back-button" aria-label={t("common.navigation.backToHome")} icon={<ArrowLeftOutlined />} onClick={onBackHome} />
        <section className="match-result-team-panels" aria-label={t("player.match.stats")}>
          {teamSections.map((section) => (
            <section className="match-result-team-section" key={section.team}>
              <header className="match-result-team-header">
                <div className="match-result-team-identity">
                  {section.logoImage ? <img className="match-result-team-logo" src={section.logoImage} alt="" /> : null}
                  <strong>{section.name}</strong>
                </div>
                {section.firstHalfScore !== undefined || section.secondHalfScore !== undefined ? (
                  <div className="match-result-team-halves">
                    <span>
                      <span>{t("common.labels.firstHalf")}</span>
                      <strong>{section.firstHalfScore ?? "-"}</strong>
                    </span>
                    <span>
                      <span>{t("common.labels.secondHalf")}</span>
                      <strong>{section.secondHalfScore ?? "-"}</strong>
                    </span>
                  </div>
                ) : null}
                <strong className={`match-result-team-score${section.team === result.winner ? " match-result-team-score--winner" : " match-result-team-score--loser"}`}>
                  {section.score}
                </strong>
              </header>
              <div className="match-result-team-panel">
                <div className="match-result-table-wrap">
                  <table className="match-result-table">
                    <thead>
                      <tr>
                        <th>{t("common.labels.player")}</th>
                        <th>{t("common.labels.kills")}</th>
                        <th>{t("common.labels.deaths")}</th>
                        <th>{t("common.labels.assists")}</th>
                        <th>{t("common.labels.adr")}</th>
                        <th>{t("common.labels.kd")}</th>
                        <th>{t("common.labels.kr")}</th>
                        <th>{t("common.labels.headshots")}</th>
                        <th>{t("common.labels.hsPercent")}</th>
                        <th>{t("common.labels.rating")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.players.map((player) => {
                        const name = playerName(player, t("common.player.unknown"));
                        const isSelf = Boolean(selfSteam64) && player.steam64 === selfSteam64;
                        const badge = playerBadge(player, t);
                        const ratingTone = rating2Tone(player.rating2);
                        const ratingProgress = rating2Progress(player.rating2);
                        return (
                          <tr key={player.steam64 || `${player.team}-${player.name}`}>
                            <td>
                              <div className="match-result-player">
                                <SteamAvatar className="match-result-player-avatar" avatarUrl={player.avatarUrl} label={name} />
                                <div className="match-result-player-name-line">
                                  <strong className={isSelf ? "match-result-player-name--self" : undefined}>{name}</strong>
                                  {badge ? <VerificationBadge variant={badge.variant} title={badge.title} /> : null}
                                </div>
                              </div>
                            </td>
                            <td>{player.kills}</td>
                            <td>{player.deaths}</td>
                            <td>{player.assists}</td>
                            <td>{formatAdr(player.damage, totalRounds)}</td>
                            <td>{formatKillDeathRatio(player.kills, player.deaths)}</td>
                            <td>{formatKillsPerRound(player.kills, totalRounds)}</td>
                            <td>{player.headshots}</td>
                            <td>{formatHeadshotPercent(player.headshots, player.kills)}</td>
                            <td className="match-result-rating">
                              <span
                                className={ratingTone ? `match-result-rating-pill match-result-rating-pill--${ratingTone}` : "match-result-rating-pill"}
                                style={
                                  ratingProgress === null
                                    ? undefined
                                    : ({ "--match-result-rating-progress": `${ratingProgress}%` } as CSSProperties)
                                }
                              >
                                {formatRating2(player.rating2)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          ))}
        </section>
      </section>
    </div>
  );
}
