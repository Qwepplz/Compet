export type AccountRole = "admin" | "player";

export const USERNAME_PATTERN = /^[A-Za-z0-9]+$/;

export interface AccountRecord {
  id: string;
  username: string;
  displayName: string;
  steam64: string;
  role: AccountRole;
  enabled: boolean;
  dev?: boolean;
  passwordHash: string;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}
