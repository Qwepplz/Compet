import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button } from "antd";
import type { PlayerMatchPlayerResultDto, PlayerMatchResultDto } from "../../../shared/types.js";
import { formatMapName } from "../mapAssets.js";

interface MatchResultPageProps {
  result: PlayerMatchResultDto;
  onBackHome: () => void;
}

function teamName(team: PlayerMatchPlayerResultDto["team"]): string {
  return team === "teamA" ? "Team A" : "Team B";
}

function playerName(player: PlayerMatchPlayerResultDto): string {
  return player.name || player.steam64;
}

function formatAdr(damage: number, totalRounds: number): string {
  return totalRounds > 0 ? (damage / totalRounds).toFixed(1) : "0.0";
}

export function MatchResultPage({ result, onBackHome }: MatchResultPageProps) {
  const winnerName = teamName(result.winner);
  const totalRounds = result.team1Score + result.team2Score;
  const teamSections = [
    {
      team: "teamA" as const,
      name: "Team A",
      score: result.team1Score,
      players: result.players.filter((player) => player.team === "teamA"),
    },
    {
      team: "teamB" as const,
      name: "Team B",
      score: result.team2Score,
      players: result.players.filter((player) => player.team === "teamB"),
    },
  ];

  return (
    <div className="match-result-page">
      <header className="match-result-header">
        <div>
          <span>Match Result</span>
          <h1>{formatMapName(result.mapName)}</h1>
        </div>
        <Button icon={<ArrowLeftOutlined />} onClick={onBackHome}>
          返回大厅
        </Button>
      </header>

      <section className="match-result-meta" aria-label="比赛结果">
        <span>BO1</span>
        <strong>{winnerName} 胜出</strong>
        <span>{new Date(result.completedAt).toLocaleString("zh-CN", { hour12: false })}</span>
      </section>

      <section className="match-result-team-panels" aria-label="玩家战绩">
        {teamSections.map((section) => (
          <section className="match-result-team-panel" key={section.team}>
            <header className="match-result-team-panel-header">
              <div>
                <span>{section.team === result.winner ? "胜利" : "失败"}</span>
                <strong>{section.name}</strong>
              </div>
              <strong className={`match-result-team-score${section.team === result.winner ? " match-result-team-score--winner" : ""}`}>
                {section.score}
              </strong>
            </header>
            <div className="match-result-table-wrap">
              <table className="match-result-table">
                <thead>
                  <tr>
                    <th>玩家</th>
                    <th>K</th>
                    <th>D</th>
                    <th>A</th>
                    <th>ADR</th>
                    <th>MVP</th>
                  </tr>
                </thead>
                <tbody>
                  {section.players.map((player) => (
                    <tr key={player.steam64 || `${player.team}-${player.name}`}>
                      <td>
                        <strong>{playerName(player)}</strong>
                        <span>{player.steam64}</span>
                      </td>
                      <td>{player.kills}</td>
                      <td>{player.deaths}</td>
                      <td>{player.assists}</td>
                      <td>{formatAdr(player.damage, totalRounds)}</td>
                      <td>{player.mvp}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </section>
    </div>
  );
}
