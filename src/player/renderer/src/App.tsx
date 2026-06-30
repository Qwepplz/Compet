import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Alert, Button, Card, Form, Input, Modal, Spin, Switch, Tabs, message } from "antd";
import { CloseOutlined, MinusOutlined, SettingOutlined } from "@ant-design/icons";
import type { AccountView } from "../../../manager/shared/types.js";
import type { UpdateCheckResult } from "../../../desktop/updateTypes.js";
import type {
  PlayerFriendListDto,
  PlayerLiveMatchStateDto,
  PlayerMatchResultDto,
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
import { FriendsPanel } from "./components/FriendsPanel.js";
import { SteamAvatar } from "./components/SteamAvatar.js";
import {
  getActiveMatchRoom,
  getDisplayedMatchRoom,
  isAccountInReadyRoom,
  isTerminalMatchPhase,
  mergeReadyRoomProgress,
  mergeTeamsAssignedRoom,
} from "./matchRoomState.js";
import { HomePage } from "./pages/HomePage.js";
import { MatchRoomPage } from "./pages/MatchRoomPage.js";
import { MatchResultPage } from "./pages/MatchResultPage.js";
import {
  loadDevModeEnabled,
  loadMatchSoundEnabled,
  saveDevModeEnabled,
  saveMatchSoundEnabled,
} from "./playerPreferences.js";
import { randomMatchmakingDelayMs } from "./matchTimers.js";
import { playerAccountLabel } from "./playerDisplay.js";
import { preloadMapImages } from "./mapAssets.js";
import {
  mergeFriendListSnapshot,
  mergePartyInvitationsSnapshot,
  mergePartySnapshot,
} from "./realtimeStateMerge.js";

const matchFoundSoundUrl = new URL("./assets/sounds/faceit_accept_sound_epic.mp3", import.meta.url).href;

type PlayerView = "login" | "change-password" | "home" | "match-room" | "match-result";

const defaultBaseUrl = "https://127.0.0.1:18443";

type SavedPlayerLogin = { baseUrl: string; username?: string; password?: string };
type LoginValues = { baseUrl: string; username: string; password: string };
type PasswordChangeValues = { currentPassword: string; newPassword: string; confirmPassword: string };
type KnownPlayerProfile = Pick<PlayerMatchParticipantDto, "displayName" | "steamPersonaName" | "steamAvatarUrl">;
const emptyFriends: PlayerFriendListDto = { friends: [], incomingRequests: [], outgoingRequests: [] };
const emptyMatchmaking: PlayerMatchmakingStateDto = { queue: [], rooms: [], party: null, partyInvitations: [], room: null };
const emptyRealtimeStatus: PlayerRealtimeStatusDto = { connection: "disconnected", stale: false };
const PARTY_INVITE_TIMEOUT_MS = 30_000;
const READY_ROOM_SNAPSHOT_REFRESH_MS = 1_500;
let startupUpdateCheckStarted = false;

function waitForMatchmakingDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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
      if (participant.identityMasked) return participant;
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
      if (participant.identityMasked) return participant;
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

function partyMemberDisplayName(accountId: string, account: AccountView | null, friends: PlayerFriendListDto): string {
  if (accountId === account?.id) return playerAccountLabel(account);
  const friend = friends.friends.find((entry) => entry.accountId === accountId);
  return friend?.steamPersonaName ?? friend?.displayName ?? "玩家";
}

function partyInviteAccountDisplay(
  accountId: string,
  account: AccountView | null,
  friends: PlayerFriendListDto,
): { label: string; avatarUrl?: string } {
  if (accountId === account?.id) return { label: playerAccountLabel(account), avatarUrl: account.steamAvatarUrl };
  const friend = friends.friends.find((entry) => entry.accountId === accountId);
  return { label: friend?.steamPersonaName ?? friend?.displayName ?? "玩家", avatarUrl: friend?.steamAvatarUrl };
}

function partyInviteRemainingMs(invitation: PlayerPartyInvitationDto, nowMs = Date.now()): number {
  const createdAt = Date.parse(invitation.createdAt);
  if (!Number.isFinite(createdAt)) return PARTY_INVITE_TIMEOUT_MS;
  return Math.max(0, createdAt + PARTY_INVITE_TIMEOUT_MS - nowMs);
}

function notifyPartyMembershipChange(
  previous: PlayerPartyDto | null,
  next: PlayerPartyDto | null,
  currentAccountId: string | undefined,
  account: AccountView | null,
  friends: PlayerFriendListDto,
  suppressedJoinedAccountIds?: Set<string>,
): void {
  if (!previous || !currentAccountId || previous.id !== next?.id) return;
  const previousMembers = previous.memberAccountIds;
  const nextMembers = next.memberAccountIds;
  if (previousMembers.length < 2 && nextMembers.length < 2) return;

  for (const joinedAccountId of nextMembers.filter((memberId) => !previousMembers.includes(memberId) && memberId !== currentAccountId)) {
    if (suppressedJoinedAccountIds?.delete(joinedAccountId)) continue;
    void message.info(`${partyMemberDisplayName(joinedAccountId, account, friends)} 已加入队伍`);
  }
  for (const leftAccountId of previousMembers.filter((memberId) => !nextMembers.includes(memberId) && memberId !== currentAccountId)) {
    void message.info(`${partyMemberDisplayName(leftAccountId, account, friends)} 已退出队伍`);
  }
}

interface PartyInviteToastsProps {
  invitations: PlayerPartyInvitationDto[];
  account: AccountView | null;
  friends: PlayerFriendListDto;
  busyInvitationId: string | null;
  onAccept: (invitationId: string) => Promise<void>;
  onDecline: (invitationId: string) => Promise<void>;
  onIgnore: (invitationId: string) => Promise<void>;
}

function PartyInviteToasts({
  invitations,
  account,
  friends,
  busyInvitationId,
  onAccept,
  onDecline,
  onIgnore,
}: PartyInviteToastsProps) {
  if (invitations.length === 0) return null;

  return (
    <div className="player-party-invite-toasts" aria-live="polite">
      {invitations.map((invitation) => {
        const inviter = partyInviteAccountDisplay(invitation.fromAccountId, account, friends);
        const progressStyle = {
          "--party-invite-timeout-ms": `${partyInviteRemainingMs(invitation)}ms`,
        } as CSSProperties;
        const busy = busyInvitationId === invitation.id;
        return (
          <div className="player-party-invite-toast" key={invitation.id}>
            <div className="player-party-invite-progress" style={progressStyle} />
            <div className="player-party-invite-body">
              <SteamAvatar className="player-party-invite-avatar" avatarUrl={inviter.avatarUrl} label={inviter.label} />
              <div className="player-party-invite-copy">
                <strong>{inviter.label}</strong>
                <span>邀请你加入队伍</span>
              </div>
              <div className="player-party-invite-actions">
                <Button autoInsertSpace={false} size="small" type="primary" loading={busy} disabled={busy} onClick={() => void onAccept(invitation.id)}>接受</Button>
                <Button autoInsertSpace={false} size="small" loading={busy} disabled={busy} onClick={() => void onDecline(invitation.id)}>拒绝</Button>
                <Button autoInsertSpace={false} size="small" disabled={busy} onClick={() => void onIgnore(invitation.id)}>忽略</Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function App() {
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState<PlayerView>("login");
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [friends, setFriends] = useState<PlayerFriendListDto>(emptyFriends);
  const [party, setParty] = useState<PlayerPartyDto | null>(null);
  const [matchmaking, setMatchmaking] = useState<PlayerMatchmakingStateDto>(emptyMatchmaking);
  const [matchResult, setMatchResult] = useState<PlayerMatchResultDto | null>(null);
  const [matchmakingFeedbackPending, setMatchmakingFeedbackPending] = useState(false);
  const [matchSoundEnabled, setMatchSoundEnabled] = useState(() => loadMatchSoundEnabled());
  const [devModeEnabled, setDevModeEnabled] = useState(() => loadDevModeEnabled());
  const [realtimeStatus, setRealtimeStatus] = useState<PlayerRealtimeStatusDto>(emptyRealtimeStatus);
  const [, setStale] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [savedLogin, setSavedLogin] = useState<SavedPlayerLogin | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [changePasswordPending, setChangePasswordPending] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [friendsExpanded, setFriendsExpanded] = useState(false);
  const [busyPartyInvitationId, setBusyPartyInvitationId] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [loginForm] = Form.useForm<LoginValues>();
  const resolvedFriendRequestIds = useRef(new Set<string>());
  const resolvedPartyInvitationIds = useRef(new Set<string>());
  const partyInviteAutoIgnoreTimeouts = useRef(new Map<string, number>());
  const acceptedInviteJoinMessageAccountIds = useRef(new Set<string>());
  const enteredReadyRoomIds = useRef(new Set<string>());
  const playedMatchSoundRoomIds = useRef(new Set<string>());
  const pendingMatchSoundRoomIds = useRef(new Set<string>());
  const matchFoundAudioRef = useRef<HTMLAudioElement | null>(null);
  const matchSoundEnabledRef = useRef(matchSoundEnabled);

  const api = window.playerApi;
  const currentRoom = getCurrentRoom(matchmaking);
  const activeMatchRoom = getActiveMatchRoom(matchmaking);
  const visibleHomeParty = !party || party.memberAccountIds.length <= 1 ? null : party;
  const syncedMatchmakingPendingAt = party?.status === "open" ? party.matchmakingPendingAt ?? null : null;
  const knownPlayerProfiles = buildKnownPlayerProfiles(account, friends);
  const currentRoomWithKnownProfiles = mergeRoomKnownPlayerProfiles(currentRoom, knownPlayerProfiles);
  const hasActiveMatch = Boolean(activeMatchRoom);
  const accountLabel = playerAccountLabel(account);
  const canUseMatchmaking = Boolean(account?.steam64?.trim());

  useEffect(() => {
    preloadMapImages();
    void restoreSession();
    void window.playerApi.getVersion().then(setCurrentVersion);
    void checkStartupUpdate();
  }, []);

  useEffect(() => {
    if (activeMatchRoom) {
      setMatchmakingFeedbackPending(false);
    }
  }, [activeMatchRoom?.id]);

  useEffect(() => {
    const invitationIds = new Set(matchmaking.partyInvitations.map((invitation) => invitation.id));
    for (const [invitationId, timeout] of partyInviteAutoIgnoreTimeouts.current) {
      if (!invitationIds.has(invitationId)) {
        window.clearTimeout(timeout);
        partyInviteAutoIgnoreTimeouts.current.delete(invitationId);
      }
    }
    for (const invitation of matchmaking.partyInvitations) {
      if (partyInviteAutoIgnoreTimeouts.current.has(invitation.id)) continue;
      const timeout = window.setTimeout(() => void ignorePartyInvite(invitation.id), partyInviteRemainingMs(invitation));
      partyInviteAutoIgnoreTimeouts.current.set(invitation.id, timeout);
    }
  }, [matchmaking.partyInvitations]);

  useEffect(() => () => {
    for (const timeout of partyInviteAutoIgnoreTimeouts.current.values()) {
      window.clearTimeout(timeout);
    }
    partyInviteAutoIgnoreTimeouts.current.clear();
  }, []);

  useEffect(() => {
    if (!matchSoundEnabled) return;
    const audio = new Audio(matchFoundSoundUrl);
    audio.preload = "auto";
    audio.volume = 1;
    matchFoundAudioRef.current = audio;
    return () => {
      audio.pause();
      if (matchFoundAudioRef.current === audio) {
        matchFoundAudioRef.current = null;
      }
    };
  }, [matchSoundEnabled]);

  useEffect(() => {
    matchSoundEnabledRef.current = matchSoundEnabled;
    saveMatchSoundEnabled(matchSoundEnabled);
  }, [matchSoundEnabled]);

  useEffect(() => {
    saveDevModeEnabled(devModeEnabled);
  }, [devModeEnabled]);

  useEffect(() => {
    if (matchSoundEnabled) return;
    const audio = matchFoundAudioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    pendingMatchSoundRoomIds.current.clear();
  }, [matchSoundEnabled]);

  useEffect(() => {
    if (!account) return;

    const unsubscribeStatus = api.onRealtimeStatus((status) => {
      setRealtimeStatus(status);
      setStale(status.stale);
    });
    const unsubscribeSnapshot = api.onRealtimeSnapshot((snapshot) => {
      applyRealtimeSnapshot(snapshot);
    });
    const unsubscribeEvent = api.onRealtimeEvent((event) => {
      applyRealtimeEvent(event);
    });
    const unsubscribeAccount = api.onAccountUpdated((nextAccount) => {
      setAccount((current) => (current ? nextAccount : current));
    });

    return () => {
      unsubscribeStatus();
      unsubscribeSnapshot();
      unsubscribeEvent();
      unsubscribeAccount();
    };
  }, [account]);


  useEffect(() => {
    if (!account || activeView !== "match-room" || currentRoom?.phase !== "ready") return;

    let cancelled = false;
    const refreshReadyRoom = () => {
      if (cancelled) return;
      void hydrateRealtimeState("matchmaking");
    };

    const refreshTimer = window.setInterval(refreshReadyRoom, READY_ROOM_SNAPSHOT_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, [account, activeView, currentRoom?.id, currentRoom?.phase]);

  useEffect(() => {
    const readyRoom = currentRoom;
    if (activeView !== "match-room" || !account?.id || !readyRoom || !isAccountInReadyRoom(readyRoom, account.id)) return;

    const entryKey = `${readyRoom.id}:${account.id}`;
    if (enteredReadyRoomIds.current.has(entryKey)) return;

    let cancelled = false;
    let retryTimer: number | undefined;
    const markReadyRoomEntered = async (attempt = 0) => {
      enteredReadyRoomIds.current.add(entryKey);
      try {
        const nextRoom = await api.ackMatchRoomEntered(readyRoom.id);
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
  }, [account?.id, activeView, currentRoom?.id, currentRoom?.phase]);

  async function hydrateRealtimeState(scope: PlayerRealtimeSnapshotScope = "full") {
    try {
      const snapshot = await api.refreshRealtimeSnapshot(scope);
      applyRealtimeSnapshot(snapshot);
    } catch {
      // 保持恢复后的基础状态，不把实时快照失败当成登录失败。
    }
  }

  function applyRealtimeSnapshot(snapshot: PlayerRealtimeSnapshotDto) {
    const partySnapshot = snapshot.party !== undefined ? snapshot.party : snapshot.matchmaking.party;
    if (snapshot.friends) {
      setFriends((current) => mergeFriendListSnapshot(current, snapshot.friends!, resolvedFriendRequestIds.current));
    }
    setParty((current) => mergePartySnapshot(current, partySnapshot ?? null));
    setStale(false);
    setRealtimeStatus({ connection: "connected", stale: false });
    const snapshotActiveRoom = getActiveMatchRoom(snapshot.matchmaking);
    setMatchmaking((current) => {
      const mergeSnapshotRoomProgress = (room: PlayerLiveMatchStateDto): PlayerLiveMatchStateDto => {
        const currentRoom = current.room?.id === room.id ? current.room : current.rooms.find((candidate) => candidate.id === room.id);
        return currentRoom ? mergeReadyRoomProgress(currentRoom, room) : room;
      };
      const snapshotRooms = snapshot.matchmaking.rooms.map(mergeSnapshotRoomProgress);
      const snapshotRoom = snapshot.matchmaking.room
        ? mergeSnapshotRoomProgress(snapshot.matchmaking.room)
        : snapshotRooms.at(-1) ?? null;
      const currentActiveRoom = snapshotActiveRoom ? getActiveMatchRoom(current) : null;
      const preservedCurrentRoom = currentActiveRoom
        && !snapshotRooms.some((room) => room.id === currentActiveRoom.id)
        && snapshotRoom?.id !== currentActiveRoom.id
        ? currentActiveRoom
        : null;
      const nextRooms = preservedCurrentRoom
        ? upsertRoom(snapshotRooms, preservedCurrentRoom)
        : snapshotRooms;
      const nextRoom = snapshotRoom ?? preservedCurrentRoom;
      const nextParty = mergePartySnapshot(current.party, partySnapshot ?? null);
      return {
        queue: snapshot.matchmaking.queue,
        rooms: nextRooms,
        party: nextParty,
        partyInvitations: mergePartyInvitationsSnapshot(
          current.partyInvitations,
          snapshot.matchmaking.partyInvitations ?? [],
          resolvedPartyInvitationIds.current,
        ),
        room: nextRoom,
      };
    });
    if (snapshotActiveRoom) {
      setActiveView((current) => (current === "home" ? "match-room" : current));
    }
  }

  function primeMatchFoundSound() {
    if (!matchSoundEnabledRef.current) return;
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
    if (!matchSoundEnabledRef.current || playedMatchSoundRoomIds.current.has(matchId) || pendingMatchSoundRoomIds.current.has(matchId)) return;
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
      const nextRoom = mergeRoomSteamProfileData(sourceRoom, mergeReadyRoomProgress(sourceRoom, updater(sourceRoom)));
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
        if (
          event.request.status === "accepted"
          && (event.request.fromAccountId === account?.id || event.request.toAccountId === account?.id)
        ) {
          void refreshFriendsList();
        }
        return;
      case "friend_list_refresh":
        if (event.accountId === account?.id) {
          void refreshFriendsList();
        }
        return;
      case "party_updated":
        setParty((current) => {
          const nextParty = event.party ? mergePartySnapshot(current, event.party) : null;
          notifyPartyMembershipChange(current, nextParty, account?.id, account, friends, acceptedInviteJoinMessageAccountIds.current);
          return nextParty;
        });
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
        }
        return;
      case "party_invite_resolved":
        resolvedPartyInvitationIds.current.add(event.invitation.id);
        clearPartyInviteAutoIgnoreTimeout(event.invitation.id);
        setMatchmaking((current) => ({
          ...current,
          partyInvitations: removePartyInvitation(current.partyInvitations, event.invitation.id),
        }));
        if (event.invitation.fromAccountId === account?.id) {
          const invitee = partyInviteAccountDisplay(event.invitation.toAccountId, account, friends).label;
          if (event.invitation.status === "accepted") {
            acceptedInviteJoinMessageAccountIds.current.add(event.invitation.toAccountId);
            void message.success(`${invitee}接受了你的邀请`);
          } else if (event.invitation.status === "declined") {
            void message.info(`${invitee}拒绝了你的邀请`);
          } else if (event.invitation.status === "timed_out") {
            void message.info(`${invitee}超时未响应`);
          }
        }
        if (
          event.invitation.status === "accepted"
          && (event.invitation.fromAccountId === account?.id || event.invitation.toAccountId === account?.id)
        ) {
          void hydrateRealtimeState("matchmaking");
        }
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
        setMatchResult(null);
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
        updateCurrentRoom(event.matchId, (room) => mergeTeamsAssignedRoom(room, event.teamA, event.teamB));
        return;
      case "map_randomizing_started":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "map_randomizing",
          mapSelection: event.mapSelection,
        }));
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
        if (event.result) {
          setMatchResult(event.result);
          void message.success("比赛已结束");
          setActiveView("match-result");
          return;
        }
        setMatchResult(null);
        void message.success("比赛已结束");
        setActiveView("home");
        return;
      case "match_failed":
        updateCurrentRoom(event.matchId, (room) => ({
          ...room,
          phase: "failed",
        }), { activate: false });
        setMatchResult(null);
        void message.error("比赛异常结束");
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

  function clearPartyInviteAutoIgnoreTimeout(invitationId: string) {
    const timeout = partyInviteAutoIgnoreTimeouts.current.get(invitationId);
    if (timeout === undefined) return;
    window.clearTimeout(timeout);
    partyInviteAutoIgnoreTimeouts.current.delete(invitationId);
  }

  async function ignorePartyInvite(invitationId: string) {
    setBusyPartyInvitationId(invitationId);
    try {
      await api.ignorePartyInvite(invitationId);
    } catch {
    } finally {
      resolvedPartyInvitationIds.current.add(invitationId);
      clearPartyInviteAutoIgnoreTimeout(invitationId);
      setMatchmaking((current) => ({
        ...current,
        partyInvitations: removePartyInvitation(current.partyInvitations, invitationId),
      }));
      setBusyPartyInvitationId(null);
    }
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
    if (!account) return;
    try {
      const nextFriends = await api.listFriends();
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
        setMatchResult(null);
        setActiveView("login");
        return;
      }
      setBaseUrl(restored.baseUrl);
      resolvedFriendRequestIds.current.clear();
      resolvedPartyInvitationIds.current.clear();
      acceptedInviteJoinMessageAccountIds.current.clear();
      enteredReadyRoomIds.current.clear();
      setAccount(restored.account);
      setFriends(emptyFriends);
      setParty(restored.matchmaking.party ?? null);
      setMatchmaking(restored.matchmaking);
      setMatchResult(null);
      setRealtimeStatus(emptyRealtimeStatus);
      setStale(false);
      setActiveView(viewFromSession(restored.account, restored.matchmaking));
      void hydrateRealtimeState();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "恢复会话失败");
      await loadSavedLogin();
      setMatchResult(null);
      setActiveView("login");
    } finally {
      setLoading(false);
    }
  }

  async function loadSavedLogin() {
    const saved = await api.loadSavedLogin();
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
        acceptedInviteJoinMessageAccountIds.current.clear();
        enteredReadyRoomIds.current.clear();
        setFriends(emptyFriends);
        setParty(null);
        setMatchmaking(emptyMatchmaking);
        setMatchResult(null);
        setRealtimeStatus(emptyRealtimeStatus);
        setStale(false);
        setActiveView("change-password");
        return;
      }
      const restored = await window.playerApi.restoreSession();
      if (!restored) {
        setMatchResult(null);
        setActiveView("login");
        return;
      }
      setAccount(restored.account);
      resolvedFriendRequestIds.current.clear();
      resolvedPartyInvitationIds.current.clear();
      acceptedInviteJoinMessageAccountIds.current.clear();
      enteredReadyRoomIds.current.clear();
      setFriends(emptyFriends);
      setParty(restored.matchmaking.party ?? null);
      setMatchmaking(restored.matchmaking);
      setMatchResult(null);
      setRealtimeStatus(emptyRealtimeStatus);
      setStale(false);
      setActiveView(viewFromSession(restored.account, restored.matchmaking));
      void hydrateRealtimeState();
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
          setMatchResult(null);
          setActiveView("login");
          return;
        }
        setAccount(restored.account);
        resolvedFriendRequestIds.current.clear();
        resolvedPartyInvitationIds.current.clear();
        acceptedInviteJoinMessageAccountIds.current.clear();
        enteredReadyRoomIds.current.clear();
        setFriends(emptyFriends);
        setParty(restored.matchmaking.party ?? null);
        setMatchmaking(restored.matchmaking);
        setMatchResult(null);
        setRealtimeStatus(emptyRealtimeStatus);
        setStale(false);
        setActiveView(viewFromSession(restored.account, restored.matchmaking));
        void hydrateRealtimeState();
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
      acceptedInviteJoinMessageAccountIds.current.clear();
      enteredReadyRoomIds.current.clear();
      setFriends(emptyFriends);
      setParty(null);
      setMatchmaking(emptyMatchmaking);
      setMatchResult(null);
      setRealtimeStatus(emptyRealtimeStatus);
      setStale(false);
      setCurrentPassword("");
      setSettingsModalOpen(false);
      setPasswordModalOpen(false);
      setActiveView("login");
    }
  }

  async function checkUpdate() {
    setCheckingUpdate(true);
    setUpdateResult(null);
    try {
      const result = await window.playerApi.checkUpdate() as UpdateCheckResult;
      setUpdateResult(result);
      message.success(result.updateAvailable ? "发现可用更新" : "当前已是最新版本");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "检查更新失败");
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function checkStartupUpdate() {
    if (startupUpdateCheckStarted) return;
    startupUpdateCheckStarted = true;
    try {
      const result = await window.playerApi.checkUpdate() as UpdateCheckResult;
      if (!result.updateAvailable) return;
      setUpdateResult(result);
      message.info("发现可用更新");
    } catch {
      return;
    }
  }

  async function installUpdate() {
    setInstallingUpdate(true);
    try {
      await window.playerApi.installUpdate();
      message.info("更新已下载，正在重启");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "安装更新失败");
      setInstallingUpdate(false);
    }
  }

  async function searchFriends(query: string) {
    return api.searchFriends(query);
  }

  async function sendFriendRequest(accountId: string) {
    const request = await api.sendFriendRequest(accountId);
    setFriends((current) => ({
      ...current,
      outgoingRequests: upsertOutgoingRequest(current.outgoingRequests, request),
    }));
  }

  async function acceptFriendRequest(requestId: string) {
    try {
      const nextFriends = await api.acceptFriendRequest(requestId);
      resolvedFriendRequestIds.current.add(requestId);
      setFriends(nextFriends);
      void message.success("已接受好友请求");
      void refreshFriendsList();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "接受好友请求失败");
    }
  }

  async function declineFriendRequest(requestId: string) {
    await api.declineFriendRequest(requestId);
    resolvedFriendRequestIds.current.add(requestId);
    setFriends((current) => ({
      ...current,
      incomingRequests: current.incomingRequests.filter((request) => request.id !== requestId),
    }));
  }

  async function removeFriend(friendshipId: string) {
    try {
      await api.removeFriend(friendshipId);
      setFriends((current) => ({
        ...current,
        friends: current.friends.filter((friend) => friend.friendshipId !== friendshipId),
      }));
      void message.success("已删除好友");
      void refreshFriendsList();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "删除好友失败");
    }
  }

  async function createParty() {
    const nextParty = await api.createParty();
    setParty(nextParty);
    setMatchmaking((current) => ({
      ...current,
      party: nextParty,
    }));
  }

  async function inviteToParty(accountId: string) {
    if (hasActiveMatch) return;
    const targetAccountId = accountId.trim();
    if (!targetAccountId) return;
    if (!party) {
      await createParty();
    }
    await api.inviteToParty(targetAccountId);
    void message.success("队伍邀请已发送");
  }

  async function acceptPartyInvite(invitationId: string) {
    setBusyPartyInvitationId(invitationId);
    try {
      const nextParty = await api.acceptPartyInvite(invitationId);
      resolvedPartyInvitationIds.current.add(invitationId);
      clearPartyInviteAutoIgnoreTimeout(invitationId);
      setParty(nextParty);
      setMatchmaking((current) => ({
        ...current,
        party: nextParty,
        partyInvitations: removePartyInvitation(current.partyInvitations, invitationId),
      }));
      void message.success("已加入队伍");
    } finally {
      setBusyPartyInvitationId(null);
    }
  }

  async function declinePartyInvite(invitationId: string) {
    setBusyPartyInvitationId(invitationId);
    try {
      await api.declinePartyInvite(invitationId);
      resolvedPartyInvitationIds.current.add(invitationId);
      clearPartyInviteAutoIgnoreTimeout(invitationId);
      setMatchmaking((current) => ({
        ...current,
        partyInvitations: removePartyInvitation(current.partyInvitations, invitationId),
      }));
      void message.info("已拒绝队伍邀请");
    } finally {
      setBusyPartyInvitationId(null);
    }
  }

  async function leaveParty() {
    if (!party || hasActiveMatch) return;
    try {
      await api.leaveParty();
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

  async function startPartyMatchmaking(options?: { dev?: boolean }) {
    const nextRoom = await api.startPartyMatchmaking(options);
    setMatchmaking((current) => ({
      ...current,
      room: nextRoom,
      rooms: upsertRoom(current.rooms, nextRoom),
    }));
    playMatchFoundSound(nextRoom.id);
    setActiveView("match-room");
    setMatchmakingFeedbackPending(false);
  }

  async function startMatchmakingFromHome(options?: { dev?: boolean }) {
    if (!canUseMatchmaking || hasActiveMatch || matchmakingFeedbackPending) return;
    if (party && party.ownerAccountId !== account?.id) return;
    primeMatchFoundSound();
    setMatchmakingFeedbackPending(true);
    let matchmakingPendingSynced = false;
    try {
      if (!party) {
        await createParty();
      }
      const pendingParty = await api.beginPartyMatchmaking();
      matchmakingPendingSynced = true;
      setParty(pendingParty);
      setMatchmaking((current) => ({
        ...current,
        party: pendingParty,
      }));
      await waitForMatchmakingDelay(randomMatchmakingDelayMs());
      await startPartyMatchmaking(options);
    } catch (error) {
      if (matchmakingPendingSynced) {
        const nextParty = await api.cancelPartyMatchmaking().catch(() => undefined);
        if (nextParty) {
          setParty(nextParty);
          setMatchmaking((current) => ({
            ...current,
            party: nextParty,
          }));
        }
      }
      setMatchmakingFeedbackPending(false);
      message.error(error instanceof Error ? error.message : "开始匹配失败");
    }
  }

  async function acceptReady() {
    if (!currentRoom) return;
    const nextRoom = await api.acceptReady();
    updateCurrentRoom(nextRoom.id, () => nextRoom);
    await hydrateRealtimeState("matchmaking");
  }

  async function declineReady() {
    if (!currentRoom) return;
    const nextRoom = await api.declineReady();
    updateCurrentRoom(nextRoom.id, () => nextRoom);
    if (isTerminalMatchPhase(nextRoom.phase)) {
      setActiveView("home");
    }
    await hydrateRealtimeState("matchmaking");
  }

  async function copyText(text: string) {
    await api.copyText(text);
    message.success("已复制");
  }

  function renderAuthenticatedView() {
    if (activeView === "match-result" && matchResult) {
      return <MatchResultPage result={matchResult} selfSteam64={account?.steam64} onBackHome={() => setActiveView("home")} />;
    }
    if (activeView === "match-room") {
      return (
        <MatchRoomPage
          account={account}
          room={currentRoomWithKnownProfiles}
          onAcceptReady={() => acceptReady()}
          onDeclineReady={() => declineReady()}
          onCopyText={(text) => copyText(text)}
        />
      );
    }
    return (
      <HomePage
        account={account}
        friends={friends}
        party={visibleHomeParty}
        matchmakingPending={matchmakingFeedbackPending || Boolean(syncedMatchmakingPendingAt)}
        matchmakingPendingStartedAt={syncedMatchmakingPendingAt}
        devModeEnabled={devModeEnabled}
        onInviteFriend={!hasActiveMatch ? inviteToParty : undefined}
        onLeaveParty={party && !hasActiveMatch ? leaveParty : undefined}
        onStartMatchmaking={
          canUseMatchmaking && !hasActiveMatch && (!party || party.ownerAccountId === account?.id)
            ? startMatchmakingFromHome
            : undefined
        }
      />
    );
  }

  if (loading) {
    return (
      <div className="player-loading-screen">
        <Spin size="large" />
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
      <div className={`player-app-frame${friendsExpanded ? "" : " player-app-frame--collapsed"}`}>
        <div className="player-window-drag-region" />
        <div className="player-app-profile">
          <div className="player-app-brand">
            <SteamAvatar className="player-app-avatar" avatarUrl={account?.steamAvatarUrl} label={accountLabel} />
            <div className="player-app-brand-copy">
              <div className="player-kicker">Compet Player</div>
              <strong>{accountLabel}</strong>
            </div>
          </div>
        </div>

        <div className="player-app-chrome">
          <div className="player-app-meta">
            <span aria-label="当前服务器地址" className="player-status-pill player-status-pill--server">
              {baseUrl}
            </span>
            <span className={`player-status-pill player-status-pill--${realtimeStatus.connection}`}>{realtimeStatus.connection}</span>
            <Button
              aria-label="设置"
              className="player-app-settings-button"
              icon={<SettingOutlined />}
              type="text"
              onClick={() => setSettingsModalOpen(true)}
            />
            <div className="player-window-controls" aria-label="窗口控制">
              <Button
                aria-label="最小化窗口"
                className="player-window-control"
                icon={<MinusOutlined />}
                type="text"
                onClick={() => void api.minimizeWindow()}
              />
              <Button
                aria-label="关闭窗口"
                className="player-window-control player-window-control--close"
                icon={<CloseOutlined />}
                type="text"
                onClick={() => void api.closeWindow()}
              />
            </div>
          </div>
        </div>

        <div className={`player-app-layout${friendsExpanded ? "" : " player-app-layout--collapsed"}`}>
          <main className="player-app-main">{renderAuthenticatedView()}</main>
          <aside
            className="player-app-sidebar"
            onMouseEnter={() => setFriendsExpanded(true)}
            onMouseLeave={() => setFriendsExpanded(false)}
          >
            <FriendsPanel
              expanded={friendsExpanded}
              accountId={account?.id ?? ""}
              account={account}
              friends={friends}
              onSearchFriends={searchFriends}
              onReenrichFriends={(results) => api.reenrichFriends(results)}
              onProfilesUpdated={(listener) => api.onProfilesUpdated(listener)}
              onSendFriendRequest={sendFriendRequest}
              onAcceptFriendRequest={acceptFriendRequest}
              onDeclineFriendRequest={declineFriendRequest}
              onRemoveFriend={removeFriend}
            />
          </aside>
        </div>
        <PartyInviteToasts
          invitations={matchmaking.partyInvitations}
          account={account}
          friends={friends}
          busyInvitationId={busyPartyInvitationId}
          onAccept={acceptPartyInvite}
          onDecline={declinePartyInvite}
          onIgnore={ignorePartyInvite}
        />
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
        <Modal
          centered
          footer={null}
          open={settingsModalOpen}
          title="设置"
          onCancel={() => setSettingsModalOpen(false)}
        >
          <div className="player-settings">
            <Tabs
              items={[
                {
                  key: "general",
                  label: "常规",
                  children: (
                    <div className="player-settings-pane">
                      <label className="player-settings-row">
                        <span>匹配音效</span>
                        <Switch
                          aria-label="匹配音效"
                          checked={matchSoundEnabled}
                          checkedChildren="开"
                          unCheckedChildren="关"
                          onChange={setMatchSoundEnabled}
                          size="small"
                        />
                      </label>
                      {account?.dev ? (
                        <label className="player-settings-row">
                          <span>开发模式（固定阵容）</span>
                          <Switch
                            aria-label="开发模式"
                            checked={devModeEnabled}
                            checkedChildren="开"
                            unCheckedChildren="关"
                            onChange={setDevModeEnabled}
                            size="small"
                          />
                        </label>
                      ) : null}
                      <div className="player-settings-actions">
                        <Button
                          onClick={() => {
                            setSettingsModalOpen(false);
                            setPasswordModalOpen(true);
                          }}
                        >
                          修改密码
                        </Button>
                        <Button onClick={() => void logout()}>
                          退出登录
                        </Button>
                      </div>
                    </div>
                  ),
                },
                {
                  key: "about",
                  label: "关于",
                  children: (
                    <div className="player-settings-pane">
                      <div className="player-settings-update">
                        <div className="player-settings-version">当前版本：{currentVersion || "读取中"}</div>
                        {updateResult?.updateAvailable === true ? (
                          <Button
                            type="primary"
                            onClick={() => void installUpdate()}
                            loading={installingUpdate}
                            disabled={installingUpdate}
                          >
                            下载并安装
                          </Button>
                        ) : (
                          <Button onClick={() => void checkUpdate()} loading={checkingUpdate} disabled={checkingUpdate}>
                            检查更新
                          </Button>
                        )}
                        {updateResult ? (
                          <Alert
                            type={updateResult.updateAvailable ? "info" : "success"}
                            showIcon
                            message={
                              updateResult.updateAvailable
                                ? `发现 ${updateResult.latestVersion}，需更新 ${updateResult.changedFiles} 个文件，约 ${formatBytes(updateResult.changedBytes)}`
                                : `当前版本 ${updateResult.currentVersion} 已是最新`
                            }
                          />
                        ) : null}
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </Modal>
      </div>
    </div>
  );
}
