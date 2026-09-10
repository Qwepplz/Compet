import { Badge, Button, Dropdown, Input, Modal } from "antd";
import { TeamOutlined, UserAddOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountView } from "../../../../manager/shared/types.js";
import type { PlayerFriendDto, PlayerFriendListDto, PlayerFriendSearchResultDto } from "../../../shared/types.js";
import { resolveFriendStatus, type FriendStatusLabel } from "../friendStatus.js";
import { RankmeBadges } from "./RankmeBadges.js";
import { SteamAvatar } from "./SteamAvatar.js";
import { useLanguage, type LanguageContextValue } from "../../../../language/react.js";

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

function formatLastSeen(lastSeenAt: string | undefined, t: LanguageContextValue["t"]): string {
  if (!lastSeenAt) return "";
  const date = new Date(lastSeenAt);
  if (Number.isNaN(date.getTime())) return t("common.time.invalid");
  const diffMinutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMinutes < 1) return t("common.time.justNow");
  if (diffMinutes < 60) return t("common.time.minutesAgo", { count: diffMinutes });
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return t("common.time.hoursAgo", { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return t("common.time.daysAgo", { count: diffDays });
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return t("common.time.monthsAgo", { count: diffMonths });
  return t("common.time.yearsAgo", { count: Math.floor(diffDays / 365) });
}

function friendStatusLabel(status: FriendStatusLabel, t: LanguageContextValue["t"]): string {
  switch (status) {
    case "online":
      return t("player.friends.status.online");
    case "inGame":
      return t("player.friends.status.inGame");
    case "offline":
      return t("player.friends.status.offline");
  }
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
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<PlayerFriendSearchResultDto[]>([]);
  const [hasSearchedFriends, setHasSearchedFriends] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [modal, modalContextHolder] = Modal.useModal();
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
      setHasSearchedFriends(false);
      return;
    }
    setSearching(true);
    try {
      setSearchResults(await onSearchFriends(trimmed));
      setHasSearchedFriends(true);
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

  function confirmRemoveFriend(friend: PlayerFriendDto) {
    modal.confirm({
      centered: true,
      title: t("player.friends.removeTitle"),
      content: t("player.friends.removeConfirm", { name: friend.displayName }),
      okText: t("common.actions.delete"),
      cancelText: t("common.actions.cancel"),
      autoFocusButton: "cancel",
      okButtonProps: { danger: true },
      onOk: () => handleRemoveFriend(friend.friendshipId),
    });
  }

  const pendingCount = friends.incomingRequests.length;
  const open = expanded || addOpen;

  return (
    <section className={`player-social-panel${open ? "" : " player-social-panel--collapsed"}`}>
      {modalContextHolder}
      <div className="player-social-header">
        <Badge className="player-social-rail" count={open ? 0 : pendingCount} size="small">
          <span className="player-social-rail-icon" aria-label={t("common.navigation.friends")}>
            <TeamOutlined />
          </span>
        </Badge>
        <div className="player-social-heading">
          <div className="player-kicker">{t("player.friends.title")}</div>
          <h3 className="player-social-title">{t("player.friends.title")}</h3>
        </div>
        <Button
          className="player-social-add"
          aria-label={t("player.friends.add")}
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
              {friends.incomingRequests.map((request) => {
                const status = resolveFriendStatus(request);
                return (
                <div className="player-social-row" key={request.id}>
                  <SteamAvatar
                    className={`faceit-avatar player-social-avatar--${status.tone}`}
                    avatarUrl={request.steamAvatarUrl}
                    label={request.displayName}
                  />
                  <div className="player-social-row-main">
                    <strong>{request.displayName}</strong>
                    <span>{t("player.friends.request")}</span>
                    <span className={`player-status-pill${status.tone === "offline" ? " player-status-pill--muted" : ""}`}>
                      {friendStatusLabel(status.label, t)}
                    </span>
                    {status.tone === "offline" && request.lastSeenAt ? <span className="player-social-meta">{formatLastSeen(request.lastSeenAt, t)}</span> : null}
                  </div>
                  <div className="player-social-row-actions">
                    <Button
                      aria-label={t("player.friends.accept")}
                      size="small"
                      type="primary"
                      onClick={() => void handleAcceptRequest(request.id)}
                      loading={pendingRequestId === request.id}
                    >
                      {t("player.friends.accept")}
                    </Button>
                    <Button
                      aria-label={t("player.friends.decline")}
                      size="small"
                      onClick={() => void handleDeclineRequest(request.id)}
                      loading={pendingRequestId === request.id}
                    >
                      {t("player.friends.decline")}
                    </Button>
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {friends.friends.length > 0 ? (
          <div className="player-social-group">
            <div className="player-social-list">
              {friends.friends.map((friend) => {
                const status = resolveFriendStatus(friend);
                return (
                <Dropdown
                  key={friend.friendshipId}
                  trigger={["contextMenu"]}
                  menu={{
                    items: [
                      {
                        key: "history",
                        label: t("player.friends.viewHistory"),
                        disabled: !onViewMatchHistory,
                      },
                      {
                        key: "remove",
                        label: t("player.friends.removeTitle"),
                        danger: true,
                        disabled: !onRemoveFriend || pendingRequestId === friend.friendshipId,
                      },
                    ],
                    onClick: ({ key }) => {
                      if (key === "history") handleViewMatchHistory(friend);
                      if (key === "remove") confirmRemoveFriend(friend);
                    },
                  }}
                >
                  <div className="player-social-row">
                    <SteamAvatar
                      className={`faceit-avatar player-social-avatar--${status.tone}`}
                      avatarUrl={friend.steamAvatarUrl}
                      label={friend.displayName}
                    />
                    <div className="player-social-row-main">
                      <div className="player-social-name-line">
                        <strong>{friend.displayName}</strong>
                        <RankmeBadges standing={friend.rankmeStanding} />
                      </div>
                      <span className={`player-status-pill${status.tone === "offline" ? " player-status-pill--muted" : ""}`}>
                        {friendStatusLabel(status.label, t)}
                      </span>
                      {status.tone === "offline" && friend.lastSeenAt ? <span className="player-social-meta">{formatLastSeen(friend.lastSeenAt, t)}</span> : null}
                    </div>
                  </div>
                </Dropdown>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <Modal
        centered
        footer={null}
        open={addOpen}
        title={t("player.friends.add")}
        onCancel={() => {
          setAddOpen(false);
          setQuery("");
          setSearchResults([]);
          setHasSearchedFriends(false);
        }}
      >
        <div className="player-add-friend">
          <div className="player-social-search">
            <Input
              value={query}
              placeholder={t("player.friends.searchUsername")}
              onChange={(event) => {
                setQuery(event.target.value);
                setHasSearchedFriends(false);
              }}
              onPressEnter={() => void handleSearch()}
              disabled={!onSearchFriends}
            />
            <Button aria-label={t("common.actions.search")} type="primary" onClick={() => void handleSearch()} loading={searching} disabled={!onSearchFriends}>
              {t("common.actions.search")}
            </Button>
          </div>

          {searchResults.length > 0 ? (
            <div className="player-social-list">
              {searchResults.map((result) => {
                const status = resolveFriendStatus(result);
                const isSelf = result.accountId === accountId;
                const isFriend = friendIds.has(result.accountId);
                const hasPending = pendingAccountIds.has(result.accountId) || isSelf;
                return (
                  <div className="player-social-row" key={result.accountId}>
                    <SteamAvatar
                      className={`faceit-avatar player-social-avatar--${status.tone}`}
                      avatarUrl={result.steamAvatarUrl}
                      label={result.displayName}
                    />
                    <div className="player-social-row-main">
                      <strong>{result.displayName}</strong>
                      <span className={`player-status-pill${status.tone === "offline" ? " player-status-pill--muted" : ""}`}>
                        {friendStatusLabel(status.label, t)}
                      </span>
                      {status.tone === "offline" && result.lastSeenAt ? <span className="player-social-meta">{formatLastSeen(result.lastSeenAt, t)}</span> : null}
                    </div>
                    <Button
                      aria-label={t("player.friends.sendRequest")}
                      size="small"
                      onClick={() => void handleSendRequest(result.accountId)}
                      disabled={isFriend || hasPending || !onSendFriendRequest}
                      loading={pendingRequestId === result.accountId}
                    >
                      {t("player.friends.sendRequest")}
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : hasSearchedFriends && !searching && searchResults.length === 0 ? (
            <div className="player-empty">{t("common.empty.noSearchResults")}</div>
          ) : null}
        </div>
      </Modal>
    </section>
  );
}
