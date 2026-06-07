import crypto from "node:crypto";
import { hashPassword } from "../auth/passwordHasher.js";
import { SerialQueue } from "../storage/serialQueue.js";
import type { AccountRecord, AccountRole } from "./accountTypes.js";
import type { JsonAccountRepository } from "./accountRepository.js";

export interface CreateAccountInput {
  username: string;
  password: string;
  role: AccountRole;
  steam64?: string;
  mustChangePassword: boolean;
  displayName?: string;
}

export interface UpdateAccountInput {
  steam64?: string;
  enabled?: boolean;
  dev?: boolean;
}

function normalizeSteam64(role: AccountRole, steam64: string | undefined): string {
  if (role === "admin") return "";
  return steam64?.trim() ?? "";
}

export class AccountService {
  private readonly mutationQueue = new SerialQueue();

  constructor(private readonly repository: JsonAccountRepository) {}

  listAccounts(): Promise<AccountRecord[]> {
    return this.repository.list();
  }

  getById(id: string): Promise<AccountRecord | undefined> {
    return this.repository.findById(id);
  }

  getByUsername(username: string): Promise<AccountRecord | undefined> {
    return this.repository.findByUsername(username);
  }

  async createAccount(input: CreateAccountInput): Promise<AccountRecord> {
    return this.mutationQueue.enqueue(async () => {
      if (await this.repository.findByUsername(input.username)) throw new Error("username already exists");
      const now = new Date().toISOString();
      return this.repository.upsert({
        id: crypto.randomUUID(),
        username: input.username,
        displayName: input.displayName?.trim() || input.username,
        steam64: normalizeSteam64(input.role, input.steam64),
        role: input.role,
        enabled: true,
        dev: false,
        passwordHash: await hashPassword(input.password),
        mustChangePassword: input.mustChangePassword,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      });
    });
  }

  async updateAccount(id: string, input: UpdateAccountInput): Promise<AccountRecord> {
    return this.mutationQueue.enqueue(async () => {
      const account = await this.repository.findById(id);
      if (!account) throw new Error("account not found");
      const nextSteam64 = Object.prototype.hasOwnProperty.call(input, "steam64") ? input.steam64 : account.steam64;
      return this.repository.upsert({
        ...account,
        ...input,
        steam64: normalizeSteam64(account.role, nextSteam64),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async resetPassword(id: string, password: string): Promise<AccountRecord> {
    return this.mutationQueue.enqueue(async () => {
      const account = await this.repository.findById(id);
      if (!account) throw new Error("account not found");
      return this.repository.upsert({
        ...account,
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async deleteAccount(id: string): Promise<AccountRecord> {
    return this.mutationQueue.enqueue(async () => {
      const account = await this.repository.findById(id);
      if (!account) throw new Error("account not found");
      if (account.role === "admin") throw new Error("admin account cannot be deleted");
      await this.repository.deleteById(id);
      return account;
    });
  }

  async setPasswordHash(id: string, passwordHash: string, mustChangePassword: boolean): Promise<AccountRecord> {
    return this.mutationQueue.enqueue(async () => {
      const account = await this.repository.findById(id);
      if (!account) throw new Error("account not found");
      return this.repository.upsert({ ...account, passwordHash, mustChangePassword, updatedAt: new Date().toISOString() });
    });
  }

  async markLogin(id: string): Promise<AccountRecord | undefined> {
    return this.mutationQueue.enqueue(async () => {
      const account = await this.repository.findById(id);
      if (!account) return undefined;
      const now = new Date().toISOString();
      return this.repository.upsert({ ...account, lastLoginAt: now, updatedAt: now });
    });
  }
}
