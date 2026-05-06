import type { MatchConnectInfo } from "../game/matchExecutor.js";
import type { MatchChatMessage } from "../matchmaking/matchmakingStore.js";
import type { PublicVetoState, VetoHistoryEntry } from "../matchmaking/vetoService.js";

export type RealtimeEvent =
  | {
      type: "presence_updated";
      accountId: string;
      online: boolean;
      connectionCount: number;
      lastSeenAt?: string;
    }
  | { type: "friend_request_received"; accountId: string; request: unknown }
  | { type: "friend_request_resolved"; accountId: string; request: unknown }
  | { type: "friend_list_refresh"; accountId: string }
  | { type: "party_updated"; accountIds: string[]; party: unknown }
  | { type: "party_invite_received"; accountIds: string[]; invitation: unknown }
  | { type: "party_invite_resolved"; accountIds: string[]; invitation: unknown }
  | { type: "queue_updated"; accountIds: string[]; queue: unknown[] }
  | {
      type: "ready_check_started";
      matchId: string;
      roomId: string;
      accountIds: string[];
      deadlineAt: string;
      ready: unknown[];
      humanParticipants: unknown[];
    }
  | {
      type: "ready_check_updated";
      matchId: string;
      roomId: string;
      accountIds: string[];
      deadlineAt: string;
      ready: unknown[];
      humanParticipants: unknown[];
    }
  | { type: "match_room_created"; matchId: string; accountIds?: string[]; room: unknown }
  | { type: "teams_assigned"; matchId: string; accountIds?: string[]; teamA: unknown; teamB: unknown }
  | { type: "veto_started"; matchId: string; accountIds?: string[]; veto: PublicVetoState }
  | { type: "veto_tick"; matchId: string; accountIds?: string[]; deadlineAt: string }
  | { type: "map_banned"; matchId: string; accountIds?: string[]; entry: VetoHistoryEntry; veto?: PublicVetoState }
  | { type: "map_picked"; matchId: string; accountIds?: string[]; entry: VetoHistoryEntry; veto?: PublicVetoState }
  | { type: "match_chat_message"; matchId: string; accountIds?: string[]; message: MatchChatMessage }
  | { type: "server_preparing"; matchId: string; accountIds?: string[] }
  | { type: "connect_ready"; matchId: string; accountIds?: string[]; connect: MatchConnectInfo }
  | { type: "match_live"; matchId: string; accountIds?: string[] }
  | { type: "match_completed"; matchId: string; accountIds?: string[]; result?: unknown }
  | { type: "match_failed"; matchId: string; accountIds?: string[]; error: unknown };
