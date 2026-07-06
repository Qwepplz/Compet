import { Button, Modal, Spin, message } from "antd";
import { useEffect, useState } from "react";
import type { AccountView } from "../../../../manager/shared/types.js";
import type { PlayerFriendListDto, PlayerFriendDto, PlayerPartyDto } from "../../../shared/types.js";
import { SteamAvatar } from "../components/SteamAvatar.js";
import { VerificationBadge } from "../components/VerificationBadge.js";
import { formatMatchmakingElapsed } from "../matchTimers.js";
import { playerAccountLabel } from "../playerDisplay.js";

interface HomePageProps {
  account: AccountView | null;
  friends: PlayerFriendListDto;
  party: PlayerPartyDto | null;
  matchmakingPending?: boolean;
  matchmakingPendingStartedAt?: string | null;
  matchmakingOccupancyActiveCount?: number;
  devModeEnabled?: boolean;
  onInviteFriend?: (accountId: string) => Promise<void>;
  onLeaveParty?: () => Promise<void>;
  onStartMatchmaking?: (options?: { dev?: boolean }) => Promise<void>;
}

const partyMemberSlotOrder = [3, 1, 4, 0];
const PARTY_SLOT_COUNT = 5;

function memberDisplay(accountId: string, account: AccountView | null, friends: PlayerFriendListDto): { label: string; avatarUrl?: string } {
  if (accountId === account?.id) {
    return { label: playerAccountLabel(account), avatarUrl: account.steamAvatarUrl };
  }
  const friend = friends.friends.find((entry) => entry.accountId === accountId);
  return {
    label: friend?.steamPersonaName ?? friend?.displayName ?? "玩家",
    avatarUrl: friend?.steamAvatarUrl,
  };
}

function slotAccountId(index: number, account: AccountView | null, party: PlayerPartyDto | null): string | null {
  if (index === 2) return account?.id ?? null;
  const otherMemberIds = party?.memberAccountIds.filter((memberId) => memberId !== account?.id).slice(0, PARTY_SLOT_COUNT - 1) ?? [];
  const memberIndex = partyMemberSlotOrder.indexOf(index);
  return memberIndex >= 0 ? otherMemberIds[memberIndex] ?? null : null;
}

function canInviteFriend(friend: PlayerFriendDto, party: PlayerPartyDto | null, account: AccountView | null): boolean {
  if (!friend.online) return false;
  if (friend.accountId === account?.id) return false;
  if (party && party.memberAccountIds.length >= PARTY_SLOT_COUNT) return false;
  return !(party?.memberAccountIds.includes(friend.accountId) ?? false);
}

