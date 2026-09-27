import type { RankmeDisplay } from "../../../../rankme/rankmeStandings.js";
import { faceitLevelIconUrl, faceitRankIconUrl } from "../rankmeBadgeAssets.js";

interface RankmeBadgesProps {
  standing: RankmeDisplay | null | undefined;
  showRank?: boolean;
}

export function RankmeBadges({ standing, showRank = true }: RankmeBadgesProps) {
  if (!standing) return null;
  const rank = standing.rank;
  const rankIcon = showRank && rank !== null ? faceitRankIconUrl(rank) : undefined;
  return (
    <span className="rankme-badges">
      <img
        className="rankme-level-icon"
        src={faceitLevelIconUrl(standing.level)}
        draggable={false}
      />
      {showRank && rank !== null && rankIcon ? (
        <span className="rankme-rank-viewport">
          <img className="rankme-rank-icon" src={rankIcon} draggable={false} />
        </span>
      ) : null}
    </span>
  );
}
