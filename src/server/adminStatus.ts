import type { QueueEntry, MatchRoomRecord } from "../matchmaking/matchmakingStore.js";
import type { MatchmakingOccupancySummary } from "../matchmaking/matchmakingService.js";

export interface AdminGameStatus {
  state: "running" | "stopped" | "unknown";
  pid?: number;
  port?: number;
}

export interface AdminMatchSummary {
  id: string;
  phase: MatchRoomRecord["phase"];
  createdAt: string;
  partyId?: string;
  map?: string;
  humanCount: number;
}

export interface MaintenanceStatus {
  requested: boolean;
  occupancy: MatchmakingOccupancySummary;
  pendingCleanupCount: number;
}

export interface AdminServerStatus {
  maintenanceRequested: boolean;
  occupancy: MatchmakingOccupancySummary;
  queue: { count: number; entries: Pick<QueueEntry, "accountId" | "partyId" | "queuedAt">[] };
  matches: AdminMatchSummary[];
  game: AdminGameStatus;
}
