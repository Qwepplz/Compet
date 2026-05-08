import { useEffect, useRef, useState } from "react";
import { Button, Card, Form, Input, Modal, Spin, message } from "antd";
import type { AccountView } from "../../../manager/shared/types.js";
import type {
  PlayerFriendListDto,
  PlayerLiveMatchStateDto,
  PlayerMatchChatMessageDto,
  PlayerMatchParticipantDto,
  PlayerMatchTeamDto,
  PlayerMatchmakingStateDto,
  PlayerPartyDto,
  PlayerPartyInvitationDto,
  PlayerRealtimeEvent,
  PlayerRealtimeSnapshotDto,
  PlayerRealtimeSnapshotScope,
  PlayerRealtimeStatusDto,
} from "../../shared/types.js";
import {
  hasFriendsApi,
  hasMatchRoomApi,
  hasPartyApi,
  hasRealtimeApi,
  hasSavedLoginApi,
} from "./api/playerApi.js";
import { FriendsPanel } from "./components/FriendsPanel.js";
import { MatchChatPanel } from "./components/MatchChatPanel.js";
import {
  getActiveMatchRoom,
  getDisplayedMatchRoom,
  getVetoDeadlineRefreshDelayMs,
  isTerminalMatchPhase,
} from "./matchRoomState.js";
import { HomePage } from "./pages/HomePage.js";
import { MatchRoomPage } from "./pages/MatchRoomPage.js";
import { playerAccountLabel } from "./playerDisplay.js";
import {
  mergeFriendListSnapshot,
  mergePartyInvitationsSnapshot,
  mergePartySnapshot,
} from "./realtimeStateMerge.js";

const matchFoundSoundUrl = new URL("./assets/sounds/faceit_accept_sound_epic.mp3", import.meta.url).href;

type PlayerView = "login" | "change-password" | "home" | "match-room";

const defaultBaseUrl = "https://127.0.0.1:18443";

type SavedPlayerLogin = { baseUrl: string; username?: string; password?: string };
type LoginValues = { baseUrl: string; username: string; password: string };
type PasswordChangeValues = { currentPassword: string; newPassword: string; confirmPassword: string };
type KnownPlayerProfile = Pick<PlayerMatchParticipantDto, "displayName" | "steamPersonaName" | "steamAvatarUrl">;
const emptyFriends: PlayerFriendListDto = { friends: [], incomingRequests: [], outgoingRequests: [] };
const emptyMatchmaking: PlayerMatchmakingStateDto = { queue: [], rooms: [], party: null, partyInvitations: [], room: null };
const emptyRealtimeStatus: PlayerRealtimeStatusDto = { connection: "disconnected", stale: false };
const VETO_DEADLINE_REFRESH_GRACE_MS = 1_500;
const VETO_DEADLINE_REFRESH_RETRY_MS = 2_000;
const VETO_DEADLINE_REFRESH_MAX_ATTEMPTS = 8;

function getCurrentRoom(matchmaking: PlayerMatchmakingStateDto): PlayerLiveMatchStateDto | null {
  return getDisplayedMatchRoom(matchmaking);
}

function viewFromMatchmaking(matchmaking: PlayerMatchmakingStateDto): PlayerView {
  return getActiveMatchRoom(matchmaking) ? "match-room" : "home";
}

function viewFromSession(account: AccountView, matchmaking: PlayerMatchmakingStateDto): PlayerView {
  if (account.mustChangePassword) return "change-password";
  return viewFromMatchmaking(matchmaking);
}

function upsertRoom(rooms: PlayerLiveMatchStateDto[], nextRoom: PlayerLiveMatchStateDto): PlayerLiveMatchStateDto[] {
  const index = rooms.findIndex((room) => room.id === nextRoom.id);
  if (index === -1) {
    return [...rooms, nextRoom];
  }
  const nextRooms = [...rooms];
  nextRooms[index] = nextRoom;
  return nextRooms;
}

function appendMatchChatMessage(room: PlayerLiveMatchStateDto, chatMessage: PlayerMatchChatMessageDto): PlayerLiveMatchStateDto {
  const currentMessages = room.chat ?? [];
  if (currentMessages.some((message) => message.id === chatMessage.id)) return room;
  return { ...room, chat: [...currentMessages, chatMessage] };
}

function mergeRoomSteamProfileData(previous: PlayerLiveMatchStateDto, next: PlayerLiveMatchStateDto): PlayerLiveMatchStateDto {
  const profileById = new Map<string, Pick<PlayerMatchParticipantDto, "displayName" | "steamPersonaName" | "steamAvatarUrl">>();
  for (const participant of [...(previous.teamA?.participants ?? []), ...(previous.teamB?.participants ?? [])]) {
    if (participant.steamPersonaName || participant.steamAvatarUrl) {
      profileById.set(participant.id, {
        displayName: participant.displayName,
        steamPersonaName: participant.steamPersonaName,
        steamAvatarUrl: participant.steamAvatarUrl,
      });
    }
  }
  if (profileById.size === 0) return next;
  return {
    ...next,
    teamA: next.teamA ? mergeTeamSteamProfileData(next.teamA, profileById) : next.teamA,
    teamB: next.teamB ? mergeTeamSteamProfileData(next.teamB, profileById) : next.teamB,
  };
}

