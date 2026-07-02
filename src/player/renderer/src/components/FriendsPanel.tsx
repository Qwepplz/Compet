import { Badge, Button, Dropdown, Input, Modal } from "antd";
import { TeamOutlined, UserAddOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountView } from "../../../../manager/shared/types.js";
import type { PlayerFriendDto, PlayerFriendListDto, PlayerFriendSearchResultDto } from "../../../shared/types.js";
import { SteamAvatar } from "./SteamAvatar.js";
import { playerAccountLabel } from "../playerDisplay.js";

interface FriendsPanelProps {
  expanded: boolean;
  accountId: string;
  account: AccountView | null;
  friends: PlayerFriendListDto;
  onSearchFriends?: (query: string) => Promise<PlayerFriendSearchResultDto[]>;
  onReenrichFriends?: (results: PlayerFriendSearchResultDto[]) => Promise<PlayerFriendSearchResultDto[]>;
  onProfilesUpdated?: (listener: () => void) => () => void;
  onSendFriendRequest?: (accountId: string) => Promise<void>;
  onAcceptFriendRequest?: (requestId: string) => Promise<void>;
  onDeclineFriendRequest?: (requestId: string) => Promise<void>;
  onViewMatchHistory?: (friend: PlayerFriendDto) => void;
  onRemoveFriend?: (friendshipId: string) => Promise<void>;
}

function formatLastSeen(lastSeenAt?: string): string {
  if (!lastSeenAt) return "";
  const date = new Date(lastSeenAt);
  if (Number.isNaN(date.getTime())) return lastSeenAt;
  const diffMinutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} 天前`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} 个月前`;
  return `${Math.floor(diffDays / 365)} 年前`;
}

export function FriendsPanel({
  expanded,
  accountId,
  account,
  friends,
  onSearchFriends,
  onReenrichFriends,
  onProfilesUpdated,
  onSendFriendRequest,
  onAcceptFriendRequest,
  onDeclineFriendRequest,
  onViewMatchHistory,
  onRemoveFriend,
}: FriendsPanelProps) {
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
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

  async function handleRemoveFriend(friendshipId: string) {
    if (!onRemoveFriend) return;
    setPendingRequestId(friendshipId);
    try {
      await onRemoveFriend(friendshipId);
    } finally {
      setPendingRequestId(null);
    }
  }

  function handleViewMatchHistory(friend: PlayerFriendDto) {
    if (!onViewMatchHistory) return;
    onViewMatchHistory(friend);
  }

  const pendingCount = friends.incomingRequests.length;
  const open = expanded || addOpen;

  return (
    <section className={`player-social-panel${open ? "" : " player-social-panel--collapsed"}`}>
      <div className="player-social-header">
        <Badge className="player-social-rail" count={open ? 0 : pendingCount} size="small">
          <span className="player-social-rail-icon" aria-label="好友列表">
            <TeamOutlined />
          </span>
        </Badge>
        <div className="player-social-heading">
          <div className="player-kicker">Friends</div>
          <h3 className="player-social-title">好友</h3>
        </div>
        <Button
          className="player-social-add"
          aria-label="添加好友"
          type="text"
          icon={<UserAddOutlined />}
          onClick={() => setAddOpen(true)}
          disabled={!onSearchFriends}
        />
      </div>

      <div className="player-social-stack">
        {friends.incomingRequests.length > 0 ? (
          <div className="player-social-group player-social-group--pending">
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
          <div className="player-social-group">
            <div className="player-social-list">
              {friends.friends.map((friend) => (
                <Dropdown
                  key={friend.friendshipId}
                  trigger={["contextMenu"]}
                  menu={{
                    items: [
                      {
                        key: "history",
                        label: "查看历史战绩",
                        disabled: !onViewMatchHistory,
                      },
                      {
                        key: "remove",
                        label: "删除好友",
                        danger: true,
                        disabled: !onRemoveFriend || pendingRequestId === friend.friendshipId,
                      },
                    ],
                    onClick: ({ key }) => {
                      if (key === "history") handleViewMatchHistory(friend);
                      if (key === "remove") void handleRemoveFriend(friend.friendshipId);
                    },
                  }}
                >
                  <div className="player-social-row">
                    <SteamAvatar
                      className={friend.online ? "faceit-avatar player-social-avatar--online" : "faceit-avatar"}
                      avatarUrl={friend.steamAvatarUrl}
                      label={friend.displayName}
                    />
                    <div className="player-social-row-main">
                      <strong>{friend.displayName}</strong>
                      <span className={friend.online ? "player-status-pill" : "player-status-pill player-status-pill--muted"}>
                        {friend.online ? "在线" : "离线"}
                      </span>
                      {!friend.online && friend.lastSeenAt ? <span className="player-social-meta">{formatLastSeen(friend.lastSeenAt)}</span> : null}
                    </div>
                  </div>
                </Dropdown>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <Modal
        centered
        footer={null}
        open={addOpen}
        title="添加好友"
        onCancel={() => {
          setAddOpen(false);
          setQuery("");
          setSearchResults([]);
        }}
      >
        <div className="player-add-friend">
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
                      <span className={result.online ? "player-status-pill" : "player-status-pill player-status-pill--muted"}>
                        {result.online ? "在线" : "离线"}
                      </span>
                      {!result.online && result.lastSeenAt ? <span className="player-social-meta">{formatLastSeen(result.lastSeenAt)}</span> : null}
                    </div>
                    <Button
                      aria-label="发送好友请求"
                      size="small"
                      onClick={() => void handleSendRequest(result.accountId)}
                      disabled={isFriend || hasPending || !onSendFriendRequest}
                      loading={pendingRequestId === result.accountId}
                    >
                      发送好友请求
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </Modal>
    </section>
  );
}
