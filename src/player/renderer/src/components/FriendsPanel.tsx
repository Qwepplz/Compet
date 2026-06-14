import { Button, Input } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountView } from "../../../../manager/shared/types.js";
import type { PlayerFriendListDto, PlayerFriendSearchResultDto, PlayerPartyInvitationDto } from "../../../shared/types.js";
import { SteamAvatar } from "./SteamAvatar.js";
import { playerAccountLabel } from "../playerDisplay.js";

interface FriendsPanelProps {
  accountId: string;
  account: AccountView | null;
  friends: PlayerFriendListDto;
  partyInvitations: PlayerPartyInvitationDto[];
  onSearchFriends?: (query: string) => Promise<PlayerFriendSearchResultDto[]>;
  onReenrichFriends?: (results: PlayerFriendSearchResultDto[]) => Promise<PlayerFriendSearchResultDto[]>;
  onProfilesUpdated?: (listener: () => void) => () => void;
  onSendFriendRequest?: (accountId: string) => Promise<void>;
  onAcceptFriendRequest?: (requestId: string) => Promise<void>;
  onDeclineFriendRequest?: (requestId: string) => Promise<void>;
  onAcceptPartyInvite?: (invitationId: string) => Promise<void>;
  onDeclinePartyInvite?: (invitationId: string) => Promise<void>;
}