function mergeTeamSteamProfileData(
  team: PlayerMatchTeamDto,
  profileById: Map<string, KnownPlayerProfile>,
): PlayerMatchTeamDto {
  return {
    ...team,
    participants: team.participants.map((participant) => {
      const profile = profileById.get(participant.id);
      return profile ? { ...participant, ...profile } : participant;
    }),
  };
}

function mergeTeamKnownPlayerProfiles(
  team: PlayerMatchTeamDto,
  profileByAccountId: Map<string, KnownPlayerProfile>,
): PlayerMatchTeamDto {
  if (profileByAccountId.size === 0) return team;
  return {
    ...team,
    participants: team.participants.map((participant) => {
      const profile = participant.accountId ? profileByAccountId.get(participant.accountId) : undefined;
      if (!profile) return participant;
      return {
        ...participant,
        displayName: profile.displayName || participant.displayName,
        steamPersonaName: profile.steamPersonaName ?? participant.steamPersonaName,
        steamAvatarUrl: profile.steamAvatarUrl ?? participant.steamAvatarUrl,
      };
    }),
  };
}

export function mergeRoomKnownPlayerProfiles(
  room: PlayerLiveMatchStateDto | null,
  profileByAccountId: Map<string, KnownPlayerProfile>,
): PlayerLiveMatchStateDto | null {
  if (!room || profileByAccountId.size === 0) return room;
  return {
    ...room,
    teamA: mergeTeamKnownPlayerProfiles(room.teamA, profileByAccountId),
    teamB: mergeTeamKnownPlayerProfiles(room.teamB, profileByAccountId),
  };
}

function buildKnownPlayerProfiles(account: AccountView | null, friends: PlayerFriendListDto): Map<string, KnownPlayerProfile> {
  const profiles = new Map<string, KnownPlayerProfile>();
  if (account?.id) {
    profiles.set(account.id, {
      displayName: playerAccountLabel(account),
      steamPersonaName: account.steamPersonaName,
      steamAvatarUrl: account.steamAvatarUrl,
    });
  }
  for (const entry of [...friends.friends, ...friends.incomingRequests, ...friends.outgoingRequests]) {
    profiles.set(entry.accountId, {
      displayName: entry.steamPersonaName ?? entry.displayName,
      steamPersonaName: entry.steamPersonaName,
      steamAvatarUrl: entry.steamAvatarUrl,
    });
  }
  return profiles;
}

