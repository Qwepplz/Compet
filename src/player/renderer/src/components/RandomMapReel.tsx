import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PlayerLiveMatchStateDto } from "../../../shared/types.js";
import { formatMapName, mapImageUrl } from "../mapAssets.js";
import { isMapRandomizingRevealed, mapReelDurationMs, mapReelOffset } from "../randomMapAnimation.js";

type MapSelection = NonNullable<PlayerLiveMatchStateDto["mapSelection"]>;

const TRAILING_PAD = 2;

export function RandomMapReel({ mapSelection, onSettled }: { mapSelection: MapSelection; onSettled?: () => void }) {
  const { reel, finalMap } = mapSelection;
  const winnerIndex = reel.length - 1;
  const tiles = [...reel, ...reel.slice(0, TRAILING_PAD)];

  const stripRef = useRef<HTMLDivElement>(null);
  const [settled, setSettled] = useState(() => isMapRandomizingRevealed(mapSelection, Date.now()));

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const target = mapReelOffset(winnerIndex);

    if (isMapRandomizingRevealed(mapSelection, Date.now())) {
      strip.style.transition = "none";
      strip.style.transform = `translateX(${target}%)`;
      setSettled(true);
      return;
    }

    strip.style.transition = "none";
    strip.style.transform = `translateX(${mapReelOffset(1)}%)`;
    void strip.offsetWidth;

    const durationMs = mapReelDurationMs(mapSelection, Date.now());
    const handle = requestAnimationFrame(() => {
      strip.style.transition = `transform ${durationMs}ms cubic-bezier(0.16, 1, 0.3, 1)`;
      strip.style.transform = `translateX(${target}%)`;
    });
    const onEnd = () => setSettled(true);
    strip.addEventListener("transitionend", onEnd, { once: true });

    return () => {
      cancelAnimationFrame(handle);
      strip.removeEventListener("transitionend", onEnd);
    };
  }, [mapSelection.revealAt, winnerIndex]);

  useEffect(() => {
    if (settled) onSettled?.();
  }, [settled]);

  return (
    <section className="faceit-connect-panel faceit-reel-panel" aria-live="polite">
      <span>{settled ? "随机完成" : "随机地图中"}</span>
      <div
        className="faceit-reel-viewport"
        aria-label={settled ? `最终地图 ${formatMapName(finalMap)}` : "随机地图动画"}
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
      <strong className="faceit-reel-final-name">{settled ? formatMapName(finalMap) : "??"}</strong>
      <small>{settled ? "本场地图已确定，正在准备服务器。" : "系统正在随机选择本场地图。"}</small>
    </section>
  );
}
