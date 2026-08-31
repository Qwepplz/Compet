import type { PartyInvitationRecord } from "./matchmakingStore.js";

export interface PartyInvitationDto {
  id: string;
  partyId: string;
  fromAccountId: string;
  toAccountId: string;
  status: PartyInvitationRecord["status"];
  createdAt: string;
  resolvedAt?: string;
  fromDisplayName: string;
  toDisplayName: string;
}
