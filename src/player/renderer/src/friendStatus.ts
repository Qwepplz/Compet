export type FriendStatusTone = "online" | "offline" | "online-game" | "offline-game";

export interface FriendStatus {
  label: "在线" | "离线" | "游戏中";
  tone: FriendStatusTone;
  inviteable: boolean;
}

export function resolveFriendStatus(friend: { online: boolean; inGame: boolean }): FriendStatus {
  if (friend.inGame) {
    return {
      label: "游戏中",
      tone: friend.online ? "online-game" : "offline-game",
      inviteable: false,
    };
  }
  if (friend.online) {
    return { label: "在线", tone: "online", inviteable: true };
  }
  return { label: "离线", tone: "offline", inviteable: false };
}
