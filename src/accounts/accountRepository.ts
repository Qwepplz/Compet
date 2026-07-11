import { ensureJsonFile, readJsonFile, writeJsonFileAtomic } from "../storage/jsonFile.js";
import { SerialQueue } from "../storage/serialQueue.js";
import type { AccountRecord, AccountsFile } from "./accountTypes.js";

export class JsonAccountRepository {
  private readonly writeQueue = new SerialQueue();

  private constructor(private readonly filePath: string) {}

  static async create(filePath: string): Promise<JsonAccountRepository> {
    await ensureJsonFile<AccountsFile>(filePath, { accounts: [] });
    return new JsonAccountRepository(filePath);
  }

  async list(): Promise<AccountRecord[]> {
    return (await readJsonFile<AccountsFile>(this.filePath, { accounts: [] })).accounts;
  }

  async saveAll(accounts: AccountRecord[]): Promise<void> {
    await writeJsonFileAtomic(this.filePath, { accounts });
  }

  async findById(id: string): Promise<AccountRecord | undefined> {
    return (await this.list()).find((account) => account.id === id);
  }

  async findByUsername(username: string): Promise<AccountRecord | undefined> {
    return (await this.list()).find((account) => account.username === username);
  }

  async upsert(account: AccountRecord): Promise<AccountRecord> {
    return this.writeQueue.enqueue(async () => {
      const accounts = await this.list();
      const index = accounts.findIndex((existing) => existing.id === account.id);
      if (index === -1) accounts.push(account);
      else accounts[index] = account;
      await this.saveAll(accounts);
      return account;
    });
  }

  async deleteById(id: string): Promise<boolean> {
    return this.writeQueue.enqueue(async () => {
      const accounts = await this.list();
      const next = accounts.filter((account) => account.id !== id);
      if (next.length === accounts.length) return false;
      await this.saveAll(next);
      return true;
    });
  }
}
