import { ensureJsonFile, readJsonFile, writeJsonFileAtomic } from "../storage/jsonFile.js";
import type { AccountRecord, AccountsFile } from "./accountTypes.js";

export class JsonAccountRepository {
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly filePath: string) {}

  private enqueueWrite<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

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
    const normalized = username.toLowerCase();
    return (await this.list()).find((account) => account.username.toLowerCase() === normalized);
  }

  async upsert(account: AccountRecord): Promise<AccountRecord> {
    return this.enqueueWrite(async () => {
      const accounts = await this.list();
      const index = accounts.findIndex((existing) => existing.id === account.id);
      if (index === -1) accounts.push(account);
      else accounts[index] = account;
      await this.saveAll(accounts);
      return account;
    });
  }
}
