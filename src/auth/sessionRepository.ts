import { ensureJsonFile, readJsonFile, writeJsonFileAtomic } from "../storage/jsonFile.js";

export interface SessionRecord {
  id: string;
  accountId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string;
}

export interface SessionsFile {
  sessions: SessionRecord[];
}

export class JsonSessionRepository {
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly filePath: string) {}

  private enqueueWrite<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  static async create(filePath: string): Promise<JsonSessionRepository> {
    await ensureJsonFile<SessionsFile>(filePath, { sessions: [] });
    return new JsonSessionRepository(filePath);
  }

  async list(): Promise<SessionRecord[]> {
    return (await readJsonFile<SessionsFile>(this.filePath, { sessions: [] })).sessions;
  }

  async saveAll(sessions: SessionRecord[]): Promise<void> {
    await this.enqueueWrite(() => writeJsonFileAtomic(this.filePath, { sessions }));
  }

  async upsert(session: SessionRecord): Promise<SessionRecord> {
    return this.enqueueWrite(async () => {
      const sessions = await this.list();
      const index = sessions.findIndex((item) => item.id === session.id);
      const next = index === -1 || !sessions[index].revokedAt || session.revokedAt
        ? session
        : { ...session, revokedAt: sessions[index].revokedAt };
      if (index === -1) sessions.push(next);
      else sessions[index] = next;
      await writeJsonFileAtomic(this.filePath, { sessions });
      return next;
    });
  }

  async replaceActiveForAccount(session: SessionRecord, revokedAt: string): Promise<SessionRecord> {
    return this.enqueueWrite(async () => {
      const sessions = await this.list();
      const next = sessions.map((item) => {
        if (item.accountId !== session.accountId || item.revokedAt) return item;
        return { ...item, revokedAt };
      });
      next.push(session);
      await writeJsonFileAtomic(this.filePath, { sessions: next });
      return session;
    });
  }

  async insertIfNoActiveForAccount(session: SessionRecord, now: string): Promise<SessionRecord> {
    return this.enqueueWrite(async () => {
      const sessions = await this.list();
      const hasActive = sessions.some((item) => (
        item.accountId === session.accountId &&
        !item.revokedAt &&
        Date.parse(item.expiresAt) > Date.parse(now)
      ));
      if (hasActive) throw new Error("account already logged in");
      sessions.push(session);
      await writeJsonFileAtomic(this.filePath, { sessions });
      return session;
    });
  }

  async updateById(id: string, update: (session: SessionRecord) => SessionRecord | undefined): Promise<SessionRecord | undefined> {
    return this.enqueueWrite(async () => {
      const sessions = await this.list();
      const index = sessions.findIndex((item) => item.id === id);
      if (index === -1) return undefined;
      const next = update(sessions[index]);
      if (!next) return undefined;
      sessions[index] = next;
      await writeJsonFileAtomic(this.filePath, { sessions });
      return next;
    });
  }

  async updateActiveUniqueByTokenHash(tokenHash: string, seenAt: string): Promise<SessionRecord | undefined> {
    return this.enqueueWrite(async () => {
      const sessions = await this.list();
      const index = sessions.findIndex((item) => item.tokenHash === tokenHash);
      if (index === -1) return undefined;
      const current = sessions[index];
      if (current.revokedAt || Date.parse(current.expiresAt) <= Date.parse(seenAt)) return undefined;

      const activeIndexes = sessions
        .map((item, itemIndex) => ({ item, itemIndex }))
        .filter(({ item }) => item.accountId === current.accountId && !item.revokedAt && Date.parse(item.expiresAt) > Date.parse(seenAt))
        .sort((left, right) => Date.parse(left.item.createdAt) - Date.parse(right.item.createdAt));
      const allowedIndex = activeIndexes[0]?.itemIndex;
      for (const { itemIndex } of activeIndexes.slice(1)) {
        sessions[itemIndex] = { ...sessions[itemIndex], revokedAt: seenAt };
      }
      if (index !== allowedIndex) {
        await writeJsonFileAtomic(this.filePath, { sessions });
        return undefined;
      }

      const next = { ...current, lastSeenAt: seenAt };
      sessions[index] = next;
      await writeJsonFileAtomic(this.filePath, { sessions });
      return next;
    });
  }

  async revokeForAccount(accountId: string, revokedAt: string): Promise<number> {
    return this.enqueueWrite(async () => {
      const sessions = await this.list();
      let count = 0;
      const next = sessions.map((session) => {
        if (session.accountId !== accountId || session.revokedAt) return session;
        count += 1;
        return { ...session, revokedAt };
      });
      if (count > 0) await writeJsonFileAtomic(this.filePath, { sessions: next });
      return count;
    });
  }
}