export function App() {
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState<PlayerView>("login");
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [friends, setFriends] = useState<PlayerFriendListDto>(emptyFriends);
  const [party, setParty] = useState<PlayerPartyDto | null>(null);
  const [matchmaking, setMatchmaking] = useState<PlayerMatchmakingStateDto>(emptyMatchmaking);
  const [matchmakingFeedbackPending, setMatchmakingFeedbackPending] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState<PlayerRealtimeStatusDto>(emptyRealtimeStatus);
  const [, setStale] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [savedLogin, setSavedLogin] = useState<SavedPlayerLogin | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [changePasswordPending, setChangePasswordPending] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [loginForm] = Form.useForm<LoginValues>();
  const resolvedFriendRequestIds = useRef(new Set<string>());
  const resolvedPartyInvitationIds = useRef(new Set<string>());
  const enteredReadyRoomIds = useRef(new Set<string>());
  const playedMatchSoundRoomIds = useRef(new Set<string>());
  const pendingMatchSoundRoomIds = useRef(new Set<string>());
  const matchFoundAudioRef = useRef<HTMLAudioElement | null>(null);

  const realtimeApi = hasRealtimeApi(window.playerApi) ? window.playerApi : undefined;
  const savedLoginApi = hasSavedLoginApi(window.playerApi) ? window.playerApi : undefined;
  const friendsApi = hasFriendsApi(window.playerApi) ? window.playerApi : undefined;
  const partyApi = hasPartyApi(window.playerApi) ? window.playerApi : undefined;
  const matchRoomApi = hasMatchRoomApi(window.playerApi) ? window.playerApi : undefined;
  const currentRoom = getCurrentRoom(matchmaking);
  const activeMatchRoom = getActiveMatchRoom(matchmaking);
  const knownPlayerProfiles = buildKnownPlayerProfiles(account, friends);
  const currentRoomWithKnownProfiles = mergeRoomKnownPlayerProfiles(currentRoom, knownPlayerProfiles);
  const sidebarMatchRoom = currentRoomWithKnownProfiles && !isTerminalMatchPhase(currentRoomWithKnownProfiles.phase)
    ? currentRoomWithKnownProfiles
    : null;
  const hasActiveMatch = Boolean(activeMatchRoom);
  const accountLabel = playerAccountLabel(account);
  const canUseMatchmaking = Boolean(account?.steam64?.trim());

  useEffect(() => {
    void restoreSession();
  }, []);

  useEffect(() => {
    if (activeMatchRoom) {
      setMatchmakingFeedbackPending(false);
    }
  }, [activeMatchRoom?.id]);

  useEffect(() => {
    const audio = new Audio(matchFoundSoundUrl);
    audio.preload = "auto";
    audio.volume = 1;
    matchFoundAudioRef.current = audio;
    return () => {
      audio.pause();
      matchFoundAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!account || !realtimeApi) return;

    const unsubscribeStatus = realtimeApi.onRealtimeStatus((status) => {
      setRealtimeStatus(status);
      setStale(status.stale);
    });
    const unsubscribeSnapshot = realtimeApi.onRealtimeSnapshot((snapshot) => {
      applyRealtimeSnapshot(snapshot);
    });
    const unsubscribeEvent = realtimeApi.onRealtimeEvent((event) => {
      applyRealtimeEvent(event);
    });

    return () => {
      unsubscribeStatus();
      unsubscribeSnapshot();
      unsubscribeEvent();
    };
  }, [account, realtimeApi]);

  useEffect(() => {
    if (!account || !realtimeApi || !currentRoom) return;
    const initialDelay = getVetoDeadlineRefreshDelayMs(currentRoom, Date.now(), VETO_DEADLINE_REFRESH_GRACE_MS);
    if (initialDelay === null) return;

    let cancelled = false;
    let attempts = 0;
    let retryTimer: number | undefined;

    const refreshExpiredVeto = () => {
      if (cancelled) return;
      attempts += 1;
      void hydrateRealtimeState("matchmaking").finally(() => {
        if (!cancelled && attempts < VETO_DEADLINE_REFRESH_MAX_ATTEMPTS) {
          retryTimer = window.setTimeout(refreshExpiredVeto, VETO_DEADLINE_REFRESH_RETRY_MS);
        }
      });
    };

    const initialTimer = window.setTimeout(refreshExpiredVeto, initialDelay);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [
    account,
    currentRoom?.id,
    currentRoom?.phase,
    currentRoom?.veto?.current?.deadlineAt,
    currentRoom?.veto?.history.length,
    currentRoom?.veto?.finalMap,
    realtimeApi,
  ]);

  useEffect(() => {
    if (!matchRoomApi || activeView !== "match-room" || !account?.id || !currentRoom || currentRoom.phase !== "ready") return;
    if (!currentRoom.humanAccountIds?.includes(account.id)) return;

    const entryKey = `${currentRoom.id}:${account.id}`;
    if (enteredReadyRoomIds.current.has(entryKey)) return;

    let cancelled = false;
    let retryTimer: number | undefined;
    const markReadyRoomEntered = async (attempt = 0) => {
      enteredReadyRoomIds.current.add(entryKey);
      try {
        const nextRoom = await matchRoomApi.ackMatchRoomEntered(currentRoom.id);
        if (!cancelled) {
          updateCurrentRoom(nextRoom.id, () => nextRoom);
        }
      } catch {
        if (cancelled) return;
        enteredReadyRoomIds.current.delete(entryKey);
        if (attempt < 2) {
          retryTimer = window.setTimeout(() => void markReadyRoomEntered(attempt + 1), 1500);
        }
      }
    };

    const enterTimer = window.setTimeout(() => void markReadyRoomEntered(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(enterTimer);
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [account?.id, activeView, currentRoom?.id, currentRoom?.phase, matchRoomApi]);

  async function hydrateRealtimeState(scope: PlayerRealtimeSnapshotScope = "full") {
    if (!realtimeApi) return;
    try {
      const snapshot = await realtimeApi.refreshRealtimeSnapshot(scope);
      applyRealtimeSnapshot(snapshot);
    } catch {
      // 保持恢复后的基础状态，不把实时快照失败当成登录失败。
    }
  }

  function applyRealtimeSnapshot(snapshot: PlayerRealtimeSnapshotDto) {
    const hasPartySnapshot = snapshot.party !== undefined;
    if (snapshot.friends) {
      setFriends((current) => mergeFriendListSnapshot(current, snapshot.friends!, resolvedFriendRequestIds.current));
    }
    if (hasPartySnapshot) {
      setParty((current) => mergePartySnapshot(current, snapshot.party ?? null));
    }
    setStale(false);
    setRealtimeStatus({ connection: "connected", stale: false });
    setMatchmaking((current) => {
      const nextRoom = getDisplayedMatchRoom(snapshot.matchmaking);
      const nextParty = hasPartySnapshot ? mergePartySnapshot(current.party, snapshot.party ?? null) : current.party;
      return {
        queue: snapshot.matchmaking.queue,
        rooms: snapshot.matchmaking.rooms,
        party: nextParty,
        partyInvitations: mergePartyInvitationsSnapshot(
          current.partyInvitations,
          snapshot.matchmaking.partyInvitations ?? [],
          resolvedPartyInvitationIds.current,
        ),
        room: nextRoom,
      };
    });
    if (getActiveMatchRoom(snapshot.matchmaking)) {
      setActiveView((current) => (current === "home" ? "match-room" : current));
    }
  }

  function primeMatchFoundSound() {
    try {
      const audio = matchFoundAudioRef.current ?? new Audio(matchFoundSoundUrl);
      matchFoundAudioRef.current = audio;
      audio.preload = "auto";
      audio.volume = 1;
      audio.load();
      const muted = audio.muted;
      audio.muted = true;
      void audio.play()
        .then(() => {
          audio.pause();
          audio.currentTime = 0;
        })
        .finally(() => {
          audio.muted = muted;
        });
    } catch {
      // Notification sound is best-effort and must not block matchmaking.
    }
  }

  function playMatchFoundSound(matchId: string) {
    if (playedMatchSoundRoomIds.current.has(matchId) || pendingMatchSoundRoomIds.current.has(matchId)) return;
    pendingMatchSoundRoomIds.current.add(matchId);
    try {
      const audio = matchFoundAudioRef.current ?? new Audio(matchFoundSoundUrl);
      matchFoundAudioRef.current = audio;
      audio.pause();
      audio.currentTime = 0;
      audio.muted = false;
      audio.volume = 1;
      void audio.play()
        .then(() => {
          playedMatchSoundRoomIds.current.add(matchId);
        })
        .catch(() => undefined)
        .finally(() => {
          pendingMatchSoundRoomIds.current.delete(matchId);
        });
    } catch {
      pendingMatchSoundRoomIds.current.delete(matchId);
      // Notification sound is best-effort and must not block match state updates.
    }
  }

  function updateCurrentRoom(
    matchId: string,
    updater: (room: PlayerLiveMatchStateDto) => PlayerLiveMatchStateDto,
    options: { activate?: boolean } = {},
  ) {
    setMatchmaking((current) => {
      const sourceRoom = current.room?.id === matchId ? current.room : current.rooms.find((room) => room.id === matchId);
      if (!sourceRoom) return current;
      const nextRoom = mergeRoomSteamProfileData(sourceRoom, updater(sourceRoom));
      if (isTerminalMatchPhase(sourceRoom.phase) && !isTerminalMatchPhase(nextRoom.phase)) {
        return current;
      }
      const baseRooms = current.rooms.length > 0 ? current.rooms : current.room ? [current.room] : [];
      const nextRooms = baseRooms.some((room) => room.id === matchId)
        ? baseRooms.map((room) => (room.id === matchId ? nextRoom : room))
        : [...baseRooms, nextRoom];
      const nextCurrentRoom = current.room?.id === matchId || !current.room ? nextRoom : current.room;
      return {
        ...current,
        room: nextCurrentRoom,
        rooms: nextRooms,
      };
    });
    if (options.activate ?? true) {
      setActiveView((current) => (current === "home" ? "match-room" : current));
    }
  }

  function applyRealtimeEvent(event: PlayerRealtimeEvent) {
    switch (event.type) {
      case "presence_updated":
        setFriends((current) => applyPresenceUpdate(current, event.accountId, event.online, event.lastSeenAt));
        return;
      case "friend_request_received":
        resolvedFriendRequestIds.current.delete(event.request.id);
        setFriends((current) => {
          const nextIncoming = event.request.toAccountId === account?.id
            ? upsertIncomingRequest(current.incomingRequests, event.request)
            : current.incomingRequests;
          const nextOutgoing = event.request.fromAccountId === account?.id
            ? upsertOutgoingRequest(current.outgoingRequests, event.request)
            : current.outgoingRequests;
          return {
            ...current,
            incomingRequests: nextIncoming,
            outgoingRequests: nextOutgoing,
          };
        });
        if (event.request.toAccountId === account?.id) {
          void message.info({
            key: `friend-request-${event.request.id}`,
            content: `收到来自 ${event.request.displayName} 的好友请求`,
          });
        }
        return;
      case "friend_request_resolved":
        resolvedFriendRequestIds.current.add(event.request.id);
        setFriends((current) => ({
          ...current,
          incomingRequests: current.incomingRequests.filter((request) => request.id !== event.request.id),
          outgoingRequests: current.outgoingRequests.filter((request) => request.id !== event.request.id),
        }));
        return;
      case "friend_list_refresh":
        if (event.accountId === account?.id) {
          void refreshFriendsList();
        }
        return;
      case "party_updated":
        setParty((current) => (event.party ? mergePartySnapshot(current, event.party) : null));
        setMatchmaking((current) => ({
          ...current,
          party: event.party ? mergePartySnapshot(current.party, event.party) : null,
        }));
        return;
      case "party_invite_received":
        if (event.invitation.toAccountId === account?.id) {
          resolvedPartyInvitationIds.current.delete(event.invitation.id);
          setMatchmaking((current) => ({
            ...current,
            partyInvitations: upsertPartyInvitation(current.partyInvitations, event.invitation),
          }));
          void message.info({
            key: `party-invite-${event.invitation.id}`,
            content: "收到队伍邀请",
          });
        }
        return;
      case "party_invite_resolved":
        resolvedPartyInvitationIds.current.add(event.invitation.id);
        setMatchmaking((current) => ({
          ...current,
          partyInvitations: removePartyInvitation(current.partyInvitations, event.invitation.id),
        }));
        return;
      case "queue_updated":
        setMatchmaking((current) => ({
          ...current,
          queue: event.queue,
        }));
        return;
      case "ready_check_started":
      case "ready_check_updated":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "ready",
          readyDeadlineAt: event.deadlineAt,
          ready: event.ready,
          humanAccountIds: event.humanParticipants.flatMap((participant) => (participant.accountId ? [participant.accountId] : [])),
        }));
        return;
      case "match_room_created":
        playMatchFoundSound(event.matchId);
        setMatchmaking((current) => {
          const nextRooms = upsertRoom(current.rooms, event.room);
          const nextCurrentRoom = current.room?.id === event.matchId || !current.room ? event.room : current.room;
          return {
            ...current,
            room: nextCurrentRoom,
            rooms: nextRooms,
          };
        });
        setActiveView((current) => (current === "home" ? "match-room" : current));
        return;
      case "teams_assigned":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "match_room",
          teamA: event.teamA,
          teamB: event.teamB,
        }));
        return;
      case "veto_started":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "map_banpick",
          veto: event.veto,
        }));
        return;
      case "veto_tick":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "map_banpick",
          veto: room.veto
            ? {
                ...room.veto,
                current: room.veto.current
                  ? {
                      ...room.veto.current,
                      deadlineAt: event.deadlineAt,
                    }
                  : room.veto.current,
              }
            : room.veto,
        }));
        return;
      case "map_banned":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "map_banpick",
          veto: event.veto ?? (room.veto
            ? {
                ...room.veto,
                history: room.veto.history.some((entry) => entry.at === event.entry.at && entry.map === event.entry.map && entry.action === event.entry.action)
                  ? room.veto.history
                  : [...room.veto.history, event.entry],
                availableMaps: room.veto.availableMaps.filter((map) => map !== event.entry.map),
              }
            : room.veto),
        }));
        return;
      case "map_picked":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "map_banpick",
          veto: event.veto ?? (room.veto
            ? {
                ...room.veto,
                history: room.veto.history.some((entry) => entry.at === event.entry.at && entry.map === event.entry.map && entry.action === event.entry.action)
                  ? room.veto.history
                  : [...room.veto.history, event.entry],
                availableMaps: room.veto.availableMaps.filter((map) => map !== event.entry.map),
                finalMap: event.entry.map,
              }
            : room.veto),
        }));
        return;
      case "match_chat_message":
        updateCurrentRoom(event.matchId, (room) => appendMatchChatMessage(room, event.message), { activate: false });
        return;
      case "server_preparing":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "server_prepare",
        }));
        return;
      case "connect_ready":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "connect",
          connect: event.connect,
        }));
        return;
      case "match_live":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "live",
        }));
        return;
      case "match_completed":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "completed",
        }), { activate: false });
        void message.success("游戏服务器已关闭，本场比赛已结束");
        setActiveView("home");
        return;
      case "match_failed":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "failed",
        }), { activate: false });
        void message.error(event.error ? `比赛已结束：${event.error}` : "比赛已结束，服务器已关闭");
        setActiveView("home");
        return;
    }
  }

  function upsertIncomingRequest(currentRequests: PlayerFriendListDto["incomingRequests"], request: PlayerFriendListDto["incomingRequests"][number]) {
    const nextRequests = currentRequests.filter((item) => item.id !== request.id);
    nextRequests.unshift(request);
    return nextRequests;
  }

  function upsertOutgoingRequest(currentRequests: PlayerFriendListDto["outgoingRequests"], request: PlayerFriendListDto["outgoingRequests"][number]) {
    const nextRequests = currentRequests.filter((item) => item.id !== request.id);
    nextRequests.unshift(request);
    return nextRequests;
  }

  function upsertPartyInvitation(currentInvitations: PlayerPartyInvitationDto[], invitation: PlayerPartyInvitationDto) {
    const nextInvitations = currentInvitations.filter((item) => item.id !== invitation.id);
    nextInvitations.unshift(invitation);
    return nextInvitations;
  }

  function removePartyInvitation(currentInvitations: PlayerPartyInvitationDto[], invitationId: string) {
    return currentInvitations.filter((invitation) => invitation.id !== invitationId);
  }

  function applyPresenceUpdate(currentFriends: PlayerFriendListDto, accountId: string, online: boolean, lastSeenAt?: string): PlayerFriendListDto {
    const applyEntry = <T extends { accountId?: string; fromAccountId?: string; toAccountId?: string; online?: boolean; lastSeenAt?: string }>(
      entry: T,
      targetAccountId: string,
    ): T => {
      const matchesAccount = entry.accountId === targetAccountId || entry.fromAccountId === targetAccountId || entry.toAccountId === targetAccountId;
      if (!matchesAccount) {
        return entry;
      }
      return {
        ...entry,
        online,
        lastSeenAt: online ? undefined : lastSeenAt ?? entry.lastSeenAt,
      };
    };

    return {
      friends: currentFriends.friends.map((friend) => applyEntry(friend, accountId)),
      incomingRequests: currentFriends.incomingRequests.map((request) => applyEntry(request, accountId)),
      outgoingRequests: currentFriends.outgoingRequests.map((request) => applyEntry(request, accountId)),
    };
  }

  async function refreshFriendsList() {
    if (!friendsApi || !account) return;
    try {
      const nextFriends = await friendsApi.listFriends();
      setFriends((current) => mergeFriendListSnapshot(current, nextFriends, resolvedFriendRequestIds.current));
    } catch {
      // 刷新失败时保留当前列表，等待下一次快照或事件。
    }
  }

  async function restoreSession() {
    try {
      const restored = await window.playerApi.restoreSession();
      if (!restored) {
        await loadSavedLogin();
        setActiveView("login");
        return;
      }
      setBaseUrl(restored.baseUrl);
      resolvedFriendRequestIds.current.clear();
      resolvedPartyInvitationIds.current.clear();
      enteredReadyRoomIds.current.clear();
      setAccount(restored.account);
      setFriends(emptyFriends);
      setParty(restored.matchmaking.party ?? null);
      setMatchmaking(restored.matchmaking);
      setRealtimeStatus(emptyRealtimeStatus);
      setStale(false);
      setActiveView(viewFromSession(restored.account, restored.matchmaking));
      await hydrateRealtimeState();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "恢复会话失败");
      await loadSavedLogin();
      setActiveView("login");
    } finally {
      setLoading(false);
    }
  }

  async function loadSavedLogin() {
    if (!savedLoginApi) return;
    const saved = await savedLoginApi.loadSavedLogin();
    setSavedLogin(saved);
    if (saved?.baseUrl) {
      setBaseUrl(saved.baseUrl);
    }
    if (saved?.password) {
      setCurrentPassword(saved.password);
    }
    if (saved) {
      loginForm.setFieldsValue(saved);
    }
  }

  async function login(values: LoginValues) {
    if (loginPending) return;
    setLoginPending(true);
    try {
      setBaseUrl(values.baseUrl);
      setCurrentPassword(values.password);
      setSavedLogin({ baseUrl: values.baseUrl, username: values.username, password: values.password });
      const loginResult = await window.playerApi.login(values.baseUrl, values.username, values.password);
      if (loginResult.account.mustChangePassword) {
        setAccount(loginResult.account);
        resolvedFriendRequestIds.current.clear();
        resolvedPartyInvitationIds.current.clear();
        enteredReadyRoomIds.current.clear();
        setFriends(emptyFriends);
        setParty(null);
        setMatchmaking(emptyMatchmaking);
        setRealtimeStatus(emptyRealtimeStatus);
        setStale(false);
        setActiveView("change-password");
        return;
      }
      const restored = await window.playerApi.restoreSession();
      if (!restored) {
        setActiveView("login");
        return;
      }
      setAccount(restored.account);
      resolvedFriendRequestIds.current.clear();
      resolvedPartyInvitationIds.current.clear();
      enteredReadyRoomIds.current.clear();
      setFriends(emptyFriends);
      setParty(restored.matchmaking.party ?? null);
      setMatchmaking(restored.matchmaking);
      setRealtimeStatus(emptyRealtimeStatus);
      setStale(false);
      setActiveView(viewFromSession(restored.account, restored.matchmaking));
      await hydrateRealtimeState();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoginPending(false);
    }
  }

  async function changePassword(values: PasswordChangeValues, options: { refreshSession: boolean } = { refreshSession: true }) {
    if (changePasswordPending) return;
    if (values.newPassword !== values.confirmPassword) {
      message.error("两次输入的新密码不一致");
      return;
    }
    setChangePasswordPending(true);
    try {
      await window.playerApi.changePassword(values.currentPassword, values.newPassword);
      setCurrentPassword(values.newPassword);
      setSavedLogin((current) => current ? { ...current, password: values.newPassword } : current);
      if (options.refreshSession) {
        const restored = await window.playerApi.restoreSession();
        if (!restored) {
          setActiveView("login");
          return;
        }
        setAccount(restored.account);
        resolvedFriendRequestIds.current.clear();
        resolvedPartyInvitationIds.current.clear();
        enteredReadyRoomIds.current.clear();
        setFriends(emptyFriends);
        setParty(restored.matchmaking.party ?? null);
        setMatchmaking(restored.matchmaking);
        setRealtimeStatus(emptyRealtimeStatus);
        setStale(false);
        setActiveView(viewFromSession(restored.account, restored.matchmaking));
        await hydrateRealtimeState();
      } else {
        setPasswordModalOpen(false);
      }
      message.success("密码已更新");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "修改密码失败");
    } finally {
      setChangePasswordPending(false);
    }
  }

  async function logout() {
    try {
      await window.playerApi.logout();
    } finally {
      setAccount(null);
      resolvedFriendRequestIds.current.clear();
      resolvedPartyInvitationIds.current.clear();
      enteredReadyRoomIds.current.clear();
      setFriends(emptyFriends);
      setParty(null);
      setMatchmaking(emptyMatchmaking);
      setRealtimeStatus(emptyRealtimeStatus);
      setStale(false);
      setCurrentPassword("");
      setActiveView("login");
    }
  }

  async function searchFriends(query: string) {
    if (!friendsApi) return [];
    return friendsApi.searchFriends(query);
  }

  async function sendFriendRequest(accountId: string) {
    if (!friendsApi) return;
    const request = await friendsApi.sendFriendRequest(accountId);
    setFriends((current) => ({
      ...current,
      outgoingRequests: upsertOutgoingRequest(current.outgoingRequests, request),
    }));
  }

  async function acceptFriendRequest(requestId: string) {
    if (!friendsApi) return;
    try {
      const nextFriends = await friendsApi.acceptFriendRequest(requestId);
      resolvedFriendRequestIds.current.add(requestId);
      setFriends(nextFriends);
      void message.success("已接受好友请求");
      void refreshFriendsList();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "接受好友请求失败");
    }
  }

  async function declineFriendRequest(requestId: string) {
    if (!friendsApi) return;
    await friendsApi.declineFriendRequest(requestId);
    resolvedFriendRequestIds.current.add(requestId);
    setFriends((current) => ({
      ...current,
      incomingRequests: current.incomingRequests.filter((request) => request.id !== requestId),
    }));
  }

  async function createParty() {
    if (!partyApi) return;
    const nextParty = await partyApi.createParty();
    setParty(nextParty);
    setMatchmaking((current) => ({
      ...current,
      party: nextParty,
    }));
  }

  async function inviteToParty(accountId: string) {
    if (!partyApi || hasActiveMatch) return;
    const targetAccountId = accountId.trim();
    if (!targetAccountId) return;
    if (!party) {
      await createParty();
    }
    await partyApi.inviteToParty(targetAccountId);
  }

  async function acceptPartyInvite(invitationId: string) {
    if (!partyApi) return;
    const nextParty = await partyApi.acceptPartyInvite(invitationId);
    resolvedPartyInvitationIds.current.add(invitationId);
    setParty(nextParty);
    setMatchmaking((current) => ({
      ...current,
      party: nextParty,
      partyInvitations: removePartyInvitation(current.partyInvitations, invitationId),
    }));
  }

  async function declinePartyInvite(invitationId: string) {
    if (!partyApi) return;
    await partyApi.declinePartyInvite(invitationId);
    resolvedPartyInvitationIds.current.add(invitationId);
    setMatchmaking((current) => ({
      ...current,
      partyInvitations: removePartyInvitation(current.partyInvitations, invitationId),
    }));
  }

  async function leaveParty() {
    if (!partyApi || !party || hasActiveMatch) return;
    try {
      await partyApi.leaveParty();
      setParty(null);
      setMatchmaking((current) => ({
        ...current,
        party: null,
      }));
      void message.success("已退出队伍");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "退出队伍失败");
    }
  }

  async function startPartyMatchmaking() {
    if (!partyApi) return;
    const nextRoom = await partyApi.startPartyMatchmaking();
    setMatchmaking((current) => ({
      ...current,
      room: nextRoom,
      rooms: upsertRoom(current.rooms, nextRoom),
    }));
    playMatchFoundSound(nextRoom.id);
    setActiveView("match-room");
    setMatchmakingFeedbackPending(false);
  }

  async function startMatchmakingFromHome() {
    if (!partyApi || !canUseMatchmaking || hasActiveMatch || matchmakingFeedbackPending) return;
    if (party && party.ownerAccountId !== account?.id) return;
    primeMatchFoundSound();
    setMatchmakingFeedbackPending(true);
    try {
      if (!party) {
        await createParty();
      }
      await startPartyMatchmaking();
    } catch (error) {
      setMatchmakingFeedbackPending(false);
      message.error(error instanceof Error ? error.message : "开始匹配失败");
    }
  }

  async function acceptReady() {
    if (!matchRoomApi || !currentRoom) return;
    const nextRoom = await matchRoomApi.acceptReady();
    updateCurrentRoom(nextRoom.id, () => nextRoom);
  }

  async function declineReady() {
    if (!matchRoomApi || !currentRoom) return;
    const nextRoom = await matchRoomApi.declineReady();
    updateCurrentRoom(nextRoom.id, () => nextRoom);
  }

  async function applyVeto(roomId: string, action: "ban" | "pick", map: string) {
    if (!matchRoomApi) return;
    const nextRoom = await matchRoomApi.applyVeto(roomId, action, map);
    updateCurrentRoom(nextRoom.id, () => nextRoom);
  }

  async function sendMatchChatMessage(roomId: string, text: string) {
    if (!matchRoomApi) return;
    const chatMessage = await matchRoomApi.sendMatchChatMessage(roomId, text);
    updateCurrentRoom(roomId, (room) => appendMatchChatMessage(room, chatMessage), { activate: false });
  }

  async function copyText(text: string) {
    if (!matchRoomApi) return;
    await matchRoomApi.copyText(text);
    message.success("已复制");
  }

  function renderAuthenticatedView() {
    if (activeView === "match-room") {
      return (
        <MatchRoomPage
          account={account}
          room={currentRoomWithKnownProfiles}
          onAcceptReady={() => acceptReady()}
          onDeclineReady={() => declineReady()}
          onApplyVeto={(roomId, action, map) => applyVeto(roomId, action, map)}
          onCopyText={(text) => copyText(text)}
        />
      );
    }
    return (
      <HomePage
        account={account}
        baseUrl={baseUrl}
        friends={friends}
        party={party}
        partyInvitations={matchmaking.partyInvitations}
        queueSize={matchmaking.queue.length}
        roomCount={matchmaking.rooms.length}
        matchmakingPending={matchmakingFeedbackPending}
        onInviteFriend={partyApi && !hasActiveMatch ? inviteToParty : undefined}
        onAcceptPartyInvite={partyApi ? acceptPartyInvite : undefined}
        onDeclinePartyInvite={partyApi ? declinePartyInvite : undefined}
        onLeaveParty={partyApi && party && !hasActiveMatch ? leaveParty : undefined}
        onStartMatchmaking={
          partyApi && canUseMatchmaking && !hasActiveMatch && (!party || party.ownerAccountId === account?.id)
            ? startMatchmakingFromHome
            : undefined
        }
      />
    );
  }

  if (loading) {
    return (
      <div className="player-shell">
        <Card className="player-card">
          <div className="player-loading">
            <Spin size="large" />
            <span>正在恢复本地会话...</span>
          </div>
        </Card>
      </div>
    );
  }

  if (activeView === "login") {
    return (
      <div className="player-shell">
        <Card className="player-card">
          <div className="player-header">
            <div className="player-kicker">Compet Player</div>
            <h2 className="player-title">玩家登录</h2>
            <p className="player-copy">使用 Compet 账号登录，恢复当前玩家状态并继续比赛流程。</p>
          </div>
          <Form
            form={loginForm}
            layout="vertical"
            initialValues={{
              baseUrl: savedLogin?.baseUrl ?? baseUrl,
              username: savedLogin?.username,
              password: savedLogin?.password,
            }}
            onFinish={(values) => void login(values)}
          >
            <Form.Item label="服务器地址" name="baseUrl" rules={[{ required: true, message: "请输入服务器地址" }]}>
              <Input onChange={(event) => setBaseUrl(event.target.value)} />
            </Form.Item>
            <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
              <Input />
            </Form.Item>
            <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
              <Input.Password />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loginPending} disabled={loginPending}>
              登录
            </Button>
          </Form>
        </Card>
      </div>
    );
  }

  if (activeView === "change-password") {
    return (
      <div className="player-shell">
        <Card className="player-card">
          <div className="player-header">
            <div className="player-kicker">Security</div>
            <h2 className="player-title">修改初始密码</h2>
            <p className="player-copy">当前账号必须先修改密码，完成后再进入玩家主页。</p>
          </div>
          <Form
            layout="vertical"
            initialValues={{ currentPassword }}
            onFinish={(values) => void changePassword(values)}
          >
            <Form.Item label="当前密码" name="currentPassword" rules={[{ required: true, message: "请输入当前密码" }]}>
              <Input.Password />
            </Form.Item>
            <Form.Item label="新密码" name="newPassword" rules={[{ required: true, message: "请输入新密码" }]}>
              <Input.Password />
            </Form.Item>
            <Form.Item
              dependencies={["newPassword"]}
              label="确认新密码"
              name="confirmPassword"
              rules={[
                { required: true, message: "请再次输入新密码" },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue("newPassword") === value) return Promise.resolve();
                    return Promise.reject(new Error("两次输入的新密码不一致"));
                  },
                }),
              ]}
            >
              <Input.Password />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={changePasswordPending}
              disabled={changePasswordPending}
            >
              保存并进入
            </Button>
          </Form>
        </Card>
      </div>
    );
  }

  return (
    <div className="player-shell player-shell--app">
      <div className="player-app-frame">
        <div className="player-app-topbar">
          <div className="player-app-brand">
            <div className="player-kicker">Compet Player</div>
            <strong>{accountLabel}</strong>
          </div>

          <div className="player-app-nav">
            <Button aria-label="主页" type={activeView === "home" ? "primary" : "default"} onClick={() => setActiveView("home")}>
              主页
            </Button>
            {currentRoom ? (
              <Button aria-label="比赛房间" type={activeView === "match-room" ? "primary" : "default"} onClick={() => setActiveView("match-room")}>
                比赛房间
              </Button>
            ) : null}
          </div>

          <div className="player-app-meta">
            <span aria-label="当前服务器地址" className="player-status-pill player-status-pill--server">
              {baseUrl}
            </span>
            <span className={`player-status-pill player-status-pill--${realtimeStatus.connection}`}>{realtimeStatus.connection}</span>
            <Button onClick={() => setPasswordModalOpen(true)}>修改密码</Button>
            <Button onClick={() => void logout()}>退出登录</Button>
          </div>
        </div>

        <div className="player-app-layout">
          <main className="player-app-main">{renderAuthenticatedView()}</main>
          <aside className="player-app-sidebar">
            {sidebarMatchRoom ? (
              <MatchChatPanel
                accountId={account?.id ?? ""}
                room={sidebarMatchRoom}
                onSendMessage={matchRoomApi ? (text) => sendMatchChatMessage(sidebarMatchRoom.id, text) : undefined}
              />
            ) : (
              <FriendsPanel
                accountId={account?.id ?? ""}
                friends={friends}
                onSearchFriends={friendsApi ? searchFriends : undefined}
                onSendFriendRequest={friendsApi ? sendFriendRequest : undefined}
                onAcceptFriendRequest={friendsApi ? acceptFriendRequest : undefined}
                onDeclineFriendRequest={friendsApi ? declineFriendRequest : undefined}
              />
            )}
          </aside>
        </div>
        <Modal
          centered
          footer={null}
          open={passwordModalOpen}
          title="修改密码"
          onCancel={() => setPasswordModalOpen(false)}
        >
          <Form
            layout="vertical"
            initialValues={{ currentPassword }}
            onFinish={(values) => void changePassword(values, { refreshSession: false })}
          >
            <Form.Item label="当前密码" name="currentPassword" rules={[{ required: true, message: "请输入当前密码" }]}>
              <Input.Password />
            </Form.Item>
            <Form.Item label="新密码" name="newPassword" rules={[{ required: true, message: "请输入新密码" }]}>
              <Input.Password />
            </Form.Item>
            <Form.Item
              dependencies={["newPassword"]}
              label="确认新密码"
              name="confirmPassword"
              rules={[
                { required: true, message: "请再次输入新密码" },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue("newPassword") === value) return Promise.resolve();
                    return Promise.reject(new Error("两次输入的新密码不一致"));
                  },
                }),
              ]}
            >
              <Input.Password />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={changePasswordPending} disabled={changePasswordPending}>
              保存新密码
            </Button>
          </Form>
        </Modal>
      </div>
    </div>
  );
}
