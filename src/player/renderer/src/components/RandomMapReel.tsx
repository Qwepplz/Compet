import { useLayoutEffect, useRef, useState } from "react";
import type { PlayerLiveMatchStateDto } from "../../../shared/types.js";
import { useLanguage } from "../../../../language/react.js";
import { formatMapName, mapImageUrl } from "../mapAssets.js";
import { isMapRandomizingRevealed, mapReelPosition, mapReelOffset } from "../randomMapAnimation.js";

type MapSelection = NonNullable<PlayerLiveMatchStateDto["mapSelection"]>;

type RandomMapReelProps = {
  mapSelection: MapSelection;
  nowMs: number;
  active?: boolean;
  onRevealBoundary?: (revealAtMs: number) => void;
};

const TRAILING_PAD = 2;

export function RandomMapReel({ mapSelection, nowMs, active = true, onRevealBoundary }: RandomMapReelProps) {
  const { reel, finalMap } = mapSelection;
  const { t } = useLanguage();
  const winnerIndex = reel.length - 1;
  const tiles = [...reel, ...reel.slice(0, TRAILING_PAD)];

  const stripRef = useRef<HTMLDivElement>(null);
  const animationKey = [mapSelection.startedAt ?? "", mapSelection.revealAt ?? "", finalMap, reel.length].join("|");
  const [revealedAnimationKey, setRevealedAnimationKey] = useState<string | null>(null);
  const settled = revealedAnimationKey === animationKey || isMapRandomizingRevealed(mapSelection, nowMs);
  const onRevealBoundaryRef = useRef(onRevealBoundary);
  onRevealBoundaryRef.current = onRevealBoundary;
  const clock = useRef({ animationKey, nowMs, sampledAt: performance.now() });
  if (clock.current.animationKey !== animationKey || clock.current.nowMs !== nowMs) {
    clock.current = { animationKey, nowMs, sampledAt: performance.now() };
  }
  const reportedBoundaryRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const revealAtMs = Date.parse(mapSelection.revealAt ?? "");
    if (!active || !mapSelection.startedAt || !Number.isFinite(revealAtMs)) return;
    let frame = 0;
    const reportBoundary = () => {
      if (reportedBoundaryRef.current === animationKey) return;
      reportedBoundaryRef.current = animationKey;
      setRevealedAnimationKey(animationKey);
      onRevealBoundaryRef.current?.(revealAtMs);
    };
    const draw = () => {
      const syncedTime = clock.current.nowMs + performance.now() - clock.current.sampledAt;
      if (stripRef.current) {
        stripRef.current.style.transform = `translateX(${mapReelOffset(mapReelPosition(mapSelection, syncedTime))}%)`;
      }
      if (syncedTime >= revealAtMs) {
        reportBoundary();
        return;
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [active, animationKey, winnerIndex]);

  return (
    <section className="faceit-connect-panel faceit-reel-panel" aria-live="polite">
      <span>{settled ? t("player.reel.completed") : t("player.reel.randomizing")}</span>
      <div
        className="faceit-reel-viewport"
        aria-label={settled ? t("player.reel.finalMapAria", { map: formatMapName(finalMap) }) : t("player.reel.animationAria")}
      >
        <div className="faceit-reel-strip" ref={stripRef}>
          {tiles.map((map, index) => {
            const url = mapImageUrl(map);
            return (
              <div
                key={`${map}-${index}`}
                className={`faceit-reel-tile${settled && index === winnerIndex ? " is-winner" : ""}`}
                style={url ? { backgroundImage: `url("${url}")` } : undefined}
                aria-hidden="true"
              >
                <span className="faceit-reel-tile-label">{formatMapName(map)}</span>
              </div>
            );
          })}
        </div>
        <div className="faceit-reel-marker" aria-hidden="true" />
      </div>
      <strong className="faceit-reel-final-name">{formatMapName(finalMap)}</strong>
      <small>{settled ? t("player.reel.revealedNote") : t("player.reel.randomizingNote")}</small>
    </section>
  );
}
