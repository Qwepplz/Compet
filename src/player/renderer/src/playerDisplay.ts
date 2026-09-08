import type { AccountView } from "../../../manager/shared/types.js";
import type { PlayerMatchParticipantDto } from "../../shared/types.js";

export function playerAccountLabel(
  account: Pick<AccountView, "steamPersonaName" | "steam64"> | null | undefined,
  fallback = "Player",
): string {
  const steamPersonaName = account?.steamPersonaName?.trim();
  if (steamPersonaName) return steamPersonaName;
  const steam64 = account?.steam64?.trim();
  return steam64 || fallback;
}

export function participantDisplayName(participant: PlayerMatchParticipantDto, fallback = "Unknown player"): string {
  const steamPersonaName = participant.steamPersonaName?.trim();
  if (steamPersonaName) return steamPersonaName;
  if (participant.kind === "human") return participant.steam64?.trim() || fallback;
  return participant.displayName?.trim() || "BOT";
}
