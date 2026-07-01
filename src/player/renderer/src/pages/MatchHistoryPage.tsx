import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button, Spin } from "antd";
import type { PlayerMatchHistoryDto, PlayerMatchHistoryEntryDto } from "../../../shared/types.js";

interface MatchHistoryPageProps {
  history: PlayerMatchHistoryDto | null;
  loading: boolean;
  onBackHome: () => void;
  onOpenMatch: (matchId: string) => void;
}

export function formatRankmeScore(score: number | null | undefined): string {
  return typeof score === "number" && Number.isFinite(score) ? Math.round(score).toLocaleString("en-US") : "未排位";
}

function formatResultDate(completedAt: string): { date: string; time: string } {
  const date = new Date(completedAt);
  if (Number.isNaN(date.getTime())) return { date: "-", time: "-" };
  return {
    date: date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" }),
    time: date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

function formatMapName(mapName: string): string {
  return mapName.replace(/^de_/, "").replace(/_/g, " ");
}

function formatRating(rating2: number | undefined): string {
  return typeof rating2 === "number" && Number.isFinite(rating2) ? rating2.toFixed(2) : "-";
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
  rankmeScore,
  onOpenMatch,
}: {
  match: PlayerMatchHistoryEntryDto;
  rankmeScore: number | null;
  onOpenMatch: (matchId: string) => void;
}) {
  const date = formatResultDate(match.completedAt);
  return (
    <tr className="match-history-row" tabIndex={0} onClick={() => onOpenMatch(match.matchId)} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") onOpenMatch(match.matchId);
    }}>
      <td>
        <span>{date.date}</span>
        <small>{date.time}</small>
      </td>
      <td>
        <div className="match-history-score">
          <strong className={match.selfWon ? "match-history-result--win" : "match-history-result--loss"}>{match.selfWon ? "胜" : "负"}</strong>
          <span>{match.score.team1}</span>
          <span>:</span>
          <span>{match.score.team2}</span>
        </div>
      </td>
      <td className="match-history-rankme">{formatRankmeScore(rankmeScore)}</td>
      <td>{formatRating(match.self.rating2)}</td>
      <td>{match.self.kills} / {match.self.deaths} / {match.self.assists}</td>
      <td>{formatKillDeath(match.self.kills, match.self.deaths)}</td>
      <td>{formatAdr(match.self.damage, match.score.team1, match.score.team2)}</td>
      <td className="match-history-map">{formatMapName(match.mapName)}</td>
    </tr>
  );
}

export function MatchHistoryPage({ history, loading, onBackHome, onOpenMatch }: MatchHistoryPageProps) {
  const matches = history?.matches ?? [];
  const rankmeScore = history?.rankmeScore ?? null;
  return (
    <div className="match-history-page">
      <Button className="match-history-back-button" aria-label="返回主页面" icon={<ArrowLeftOutlined />} type="text" onClick={onBackHome} />
      <section className="match-history-panel" aria-label="历史战绩">
        <header className="match-history-header">
          <h1>Recent matches</h1>
          <span>Full match history</span>
        </header>
        <div className="match-history-table-wrap">
          {loading ? <Spin className="match-history-loading" /> : null}
          <table className="match-history-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>分数</th>
                <th aria-label="RankMe 分数"></th>
                <th>Rating</th>
                <th>K/D/A</th>
                <th>K/D</th>
                <th>ADR</th>
                <th>地图</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((match) => <MatchHistoryRow key={match.matchId} match={match} rankmeScore={rankmeScore} onOpenMatch={onOpenMatch} />)}
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
