import { Button, Input } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerFriendListDto, PlayerFriendSearchResultDto } from "../../../shared/types.js";
import { SteamAvatar } from "./SteamAvatar.js";

interface FriendsPanelProps {
  accountId: string;
  friends: PlayerFriendListDto;
  onSearchFriends?: (query: string) => Promise<PlayerFriendSearchResultDto[]>;
  onReenrichFriends?: (results: PlayerFriendSearchResultDto[]) => Promise<PlayerFriendSearchResultDto[]>;
  onProfilesUpdated?: (listener: () => void) => () => void;
  onSendFriendRequest?: (accountId: string) => Promise<void>;
  onAcceptFriendRequest?: (requestId: string) => Promise<void>;
  onDeclineFriendRequest?: (requestId: string) => Promise<void>;
}

function formatLastSeen(lastSeenAt?: string): string {
  if (!lastSeenAt) return "";
  const date = new Date(lastSeenAt);
  if (Number.isNaN(date.getTime())) return lastSeenAt;
  return date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function FriendsPanel({
  accountId,
  friends,
  onSearchFriends,
  onReenrichFriends,
  onProfilesUpdated,
  onSendFriendRequest,
  onAcceptFriendRequest,
  onDeclineFriendRequest,
}: FriendsPanelProps) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<PlayerFriendSearchResultDto[]>([]);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
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

  return (
    <section className="player-social-panel">
      <div className="player-social-header">
        <div>
          <div className="player-kicker">Friends</div>
          <h3 className="player-social-title">好友</h3>
        </div>
        <span className="player-status-pill">{friends.friends.length} 人</span>
      </div>

      <div className="player-social-search">
        <Input
          value={query}
          placeholder="输入 Steam64、Steam 链接或账号名"
          onChange={(event) => setQuery(event.target.value)}
          onPressEnter={() => void handleSearch()}
          disabled={!onSearchFriends}
        />
        <Button aria-label="搜索" type="primary" onClick={() => void handleSearch()} loading={searching} disabled={!onSearchFriends}>
          搜索
        </Button>
      </div>

      <div className="player-social-stack">
        <div>
          <div className="player-social-subtitle">搜索结果</div>
          {searchResults.length > 0 ? (
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
                      <span>已绑定 Steam</span>
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
          ) : (
            <div className="player-empty">输入 Steam64、Steam 链接或账号名后搜索玩家。</div>
          )}
        </div>

        <div>
          <div className="player-social-subtitle">收到的请求</div>
          {friends.incomingRequests.length > 0 ? (
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
          ) : (
            <div className="player-empty">暂无待处理请求。</div>
          )}
        </div>

        <div>
          <div className="player-social-subtitle">好友列表</div>
          {friends.friends.length > 0 ? (
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
          ) : (
            <div className="player-empty">暂无好友。</div>
          )}
        </div>
      </div>
    </section>
  );
}
