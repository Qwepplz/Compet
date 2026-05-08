import type { PlayerPartyDto } from "../../shared/types.js";

export function getVisiblePartyForHome(party: PlayerPartyDto | null): PlayerPartyDto | null {
  if (!party || party.memberAccountIds.length <= 1) return null;
  return party;
}
