import path from "node:path";
import { ensureJsonFile, readJsonFile, writeJsonFileAtomic } from "../storage/jsonFile.js";

export interface FriendshipRecord {
  id: string;
  accountAId: string;
  accountBId: string;
  createdAt: string;
}

export interface FriendRequestRecord {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  status: "pending" | "accepted" | "declined" | "expired";
  createdAt: string;
  resolvedAt?: string;
}

interface FriendshipsFile {
  friendships: FriendshipRecord[];
}

interface FriendRequestsFile {
  requests: FriendRequestRecord[];
}

export class FriendStore {
  private friendshipWrites: Promise<void> = Promise.resolve();
  private requestWrites: Promise<void> = Promise.resolve();

  private constructor(private readonly dir: string) {}

  static async create(dir: string): Promise<FriendStore> {
    const store = new FriendStore(dir);
    await Promise.all([
      ensureJsonFile<FriendshipsFile>(store.friendshipsPath, { friendships: [] }),
      ensureJsonFile<FriendRequestsFile>(store.requestsPath, { requests: [] }),
    ]);
    return store;
  }

  listFriendships(): Promise<FriendshipRecord[]> {
    return readJsonFile<FriendshipsFile>(this.friendshipsPath, { friendships: [] }).then((file) => file.friendships);
  }

  saveFriendships(records: FriendshipRecord[]): Promise<void> {
    return this.enqueueFriendshipWrite(() => writeJsonFileAtomic(this.friendshipsPath, { friendships: records }));
  }

  listRequests(): Promise<FriendRequestRecord[]> {
    return readJsonFile<FriendRequestsFile>(this.requestsPath, { requests: [] }).then((file) => file.requests);
  }

  saveRequests(records: FriendRequestRecord[]): Promise<void> {
    return this.enqueueRequestWrite(() => writeJsonFileAtomic(this.requestsPath, { requests: records }));
  }

  private get friendshipsPath(): string {
    return path.join(this.dir, "friendships.json");
  }

  private get requestsPath(): string {
    return path.join(this.dir, "requests.json");
  }

  private enqueueFriendshipWrite(write: () => Promise<void>): Promise<void> {
    const next = this.friendshipWrites.then(write, write);
    this.friendshipWrites = next.catch(() => undefined);
    return next;
  }

  private enqueueRequestWrite(write: () => Promise<void>): Promise<void> {
    const next = this.requestWrites.then(write, write);
    this.requestWrites = next.catch(() => undefined);
    return next;
  }
}
