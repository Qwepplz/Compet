import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button } from "antd";
import type { PlayerMatchPlayerResultDto, PlayerMatchResultDto } from "../../../shared/types.js";
import { SteamAvatar } from "../components/SteamAvatar.js";
import { formatMapName } from "../mapAssets.js";

interface MatchResultPageProps {
  result: PlayerMatchResultDto;
  onBackHome: () => void;
}

function playerName(player: PlayerMatchPlayerResultDto): string {
  return player.name || "玩家";
}

function formatAdr(damage: number, totalRounds: number): string {
  return totalRounds > 0 ? (damage / totalRounds).toFixed(1) : "0.0";
}

function playerAdr(player: PlayerMatchPlayerResultDto, totalRounds: number): number {
  return totalRounds > 0 ? player.damage / totalRounds : 0;
}

function sortPlayersByAdr(players: PlayerMatchPlayerResultDto[], totalRounds: number): PlayerMatchPlayerResultDto[] {
  return [...players].sort((left, right) => playerAdr(right, totalRounds) - playerAdr(left, totalRounds));
}

export function MatchResultPage({ result, onBackHome }: MatchResultPageProps) {
  const totalRounds = result.team1Score + result.team2Score;
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
                  {section.players.map((player) => {
                    const name = playerName(player);
                    return (
                      <tr key={player.steam64 || `${player.team}-${player.name}`}>
                        <td>
                          <div className="match-result-player">
                            <SteamAvatar className="match-result-player-avatar" avatarUrl={player.avatarUrl} label={name} />
                            <strong>{name}</strong>
                          </div>
                        </td>
                        <td>{player.kills}</td>
                        <td>{player.deaths}</td>
                        <td>{player.assists}</td>
                        <td>{formatAdr(player.damage, totalRounds)}</td>
                        <td>{player.mvp}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </section>
    </div>
  );
}
