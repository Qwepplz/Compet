import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button, Spin } from "antd";
import type { CSSProperties } from "react";
import type { PlayerMatchHistoryDto, PlayerMatchHistoryEntryDto } from "../../../shared/types.js";

interface MatchHistoryPageProps {
  history: PlayerMatchHistoryDto | null;
  loading: boolean;
  onBackHome: () => void;
  onOpenMatch: (matchId: string) => void;
}

const MIN_RATING2_PROGRESS = 8;

export function formatRankmeScore(score: number | null | undefined): string {
  return typeof score === "number" && Number.isFinite(score) ? Math.round(score).toLocaleString("en-US") : "-";
}

function formatRankmeChange(delta: number): string {
  const rounded = Math.round(delta);
  return Math.abs(rounded).toLocaleString("en-US");
}

function RankmeTrendIcon({ delta }: { delta: number }) {
  const isGain = Math.round(delta) >= 0;
  return (
    <svg className="match-history-rankme-trend-icon" viewBox="0 0 12 14" aria-hidden="true" focusable="false">
      <path
        d={isGain ? "M0 6l1.414 1.414L5 3.828V14h2V3.828l3.586 3.586L12 6 6 0 0 6z" : "M0 8l1.414-1.414L5 10.172V0h2v10.172l3.586-3.586L12 8l-6 6-6-6z"}
        fill="currentColor"
      />
    </svg>
  );
}

function RankmeScoreChange({ score, delta }: { score: number | null | undefined; delta: number | null | undefined }) {
  const hasDelta = typeof delta === "number" && Number.isFinite(delta);
  const roundedDelta = hasDelta ? Math.round(delta) : null;
  return (
    <div className="match-history-rankme-value">
      <span className="match-history-rankme-total">{formatRankmeScore(score)}</span>
      {roundedDelta === null ? null : (
        <span className={`match-history-rankme-trend match-history-rankme-trend--${roundedDelta >= 0 ? "gain" : "loss"}`}>
          <RankmeTrendIcon delta={roundedDelta} />
          <span>{formatRankmeChange(roundedDelta)}</span>
        </span>
      )}
    </div>
  );
}

function formatResultDate(completedAt: string): { date: string; time: string } {
  const date = new Date(completedAt);
  if (Number.isNaN(date.getTime())) return { date: "-", time: "-" };
  return {
    date: `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`,
    time: date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

function formatMapName(mapName: string): string {
  return mapName.replace(/^de_/, "").replace(/_/g, " ");
}

function formatRating(rating2: number | undefined): string {
  const displayed = displayedRating2Value(rating2);
  return displayed === null ? "-" : displayed.toFixed(2);
}

function displayedRating2Value(rating2: number | undefined): number | null {
  return typeof rating2 === "number" && Number.isFinite(rating2) ? Number(rating2.toFixed(2)) : null;
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

function formatKillDeath(kills: number, deaths: number): string {
  return (kills / Math.max(1, deaths)).toFixed(2);
}

function formatAdr(damage: number, team1: number, team2: number): string {
  const rounds = team1 + team2;
  return rounds > 0 ? (damage / rounds).toFixed(1) : "-";
}

function MatchHistoryRow({
  match,
  onOpenMatch,
}: {
  match: PlayerMatchHistoryEntryDto;
  onOpenMatch: (matchId: string) => void;
}) {
  const date = formatResultDate(match.completedAt);
  const ratingTone = rating2Tone(match.self.rating2);
  const ratingProgress = rating2Progress(match.self.rating2);
  const selfScore = match.selfTeam === "teamA" ? match.score.team1 : match.score.team2;
  const opponentScore = match.selfTeam === "teamA" ? match.score.team2 : match.score.team1;
  return (
    <tr className={`match-history-row match-history-row--${match.selfWon ? "win" : "loss"}`} tabIndex={0} onClick={() => onOpenMatch(match.matchId)} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") onOpenMatch(match.matchId);
    }}>
      <td>
        <span>{date.date}</span>
        <small>{date.time}</small>
      </td>
      <td>
        <div className="match-history-score">
          <strong className={`match-history-result-pill match-history-result-pill--${match.selfWon ? "win" : "loss"}`}>{match.selfWon ? "胜" : "负"}</strong>
          <span>{selfScore}</span>
          <span>:</span>
          <span>{opponentScore}</span>
        </div>
      </td>
      <td className="match-history-rankme">
        <RankmeScoreChange score={match.self.rankmeScore} delta={match.self.rankmeScoreDelta} />
      </td>
      <td className="match-history-rating">
        <span
          className={ratingTone ? `match-result-rating-pill match-result-rating-pill--${ratingTone}` : "match-result-rating-pill"}
          style={
            ratingProgress === null
              ? undefined
              : ({ "--match-result-rating-progress": `${ratingProgress}%` } as CSSProperties)
          }
        >
          {formatRating(match.self.rating2)}
        </span>
      </td>
      <td>{match.self.kills} / {match.self.deaths} / {match.self.assists}</td>
      <td>{formatKillDeath(match.self.kills, match.self.deaths)}</td>
      <td>{formatAdr(match.self.damage, match.score.team1, match.score.team2)}</td>
      <td className="match-history-map">{formatMapName(match.mapName)}</td>
    </tr>
  );
}

export function MatchHistoryPage({ history, loading, onBackHome, onOpenMatch }: MatchHistoryPageProps) {
  const matches = history?.matches ?? [];
  return (
    <div className="match-history-page">
      <Button className="match-history-back-button" aria-label="返回主页面" icon={<ArrowLeftOutlined />} type="text" onClick={onBackHome} />
      <section className="match-history-panel" aria-label="历史战绩">
        <header className="match-history-header">
          <h1>Recent matches</h1>
        </header>
        <div className="match-history-table-wrap">
          {loading ? <Spin className="match-history-loading" /> : null}
          <table className="match-history-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>分数</th>
                <th></th>
                <th>Rating</th>
                <th>K/D/A</th>
                <th>K/D</th>
                <th>ADR</th>
                <th>地图</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((match) => <MatchHistoryRow key={match.matchId} match={match} onOpenMatch={onOpenMatch} />)}
              {!loading && matches.length === 0 ? (
                <tr>
                  <td className="match-history-empty" colSpan={8}>暂无战绩</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
