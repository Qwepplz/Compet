import type { MatchConnectInfo } from "../game/matchExecutor.js";

type RealtimeEventWithSeq<T> = T & { seq?: number; serverNow?: string };

export type RealtimeEvent =
  | RealtimeEventWithSeq<{
      type: "presence_updated";
      accountId: string;
      accountIds?: string[];
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
  | RealtimeEventWithSeq<{ type: "matchmaking_occupancy_updated"; occupancy: { activeCount: number } }>
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
  | RealtimeEventWithSeq<{ type: "match_room_updated"; matchId: string; accountIds?: string[]; room: unknown }>
  | RealtimeEventWithSeq<{ type: "server_preparing"; matchId: string; accountIds?: string[] }>
  | RealtimeEventWithSeq<{ type: "connect_ready"; matchId: string; accountIds?: string[]; connect: MatchConnectInfo }>
  | RealtimeEventWithSeq<{ type: "match_live"; matchId: string; accountIds?: string[] }>
  | RealtimeEventWithSeq<{ type: "match_completed"; matchId: string; accountIds?: string[]; result?: unknown }>
  | RealtimeEventWithSeq<{
      type: "match_failed";
      matchId: string;
      accountIds?: string[];
      error: unknown;
      readyDeclinedByDisplayName?: string;
    }>;

export type SequencedRealtimeEvent = RealtimeEvent & { seq: number };
