import type { AccountView } from "../../../manager/shared/types.js";
import type { PlayerMatchParticipantDto } from "../../shared/types.js";

export function playerAccountLabel(account: Pick<AccountView, "steamPersonaName" | "steam64"> | null | undefined): string {
  const steamPersonaName = account?.steamPersonaName?.trim();
  if (steamPersonaName) return steamPersonaName;
  const steam64 = account?.steam64?.trim();
  return steam64 || "玩家";
}

export function participantDisplayName(participant: PlayerMatchParticipantDto): string {
  const steamPersonaName = participant.steamPersonaName?.trim();
  if (steamPersonaName) return steamPersonaName;
  if (participant.kind === "human") return participant.steam64?.trim() || "玩家";
  return participant.displayName?.trim() || "BOT";
}
