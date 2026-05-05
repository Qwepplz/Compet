export interface BotInfoEntry {
  name: string;
  steamAccountId: number;
  crosshairCode?: string;
}

export function parseBotInfo(content: string): Map<string, BotInfoEntry> {
  const parsed = JSON.parse(content) as Record<string, { steamid?: number; crosshair_code?: string }>;

  return new Map(Object.entries(parsed)
    .filter(([, value]) => typeof value.steamid === "number")
    .map(([name, value]) => [
      name,
      { name, steamAccountId: value.steamid!, crosshairCode: value.crosshair_code },
    ]));
}
