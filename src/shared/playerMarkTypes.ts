export interface PlayerMarkView {
  accountId: string;
  username: string;
  displayName: string;
  steam64: string;
  abnormalStreak: number;
  marked: boolean;
  markedAt: string | null;
}
