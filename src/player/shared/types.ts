import type {
  FriendDto,
  FriendListDto,
  FriendRequestDto,
  FriendSearchResult,
} from "../../friends/friendService.js";
import type { MatchConnectInfo } from "../../game/matchExecutor.js";
import type { PublicMatchRoomRecord, PartyInvitationDto } from "../../matchmaking/matchmakingService.js";
import type { MatchMapSelectionState, MatchRoomReadyState, PartyRecord, QueueEntry } from "../../matchmaking/matchmakingStore.js";
import type { MatchParticipant, MatchPlayerResult, MatchSeriesResult, MatchTeam } from "../../matchmaking/types.js";

export type PlayerRealtimeConnection = "connected" | "connecting" | "disconnected";
export type PlayerRealtimeSnapshotReason = "manual" | "reconnected";
export type PlayerRealtimeSnapshotScope = "full" | "matchmaking";

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
export type PlayerMapSelectionStateDto = MatchMapSelectionState;
export type PlayerLiveMatchStateDto = PublicMatchRoomRecord;
export type PlayerMatchResultDto = MatchSeriesResult;
export type PlayerMatchPlayerResultDto = MatchPlayerResult;

export interface PlayerRealtimeStatusDto {
  connection: PlayerRealtimeConnection;
  stale: boolean;
}

export interface PlayerMatchmakingStateDto {
  queue: PlayerQueueEntryDto[];
  rooms: PlayerLiveMatchStateDto[];
  party: PlayerPartyDto | null;
  partyInvitations: PlayerPartyInvitationDto[];
  room: PlayerLiveMatchStateDto | null;
}

export interface PlayerRealtimeSnapshotDto {
  reason: PlayerRealtimeSnapshotReason;
  friends?: PlayerFriendListDto;
  party?: PlayerPartyDto | null;
  matchmaking: PlayerMatchmakingStateDto;
}

type PlayerRealtimeEventWithSeq<T> = T & { seq?: number };

export type PlayerRealtimeEvent =
  | PlayerRealtimeEventWithSeq<{
      type: "presence_updated";
      accountId: string;
      online: boolean;
      connectionCount: number;
      lastSeenAt?: string;
    }>
  | PlayerRealtimeEventWithSeq<{ type: "friend_request_received"; accountId: string; request: PlayerFriendRequestDto }>
  | PlayerRealtimeEventWithSeq<{ type: "friend_request_resolved"; accountId: string; request: PlayerFriendRequestDto }>
  | PlayerRealtimeEventWithSeq<{ type: "friend_list_refresh"; accountId: string }>
  | PlayerRealtimeEventWithSeq<{ type: "party_updated"; party: PlayerPartyDto | null }>
  | PlayerRealtimeEventWithSeq<{ type: "party_invite_received"; invitation: PlayerPartyInvitationDto }>
  | PlayerRealtimeEventWithSeq<{ type: "party_invite_resolved"; invitation: PlayerPartyInvitationDto }>
  | PlayerRealtimeEventWithSeq<{ type: "queue_updated"; queue: PlayerQueueEntryDto[] }>
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
  | PlayerRealtimeEventWithSeq<{ type: "teams_assigned"; matchId: string; teamA: PlayerMatchTeamDto; teamB: PlayerMatchTeamDto }>
  | PlayerRealtimeEventWithSeq<{ type: "map_randomizing_started"; matchId: string; mapSelection: PlayerMapSelectionStateDto }>
  | PlayerRealtimeEventWithSeq<{ type: "server_preparing"; matchId: string }>
  | PlayerRealtimeEventWithSeq<{ type: "connect_ready"; matchId: string; connect: PlayerConnectDto }>
  | PlayerRealtimeEventWithSeq<{ type: "match_live"; matchId: string }>
  | PlayerRealtimeEventWithSeq<{ type: "match_completed"; matchId: string; result?: MatchSeriesResult }>
  | PlayerRealtimeEventWithSeq<{ type: "match_failed"; matchId: string; error: string }>;
