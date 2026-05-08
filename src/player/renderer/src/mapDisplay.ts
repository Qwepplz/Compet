export function formatMapName(map: string): string {
  return map.replace(/^de_/, "").replace(/_/g, " ").toUpperCase();
}
