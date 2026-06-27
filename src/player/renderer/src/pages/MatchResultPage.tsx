import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button } from "antd";
import type { PlayerMatchPlayerResultDto, PlayerMatchResultDto } from "../../../shared/types.js";
import { SteamAvatar } from "../components/SteamAvatar.js";
import { VerificationBadge } from "../components/VerificationBadge.js";

interface MatchResultPageProps {
  result: PlayerMatchResultDto;
  onBackHome: () => void;
}

interface Rating2Cutoffs {
  low: number;
  high: number;
}

function playerName(player: PlayerMatchPlayerResultDto): string {
  return player.name || "玩家";
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

function formatRating2(rating2: number | undefined): string {
  return typeof rating2 === "number" && Number.isFinite(rating2) ? rating2.toFixed(2) : "-";
}

function playerAdr(player: PlayerMatchPlayerResultDto, totalRounds: number): number {
  return totalRounds > 0 ? player.damage / totalRounds : 0;
}

function playerBadge(player: PlayerMatchPlayerResultDto): { variant: "gold" | "white"; title: string } | null {
  if (player.kind === "human") return { variant: "gold", title: "Player" };
  if (player.botCategory === "pro") return { variant: "white", title: "Pro-Bot" };
  return null;
}

function sortPlayersByAdr(players: PlayerMatchPlayerResultDto[], totalRounds: number): PlayerMatchPlayerResultDto[] {
  return [...players].sort((left, right) => playerAdr(right, totalRounds) - playerAdr(left, totalRounds));
}

function matchRating2Cutoffs(players: PlayerMatchPlayerResultDto[]): Rating2Cutoffs | null {
  const ratings = players
    .map((player) => player.rating2)
    .filter((rating2): rating2 is number => typeof rating2 === "number" && Number.isFinite(rating2))
    .sort((left, right) => left - right);
  if (ratings.length === 0) return null;
  return {
    low: ratings[Math.floor((ratings.length - 1) / 3)]!,
    high: ratings[Math.ceil(((ratings.length - 1) * 2) / 3)]!,
  };
}

function rating2Tone(rating2: number | undefined, cutoffs: Rating2Cutoffs | null): "low" | "mid" | "high" | null {
  if (typeof rating2 !== "number" || !Number.isFinite(rating2) || !cutoffs) return null;
  if (cutoffs.low === cutoffs.high) return "mid";
  if (rating2 <= cutoffs.low) return "low";
  if (rating2 >= cutoffs.high) return "high";
  return "mid";
}

export function MatchResultPage({ result, onBackHome }: MatchResultPageProps) {
  const totalRounds = result.team1Score + result.team2Score;
  const rating2Cutoffs = matchRating2Cutoffs(result.players);
  const teamSections = [
    {
      team: "teamA" as const,
      name: "Team A",
      score: result.team1Score,
      players: sortPlayersByAdr(result.players.filter((player) => player.team === "teamA"), totalRounds),
    },
    {
      team: "teamB" as const,
      name: "Team B",
      score: result.team2Score,
      players: sortPlayersByAdr(result.players.filter((player) => player.team === "teamB"), totalRounds),
    },
  ];

  return (
    <div className="match-result-page">
      <section className="match-result-meta" aria-label="比赛结果">
        <span>BO1</span>
        <span>{new Date(result.completedAt).toLocaleString("zh-CN", { hour12: false })}</span>
        <span>{formatResultMapName(result.mapName)}</span>
      </section>

      <section className="match-result-content">
        <Button className="match-result-back-button" aria-label="返回大厅" icon={<ArrowLeftOutlined />} onClick={onBackHome} />
        <section className="match-result-team-panels" aria-label="玩家战绩">
          {teamSections.map((section) => (
            <section className="match-result-team-section" key={section.team}>
              <header className="match-result-team-header">
                <strong>{section.name}</strong>
                <strong className={`match-result-team-score${section.team === result.winner ? " match-result-team-score--winner" : ""}`}>
                  {section.score}
                </strong>
              </header>
              <div className="match-result-team-panel">
                <div className="match-result-table-wrap">
                  <table className="match-result-table">
                    <thead>
                      <tr>
                        <th>玩家</th>
                        <th>K</th>
                        <th>D</th>
                        <th>A</th>
                        <th>ADR</th>
                        <th>K/D</th>
                        <th>K/R</th>
                        <th>爆头</th>
                        <th>HS%</th>
                        <th>Rating 2.0</th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.players.map((player) => {
                        const name = playerName(player);
                        const badge = playerBadge(player);
                        const ratingTone = rating2Tone(player.rating2, rating2Cutoffs);
                        return (
                          <tr key={player.steam64 || `${player.team}-${player.name}`}>
                            <td>
                              <div className="match-result-player">
                                <SteamAvatar className="match-result-player-avatar" avatarUrl={player.avatarUrl} label={name} />
                                <div className="match-result-player-name-line">
                                  <strong>{name}</strong>
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
                            <td className={ratingTone ? `match-result-rating match-result-rating--${ratingTone}` : "match-result-rating"}>
                              {formatRating2(player.rating2)}
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
