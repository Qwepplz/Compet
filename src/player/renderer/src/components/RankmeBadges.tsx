import { useLanguage } from "../../../../language/react.js";
import type { RankmeDisplay } from "../../../../rankme/rankmeStandings.js";
import { faceitLevelIconUrl, faceitRankIconUrl } from "../rankmeBadgeAssets.js";

export function RankmeBadges({ standing }: { standing: RankmeDisplay | null | undefined }) {
  const { t } = useLanguage();
  if (!standing) return null;
  const rank = standing.rank;
  const rankIcon = faceitRankIconUrl(standing.rank);
  return (
    <span className="rankme-badges">
      <img
        className="rankme-level-icon"
        src={faceitLevelIconUrl(standing.level)}
        alt={t("player.rankme.level", { level: standing.level })}
      />
      {rank !== null && rankIcon ? (
        <img className="rankme-rank-icon" src={rankIcon} alt={t("player.rankme.rank", { rank })} />
      ) : null}
    </span>
  );
}
