export type FriendStatusTone = "online" | "offline" | "online-game" | "offline-game";
export type FriendStatusLabel = "online" | "offline" | "inGame";

export interface FriendStatus {
  label: FriendStatusLabel;
  tone: FriendStatusTone;
  inviteable: boolean;
}

export function resolveFriendStatus(friend: { online: boolean; inGame: boolean }): FriendStatus {
  if (friend.inGame) {
    return {
      label: "inGame",
      tone: friend.online ? "online-game" : "offline-game",
      inviteable: false,
    };
  }
  if (friend.online) {
    return { label: "online", tone: "online", inviteable: true };
  }
  return { label: "offline", tone: "offline", inviteable: false };
}