export function HomePage({
  account,
  friends,
  party,
  matchmakingPending = false,
  matchmakingPendingStartedAt = null,
  matchmakingOccupancyActiveCount = 0,
  devModeEnabled = false,
  onInviteFriend,
  onLeaveParty,
  onStartMatchmaking,
}: HomePageProps) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);
  const [leavingParty, setLeavingParty] = useState(false);
  const [matchingPending, setMatchingPending] = useState(false);
  const [matchingStartedAt, setMatchingStartedAt] = useState<number | null>(null);
  const [matchingNowMs, setMatchingNowMs] = useState(() => Date.now());
  const canStart = Boolean(onStartMatchmaking && (!party || party.ownerAccountId === account?.id));
  const hasSteamBinding = Boolean(account?.steam64?.trim());
  const isMatchmakingPending = matchingPending || matchmakingPending;
  const occupancyActiveCount = Math.max(0, matchmakingOccupancyActiveCount);
  const isMatchmakingOccupied = occupancyActiveCount > 0;
  const primaryDisabled = !hasSteamBinding || !canStart || isMatchmakingPending || isMatchmakingOccupied;
  const matchingElapsedMs = matchingStartedAt ? matchingNowMs - matchingStartedAt : 0;

  useEffect(() => {
    if (!isMatchmakingPending) {
      setMatchingStartedAt(null);
      return;
    }
    const syncedStartedAt = matchmakingPendingStartedAt ? Date.parse(matchmakingPendingStartedAt) : NaN;
    const startedAt = Number.isFinite(syncedStartedAt) ? syncedStartedAt : Date.now();
    setMatchingStartedAt(startedAt);
    setMatchingNowMs(startedAt);
    const timer = window.setInterval(() => setMatchingNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [isMatchmakingPending, matchmakingPendingStartedAt]);

  async function inviteFriend(accountId: string) {
    if (!onInviteFriend) return;
    setBusyInviteId(accountId);
    try {
      await onInviteFriend(accountId);
      setInviteOpen(false);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "发送队伍邀请失败");
    } finally {
      setBusyInviteId(null);
    }
  }

  async function leaveParty() {
    if (!onLeaveParty) return;
    setLeavingParty(true);
    try {
      await onLeaveParty();
    } finally {
      setLeavingParty(false);
    }
  }

  async function startMatchmaking() {
    if (!onStartMatchmaking || isMatchmakingPending) return;
    setMatchingPending(true);
    try {
      await onStartMatchmaking(account?.dev ? { dev: devModeEnabled } : undefined);
    } finally {
      setMatchingPending(false);
    }
  }

  return (
    <div className="faceit-play">
      <h2 className="player-sr-only">作战中心</h2>

      <div className="faceit-party-stage">
        {[0, 1, 2, 3, 4].map((index) => {
          const memberId = slotAccountId(index, account, party);
          const member = memberId ? memberDisplay(memberId, account, friends) : null;
          const label = member?.label ?? "";
          const isSelf = index === 2;
          const isCaptain = Boolean(memberId && party?.ownerAccountId === memberId);
          return label ? (
            <div className={`faceit-party-slot ${isSelf ? "faceit-party-slot--self" : ""}`} key={index}>
              <SteamAvatar avatarUrl={member?.avatarUrl} label={label} />
              <div className="faceit-party-slot-name">
                <strong>{label}</strong>
                <VerificationBadge variant="gold" title="Player" />
                {isCaptain ? (
                  <span className="faceit-captain-badge" aria-label="队长" title="队长">
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path
                        fillRule="evenodd"
                        clipRule="evenodd"
                        d="M7.5 9.333L3 4v10.667h18V4l-4.5 5.333L12 4 7.5 9.333zM21 20v-2.667H3V20h18z"
                        fill="currentColor"
                      />
                    </svg>
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="faceit-party-slot"
              aria-label="邀请好友"
              onClick={() => setInviteOpen(true)}
              disabled={!onInviteFriend}
              key={index}
            >
              <span className="faceit-plus">+</span>
            </button>
          );
        })}
      </div>

      <Modal
        centered
        footer={null}
        open={inviteOpen}
        title="邀请好友"
        className="faceit-invite-modal"
        onCancel={() => setInviteOpen(false)}
      >
        <div className="faceit-invite-list">
          {friends.friends.length > 0 ? (
            friends.friends.map((friend) => {
              const label = friend.displayName || "玩家";
              const inviteEnabled = Boolean(onInviteFriend && canInviteFriend(friend, party, account));
              return (
                <div className="faceit-invite-row" key={friend.friendshipId}>
                  <SteamAvatar avatarUrl={friend.steamAvatarUrl} label={label} />
                  <div className="faceit-invite-main">
                    <strong>{label}</strong>
                    <span>{friend.online ? "在线" : "离线"}</span>
                  </div>
                  <Button
                    aria-label={`邀请 ${label}`}
                    type="primary"
                    onClick={() => void inviteFriend(friend.accountId)}
                    loading={busyInviteId === friend.accountId}
                    disabled={!inviteEnabled}
                  >
                    邀请
                  </Button>
                </div>
              );
            })
          ) : (
            <div className="player-empty">暂无好友。</div>
          )}
        </div>
      </Modal>

      <div className="faceit-queue-bar">
        {!hasSteamBinding ? <div className="faceit-binding-warning">账号未绑定 Steam64，无法匹配</div> : null}
        <div className="faceit-queue-actions">
          <Button
            type="primary"
            className="faceit-main-cta"
            onClick={() => void startMatchmaking()}
            disabled={primaryDisabled}
          >
            <span className="faceit-matchmaking-content">
              <span>{isMatchmakingPending ? "正在匹配" : "开始匹配"}</span>
              {isMatchmakingPending ? (
                <span className="faceit-matchmaking-indicator" aria-live="polite">
                  <Spin size="small" />
                  <span>{formatMatchmakingElapsed(matchingElapsedMs)}</span>
                </span>
              ) : null}
            </span>
          </Button>
          <div
            className={`faceit-occupancy-indicator faceit-occupancy-indicator--${isMatchmakingOccupied ? "busy" : "available"}`}
            aria-label={`游戏房间占用 ${occupancyActiveCount}`}
            title={`游戏房间占用 ${occupancyActiveCount}`}
          >
            <span className="faceit-occupancy-dot" />
            <span className="faceit-occupancy-count">{occupancyActiveCount}</span>
          </div>
          {party ? (
            <Button
              className="faceit-secondary-cta"
              aria-label="退出队伍"
              title="退出队伍"
              onClick={() => void leaveParty()}
              disabled={!onLeaveParty || leavingParty || isMatchmakingPending}
              loading={leavingParty}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M16.05 7l-1.405 1.405L17.24 11H9v2h8.14l-2.495 2.495L16.05 16.9 21 11.95 16.05 7zM16 21v-2H5V5h11V3H3v18h13z"
                  fill="currentColor"
                />
              </svg>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
