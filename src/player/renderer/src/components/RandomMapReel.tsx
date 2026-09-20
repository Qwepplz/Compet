import { useLayoutEffect, useRef } from "react";
import type { PlayerLiveMatchStateDto } from "../../../shared/types.js";
import { useLanguage } from "../../../../language/react.js";
import { formatMapName, mapImageUrl } from "../mapAssets.js";
import { isMapRandomizingRevealed, mapReelPosition, mapReelOffset } from "../randomMapAnimation.js";

type MapSelection = NonNullable<PlayerLiveMatchStateDto["mapSelection"]>;

const TRAILING_PAD = 2;

export function RandomMapReel({ mapSelection, nowMs }: { mapSelection: MapSelection; nowMs: number }) {
  const { reel, finalMap } = mapSelection;
  const { t } = useLanguage();
  const winnerIndex = reel.length - 1;
  const tiles = [...reel, ...reel.slice(0, TRAILING_PAD)];

  const stripRef = useRef<HTMLDivElement>(null);
  const settled = isMapRandomizingRevealed(mapSelection, nowMs);
  const clock = useRef({ nowMs, sampledAt: performance.now() });
  clock.current = { nowMs, sampledAt: performance.now() };
  useLayoutEffect(() => {
    let frame = 0;
    const draw = () => {
      const syncedTime = clock.current.nowMs + performance.now() - clock.current.sampledAt;
      if (stripRef.current) {
        stripRef.current.style.transform = `translateX(${mapReelOffset(mapReelPosition(mapSelection, syncedTime))}%)`;
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [mapSelection.startedAt, mapSelection.revealAt, winnerIndex]);

  return (
    <section className="faceit-connect-panel faceit-reel-panel" aria-live="polite">
      <span>{settled ? t("player.reel.completed") : t("player.reel.randomizing")}</span>
      <div
        className="faceit-reel-viewport"
        aria-label={settled ? t("player.reel.finalMapAria", { map: formatMapName(finalMap) }) : t("player.reel.animationAria")}
      >
        <div className="faceit-reel-strip" ref={stripRef}>
          {tiles.map((map, index) => {
            const hidden = !settled && map === finalMap;
            const url = hidden ? undefined : mapImageUrl(map);
            return (
              <div
                key={`${map}-${index}`}
                className={`faceit-reel-tile${settled && index === winnerIndex ? " is-winner" : ""}`}
                style={url ? { backgroundImage: `url("${url}")` } : undefined}
                aria-hidden="true"
              >
                <span className="faceit-reel-tile-label">{hidden ? "??" : formatMapName(map)}</span>
              </div>
            );
          })}
        </div>
        <div className="faceit-reel-marker" aria-hidden="true" />
      </div>
      <strong className="faceit-reel-final-name">{settled ? formatMapName(finalMap) : "??"}</strong>
      <small>{settled ? t("player.reel.revealedNote") : t("player.reel.randomizingNote")}</small>
    </section>
  );
}
