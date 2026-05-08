import type { MatchConnectInfo } from "../game/matchExecutor.js";
import type { MatchChatMessage } from "../matchmaking/matchmakingStore.js";
import type { PublicVetoState, VetoHistoryEntry } from "../matchmaking/vetoService.js";

type RealtimeEventWithSeq<T> = T & { seq?: number };

export type RealtimeEvent =
  | RealtimeEventWithSeq<{
      type: "presence_updated";
      accountId: string;
      online: boolean;
      connectionCount: number;
      lastSeenAt?: string;
    }>
  | RealtimeEventWithSeq<{ type: "friend_request_received"; accountId: string; request: unknown }>
  | RealtimeEventWithSeq<{ type: "friend_request_resolved"; accountId: string; request: unknown }>
  | RealtimeEventWithSeq<{ type: "friend_list_refresh"; accountId: string }>
  | RealtimeEventWithSeq<{ type: "party_updated"; accountIds: string[]; party: unknown }>
  | RealtimeEventWithSeq<{ type: "party_invite_received"; accountIds: string[]; invitation: unknown }>
  | RealtimeEventWithSeq<{ type: "party_invite_resolved"; accountIds: string[]; invitation: unknown }>
  | RealtimeEventWithSeq<{ type: "queue_updated"; accountIds: string[]; queue: unknown[] }>
  | RealtimeEventWithSeq<{
      type: "ready_check_started";
      matchId: string;
      roomId: string;
      accountIds: string[];
      deadlineAt: string;
      ready: unknown[];
      humanParticipants: unknown[];
    }>
  | RealtimeEventWithSeq<{
      type: "ready_check_updated";
      matchId: string;
      roomId: string;
      accountIds: string[];
      deadlineAt: string;
      ready: unknown[];
      humanParticipants: unknown[];
    }>
  | RealtimeEventWithSeq<{ type: "match_room_created"; matchId: string; accountIds?: string[]; room: unknown }>
  | RealtimeEventWithSeq<{ type: "teams_assigned"; matchId: string; accountIds?: string[]; teamA: unknown; teamB: unknown }>
  | RealtimeEventWithSeq<{ type: "veto_started"; matchId: string; accountIds?: string[]; veto: PublicVetoState }>
  | RealtimeEventWithSeq<{ type: "veto_tick"; matchId: string; accountIds?: string[]; deadlineAt: string }>
  | RealtimeEventWithSeq<{ type: "map_banned"; matchId: string; accountIds?: string[]; entry: VetoHistoryEntry; veto?: PublicVetoState }>
  | RealtimeEventWithSeq<{ type: "map_picked"; matchId: string; accountIds?: string[]; entry: VetoHistoryEntry; veto?: PublicVetoState }>
  | RealtimeEventWithSeq<{ type: "match_chat_message"; matchId: string; accountIds?: string[]; message: MatchChatMessage }>
  | RealtimeEventWithSeq<{ type: "server_preparing"; matchId: string; accountIds?: string[] }>
  | RealtimeEventWithSeq<{ type: "connect_ready"; matchId: string; accountIds?: string[]; connect: MatchConnectInfo }>
  | RealtimeEventWithSeq<{ type: "match_live"; matchId: string; accountIds?: string[] }>
  | RealtimeEventWithSeq<{ type: "match_completed"; matchId: string; accountIds?: string[]; result?: unknown }>
  | RealtimeEventWithSeq<{ type: "match_failed"; matchId: string; accountIds?: string[]; error: unknown }>;

export type SequencedRealtimeEvent = RealtimeEvent & { seq: number };