function formatLastSeen(lastSeenAt?: string): string {
  if (!lastSeenAt) return "";
  const date = new Date(lastSeenAt);
  if (Number.isNaN(date.getTime())) return lastSeenAt;
  return date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function FriendsPanel({
  accountId,
  account,
  friends,
  partyInvitations,
  onSearchFriends,
  onReenrichFriends,
  onProfilesUpdated,
  onSendFriendRequest,
  onAcceptFriendRequest,
  onDeclineFriendRequest,
  onAcceptPartyInvite,
  onDeclinePartyInvite,
}: FriendsPanelProps) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<PlayerFriendSearchResultDto[]>([]);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [busyPartyInvitationId, setBusyPartyInvitationId] = useState<string | null>(null);
  const searchResultsRef = useRef<PlayerFriendSearchResultDto[]>([]);
  searchResultsRef.current = searchResults;

  const friendIds = useMemo(() => new Set(friends.friends.map((friend) => friend.accountId)), [friends.friends]);
  const pendingAccountIds = useMemo(
    () => new Set([
      ...friends.incomingRequests.map((request) => request.fromAccountId),
      ...friends.outgoingRequests.map((request) => request.toAccountId),
    ]),
    [friends.incomingRequests, friends.outgoingRequests],
  );

  useEffect(() => {
    if (!onProfilesUpdated || !onReenrichFriends) return;
    return onProfilesUpdated(() => {
      const current = searchResultsRef.current;
      if (current.length === 0) return;
      void onReenrichFriends(current)
        .then((enriched) => {
          setSearchResults((latest) => (latest === current ? enriched : latest));
        })
        .catch(() => undefined);
    });
  }, [onProfilesUpdated, onReenrichFriends]);

  async function handleSearch() {
    const trimmed = query.trim();
    if (!trimmed || !onSearchFriends) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      setSearchResults(await onSearchFriends(trimmed));
    } finally {
      setSearching(false);
    }
  }

  async function handleSendRequest(targetAccountId: string) {
    if (!onSendFriendRequest) return;
    setPendingRequestId(targetAccountId);
    try {
      await onSendFriendRequest(targetAccountId);
    } finally {
      setPendingRequestId(null);
    }
  }

  async function handleAcceptRequest(requestId: string) {
    if (!onAcceptFriendRequest) return;
    setPendingRequestId(requestId);
    try {
      await onAcceptFriendRequest(requestId);
    } finally {
      setPendingRequestId(null);
    }
  }

  async function handleDeclineRequest(requestId: string) {
    if (!onDeclineFriendRequest) return;
    setPendingRequestId(requestId);
    try {
      await onDeclineFriendRequest(requestId);
    } finally {
      setPendingRequestId(null);
    }
  }

  async function handleAcceptPartyInvite(invitationId: string) {
    if (!onAcceptPartyInvite) return;
    setBusyPartyInvitationId(invitationId);
    try {
      await onAcceptPartyInvite(invitationId);
    } finally {
      setBusyPartyInvitationId(null);
    }
  }

  async function handleDeclinePartyInvite(invitationId: string) {
    if (!onDeclinePartyInvite) return;
    setBusyPartyInvitationId(invitationId);
    try {
      await onDeclinePartyInvite(invitationId);
    } finally {
      setBusyPartyInvitationId(null);
    }
  }

  function inviterDisplay(fromAccountId: string): { label: string; avatarUrl?: string } {
    if (fromAccountId === account?.id) {
      return { label: playerAccountLabel(account), avatarUrl: account.steamAvatarUrl };
    }
    const friend = friends.friends.find((entry) => entry.accountId === fromAccountId);
    return { label: friend?.steamPersonaName ?? friend?.displayName ?? "玩家", avatarUrl: friend?.steamAvatarUrl };
  }

  return (
    <section className="player-social-panel">
      <div className="player-social-header">
        <div>
          <div className="player-kicker">Friends</div>
          <h3 className="player-social-title">好友</h3>
        </div>
      </div>

      <div className="player-social-search">
        <Input
          value={query}
          placeholder="输入账号用户名"
          onChange={(event) => setQuery(event.target.value)}
          onPressEnter={() => void handleSearch()}
          disabled={!onSearchFriends}
        />
        <Button aria-label="搜索" type="primary" onClick={() => void handleSearch()} loading={searching} disabled={!onSearchFriends}>
          搜索
        </Button>
      </div>

      <div className="player-social-stack">
        {searchResults.length > 0 ? (
          <div>
            <div className="player-social-list">
              {searchResults.map((result) => {
                const isSelf = result.accountId === accountId;
                const isFriend = friendIds.has(result.accountId);
                const hasPending = pendingAccountIds.has(result.accountId) || isSelf;
                return (
                  <div className="player-social-row" key={result.accountId}>
                    <SteamAvatar avatarUrl={result.steamAvatarUrl} label={result.displayName} />
                    <div className="player-social-row-main">
                      <strong>{result.displayName}</strong>
                      <span className={result.online ? "player-status-pill" : "player-status-pill player-status-pill--muted"}>
                        {result.online ? "在线" : "离线"}
                      </span>
                      {!result.online && result.lastSeenAt ? <span className="player-social-meta">{formatLastSeen(result.lastSeenAt)}</span> : null}
                    </div>
                    <Button
                      aria-label="发送好友请求"
                      size="small"
                      onClick={() => void handleSendRequest(result.accountId)}
                      disabled={!result.online || isFriend || hasPending || !onSendFriendRequest}
                      loading={pendingRequestId === result.accountId}
                    >
                      发送好友请求
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {partyInvitations.length > 0 ? (
          <div>
            <div className="player-social-list">
              {partyInvitations.map((invitation) => {
                const inviter = inviterDisplay(invitation.fromAccountId);
                return (
                  <div className="player-social-row" key={invitation.id}>
                    <SteamAvatar avatarUrl={inviter.avatarUrl} label={inviter.label} />
                    <div className="player-social-row-main">
                      <strong>{inviter.label}</strong>
                      <span>邀请你加入队伍</span>
                    </div>
                    <div className="player-social-row-actions">
                      <Button
                        aria-label="接受"
                        size="small"
                        type="primary"
                        onClick={() => void handleAcceptPartyInvite(invitation.id)}
                        loading={busyPartyInvitationId === invitation.id}
                        disabled={!onAcceptPartyInvite}
                      >
                        接受
                      </Button>
                      <Button
                        aria-label="拒绝"
                        size="small"
                        onClick={() => void handleDeclinePartyInvite(invitation.id)}
                        loading={busyPartyInvitationId === invitation.id}
                        disabled={!onDeclinePartyInvite}
                      >
                        拒绝
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {friends.incomingRequests.length > 0 ? (
          <div>
            <div className="player-social-list">
              {friends.incomingRequests.map((request) => (
                <div className="player-social-row" key={request.id}>
                  <SteamAvatar avatarUrl={request.steamAvatarUrl} label={request.displayName} />
                  <div className="player-social-row-main">
                    <strong>{request.displayName}</strong>
                    <span>好友请求</span>
                    <span className={request.online ? "player-status-pill" : "player-status-pill player-status-pill--muted"}>
                      {request.online ? "在线" : "离线"}
                    </span>
                  </div>
                  <div className="player-social-row-actions">
                    <Button
                      aria-label="接受"
                      size="small"
                      type="primary"
                      onClick={() => void handleAcceptRequest(request.id)}
                      loading={pendingRequestId === request.id}
                    >
                      接受
                    </Button>
                    <Button
                      aria-label="拒绝"
                      size="small"
                      onClick={() => void handleDeclineRequest(request.id)}
                      loading={pendingRequestId === request.id}
                    >
                      拒绝
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {friends.friends.length > 0 ? (
          <div>
            <div className="player-social-list">
              {friends.friends.map((friend) => (
                <div className="player-social-row" key={friend.friendshipId}>
                  <SteamAvatar avatarUrl={friend.steamAvatarUrl} label={friend.displayName} />
                  <div className="player-social-row-main">
                    <strong>{friend.displayName}</strong>
                    <span>好友</span>
                    <span className={friend.online ? "player-status-pill" : "player-status-pill player-status-pill--muted"}>
                      {friend.online ? "在线" : "离线"}
                    </span>
                    {!friend.online && friend.lastSeenAt ? <span className="player-social-meta">{formatLastSeen(friend.lastSeenAt)}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
