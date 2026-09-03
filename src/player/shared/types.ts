import type {
  FriendDto,
  FriendListDto,
  FriendRequestDto,
  FriendSearchResult,
} from "../../friends/friendService.js";
import type { MatchConnectInfo } from "../../game/matchExecutor.js";
import type { PublicMatchRoomRecord } from "../../matchmaking/matchmakingService.js";
import type { PartyInvitationDto } from "../../matchmaking/partyInvitationTypes.js";
import type { MatchClientStage, MatchRoomReadyState, PartyRecord, QueueEntry } from "../../matchmaking/matchmakingStore.js";
import type { MatchParticipant, MatchPlayerResult, MatchSeriesResult, MatchTeam } from "../../matchmaking/types.js";
import type { MatchHistoryEntry } from "../../records/matchHistory.js";

export type PlayerRealtimeConnection = "connected" | "connecting" | "disconnected";

export type PlayerFriendSearchResultDto = FriendSearchResult;
export type PlayerFriendDto = FriendDto;
export type PlayerFriendRequestDto = FriendRequestDto;
export type PlayerFriendListDto = FriendListDto;
export type PlayerPartyDto = PartyRecord;
export type PlayerPartyInvitationDto = PartyInvitationDto;
export type PlayerQueueEntryDto = QueueEntry;
export type PlayerReadyStateDto = MatchRoomReadyState;
export type PlayerMatchParticipantDto = MatchParticipant;
export type PlayerMatchTeamDto = MatchTeam;
export type PlayerConnectDto = MatchConnectInfo;
export type PlayerMatchStageDto = MatchClientStage;
export type PlayerLiveMatchStateDto = PublicMatchRoomRecord;
export type PlayerMatchResultDto = MatchSeriesResult;
export type PlayerMatchPlayerResultDto = MatchPlayerResult;
export type PlayerServerTimedDto<T> = T & { serverNow?: string };

export type PlayerMatchHistoryEntryDto = MatchHistoryEntry;

export interface PlayerMatchHistoryDto {
  rankmeScore: number | null;
  matches: PlayerMatchHistoryEntryDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PlayerRealtimeStatusDto {
  connection: PlayerRealtimeConnection;
  stale: boolean;
}

export interface PlayerMatchmakingOccupancyDto {
  activeCount: number;
}

export interface PlayerMatchmakingStateDto {
  queue: PlayerQueueEntryDto[];
  rooms: PlayerLiveMatchStateDto[];
  party: PlayerPartyDto | null;
  partyInvitations: PlayerPartyInvitationDto[];
  room: PlayerLiveMatchStateDto | null;
  occupancy: PlayerMatchmakingOccupancyDto;
  serverNow?: string;
  baseSeq: number;
}

export interface PlayerRealtimeSnapshotDto {
  friends: PlayerFriendListDto;
  matchmaking: PlayerMatchmakingStateDto;
}

type PlayerRealtimeEventWithSeq<T> = T & { seq?: number; serverNow?: string };

export type PlayerRealtimeEvent =
  | PlayerRealtimeEventWithSeq<{
      type: "presence_updated";
      accountId: string;
      online: boolean;
      connectionCount: number;
      lastSeenAt?: string;
    }>
  | PlayerRealtimeEventWithSeq<{ type: "game_presence_updated"; accountId: string; inGame: boolean }>
  | PlayerRealtimeEventWithSeq<{ type: "friend_request_received"; accountId: string; request: PlayerFriendRequestDto }>
  | PlayerRealtimeEventWithSeq<{ type: "friend_request_resolved"; accountId: string; request: PlayerFriendRequestDto }>
  | PlayerRealtimeEventWithSeq<{ type: "friend_list_refresh"; accountId: string }>
  | PlayerRealtimeEventWithSeq<{ type: "party_updated"; party: PlayerPartyDto | null }>
  | PlayerRealtimeEventWithSeq<{ type: "party_invite_received"; invitation: PlayerPartyInvitationDto }>
  | PlayerRealtimeEventWithSeq<{ type: "party_invite_resolved"; invitation: PlayerPartyInvitationDto }>
  | PlayerRealtimeEventWithSeq<{ type: "queue_updated"; queue: PlayerQueueEntryDto[] }>
  | PlayerRealtimeEventWithSeq<{ type: "matchmaking_occupancy_updated"; occupancy: PlayerMatchmakingOccupancyDto }>
  | PlayerRealtimeEventWithSeq<{
      type: "ready_check_started";
      matchId: string;
      roomId: string;
      deadlineAt: string;
      ready: PlayerReadyStateDto[];
      humanParticipants: PlayerMatchParticipantDto[];
    }>
  | PlayerRealtimeEventWithSeq<{
      type: "ready_check_updated";
      matchId: string;
      roomId: string;
      deadlineAt: string;
      ready: PlayerReadyStateDto[];
      humanParticipants: PlayerMatchParticipantDto[];
    }>
  | PlayerRealtimeEventWithSeq<{ type: "match_room_created"; matchId: string; room: PlayerLiveMatchStateDto }>
  | PlayerRealtimeEventWithSeq<{ type: "match_room_updated"; matchId: string; room: PlayerLiveMatchStateDto }>
  | PlayerRealtimeEventWithSeq<{ type: "server_preparing"; matchId: string }>
  | PlayerRealtimeEventWithSeq<{ type: "connect_ready"; matchId: string; connect: PlayerConnectDto }>
  | PlayerRealtimeEventWithSeq<{ type: "match_live"; matchId: string }>
  | PlayerRealtimeEventWithSeq<{ type: "match_completed"; matchId: string; result?: MatchSeriesResult }>
  | PlayerRealtimeEventWithSeq<{
      type: "match_failed";
      matchId: string;
      error: string;
      readyDeclinedByDisplayName?: string;
    }>;
