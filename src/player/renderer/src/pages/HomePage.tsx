import { Button, Modal, message } from "antd";
import { useState } from "react";
import type { AccountView } from "../../../../manager/shared/types.js";
import type { PlayerFriendListDto, PlayerFriendDto, PlayerPartyDto, PlayerPartyInvitationDto } from "../../../shared/types.js";
import { SteamAvatar } from "../components/SteamAvatar.js";
import { playerAccountLabel } from "../playerDisplay.js";

interface HomePageProps {
  account: AccountView | null;
  friends: PlayerFriendListDto;
  party: PlayerPartyDto | null;
  partyInvitations: PlayerPartyInvitationDto[];
  matchmakingPending?: boolean;
  onInviteFriend?: (accountId: string) => Promise<void>;
  onAcceptPartyInvite?: (invitationId: string) => Promise<void>;
  onDeclinePartyInvite?: (invitationId: string) => Promise<void>;
  onLeaveParty?: () => Promise<void>;
  onStartMatchmaking?: () => Promise<void>;
}

const partyMemberSlotOrder = [3, 1, 4, 0];

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

function memberLabel(accountId: string, account: AccountView | null, friends: PlayerFriendListDto): string {
  return memberDisplay(accountId, account, friends).label;
}

function slotAccountId(index: number, account: AccountView | null, party: PlayerPartyDto | null): string | null {
  if (index === 2) return account?.id ?? null;
  const otherMemberIds = party?.memberAccountIds.filter((memberId) => memberId !== account?.id).slice(0, 4) ?? [];
  const memberIndex = partyMemberSlotOrder.indexOf(index);
  return memberIndex >= 0 ? otherMemberIds[memberIndex] ?? null : null;
}

function canInviteFriend(friend: PlayerFriendDto, party: PlayerPartyDto | null, account: AccountView | null): boolean {
  if (!friend.online) return false;
  if (friend.accountId === account?.id) return false;
  return !(party?.memberAccountIds.includes(friend.accountId) ?? false);
}

export function HomePage({
  account,
  friends,
  party,
  partyInvitations,
  matchmakingPending = false,
  onInviteFriend,
  onAcceptPartyInvite,
  onDeclinePartyInvite,
  onLeaveParty,
  onStartMatchmaking,
}: HomePageProps) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);
  const [busyPartyInvitationId, setBusyPartyInvitationId] = useState<string | null>(null);
  const [leavingParty, setLeavingParty] = useState(false);
  const [matchingPending, setMatchingPending] = useState(false);
  const canStart = Boolean(onStartMatchmaking && (!party || party.ownerAccountId === account?.id));
  const hasSteamBinding = Boolean(account?.steam64?.trim());
  const isMatchmakingPending = matchingPending || matchmakingPending;
  const primaryDisabled = !hasSteamBinding || !canStart || isMatchmakingPending;

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

  async function acceptPartyInvitation(invitationId: string) {
    if (!onAcceptPartyInvite) return;
    setBusyPartyInvitationId(invitationId);
    try {
      await onAcceptPartyInvite(invitationId);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "接受队伍邀请失败");
    } finally {
      setBusyPartyInvitationId(null);
    }
  }

  async function declinePartyInvitation(invitationId: string) {
    if (!onDeclinePartyInvite) return;
    setBusyPartyInvitationId(invitationId);
    try {
      await onDeclinePartyInvite(invitationId);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "拒绝队伍邀请失败");
    } finally {
      setBusyPartyInvitationId(null);
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
      await onStartMatchmaking();
    } finally {
      setMatchingPending(false);
    }
  }

  return (
    <div className="faceit-play">
      <h2 className="player-sr-only">作战中心</h2>
      <div className="faceit-play-hero">
        <div className="faceit-match-summary">
          <span>匹配队列</span>
          <strong>5v5 · BO1</strong>
          <p>Ready check、地图禁选和进服信息会在匹配成功后进入比赛房间。</p>
        </div>
      </div>

      {partyInvitations.length > 0 ? (
        <div className="faceit-invite-list" aria-label="待处理队伍邀请">
          {partyInvitations.map((invitation) => {
            const fromLabel = memberLabel(invitation.fromAccountId, account, friends);
            return (
              <div className="faceit-invite-row" key={invitation.id}>
                <SteamAvatar avatarUrl={memberDisplay(invitation.fromAccountId, account, friends).avatarUrl} label={fromLabel} />
                <div className="faceit-invite-main">
                  <strong>{fromLabel}</strong>
                  <span>邀请你加入队伍</span>
                </div>
                <div className="player-social-row-actions">
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => void acceptPartyInvitation(invitation.id)}
                    loading={busyPartyInvitationId === invitation.id}
                    disabled={!onAcceptPartyInvite}
                  >
                    接受
                  </Button>
                  <Button
                    size="small"
                    onClick={() => void declinePartyInvitation(invitation.id)}
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
      ) : null}

      <div className="faceit-party-stage">
        {[0, 1, 2, 3, 4].map((index) => {
          const memberId = slotAccountId(index, account, party);
          const member = memberId ? memberDisplay(memberId, account, friends) : null;
          const label = member?.label ?? "";
          const isSelf = index === 2;
          return label ? (
            <div className={`faceit-party-slot ${isSelf ? "faceit-party-slot--self" : ""}`} key={index}>
              <SteamAvatar avatarUrl={member?.avatarUrl} label={label} />
              <strong>{label}</strong>
              <span>{isSelf ? (hasSteamBinding ? "已绑定 Steam" : "未绑定 Steam") : "队伍成员"}</span>
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
        <div className="faceit-queue-tabs">
          <strong>匹配</strong>
        </div>
        {!hasSteamBinding ? <div className="faceit-binding-warning">账号未绑定 Steam64，无法匹配</div> : null}
        <div className="faceit-queue-actions">
          {party ? (
            <Button className="faceit-secondary-cta" onClick={() => void leaveParty()} disabled={!onLeaveParty || leavingParty || isMatchmakingPending} loading={leavingParty}>
              退出队伍
            </Button>
          ) : null}
          <Button
            type="primary"
            className="faceit-main-cta"
            onClick={() => void startMatchmaking()}
            disabled={primaryDisabled}
            loading={isMatchmakingPending}
          >
            {isMatchmakingPending ? "正在匹配" : "匹配比赛"}
          </Button>
        </div>
      </div>
    </div>
  );
}
