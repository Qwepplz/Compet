import type { DatabaseSync } from "node:sqlite";
import { withDatabaseTransaction } from "../storage/competDatabase.js";

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

export interface AcceptedFriendRequest {
  request: FriendRequestRecord;
  friendship: FriendshipRecord;
}

export class FriendStore {
  constructor(private readonly database: DatabaseSync) {}

  async listFriendships(): Promise<FriendshipRecord[]> {
    return this.database.prepare(`
      SELECT id, account_a_id, account_b_id, created_at
      FROM friendships
      ORDER BY created_at ASC, id ASC
    `).all().map(friendshipFromRow);
  }

  async listRequests(): Promise<FriendRequestRecord[]> {
    return this.database.prepare(`
      SELECT id, from_account_id, to_account_id, status, created_at, resolved_at
      FROM friend_requests
      ORDER BY created_at ASC, id ASC
    `).all().map(requestFromRow);
  }

  async createRequest(request: FriendRequestRecord): Promise<FriendRequestRecord> {
    try {
      this.database.prepare(`
        INSERT INTO friend_requests (id, from_account_id, to_account_id, status, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        request.id,
        request.fromAccountId,
        request.toAccountId,
        request.status,
        request.createdAt,
        request.resolvedAt ?? null,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("friend_requests_pending_pair_unique")) {
        throw new Error("pending friend request already exists");
      }
      throw error;
    }
    return request;
  }

  async removeFriendship(accountId: string, friendshipId: string): Promise<FriendshipRecord | undefined> {
    return withDatabaseTransaction(this.database, (database) => {
      const row = database.prepare(`
        SELECT id, account_a_id, account_b_id, created_at
        FROM friendships WHERE id = ?
      `).get(friendshipId);
      if (!row) return undefined;
      const friendship = friendshipFromRow(row);
      if (friendship.accountAId !== accountId && friendship.accountBId !== accountId) {
        throw new Error("friendship does not belong to account");
      }
      database.prepare("DELETE FROM friendships WHERE id = ?").run(friendshipId);
      return friendship;
    });
  }

  async acceptRequest(
    accountId: string,
    requestId: string,
    friendship: FriendshipRecord,
  ): Promise<AcceptedFriendRequest> {
    return withDatabaseTransaction(this.database, (database) => {
      const row = database.prepare(`
        SELECT id, from_account_id, to_account_id, status, created_at, resolved_at
        FROM friend_requests WHERE id = ?
      `).get(requestId);
      if (!row) throw new Error(`friend request not found: ${requestId}`);
      const request = requestFromRow(row);
      if (request.toAccountId !== accountId) throw new Error("friend request does not belong to account");
      if (request.status !== "pending") throw new Error("friend request is not pending");
      if (!sameAccountPair(request.fromAccountId, request.toAccountId, friendship.accountAId, friendship.accountBId)) {
        throw new Error("friendship does not match friend request");
      }

      const resolvedAt = friendship.createdAt;
      const updated = database.prepare(`
        UPDATE friend_requests
        SET status = 'accepted', resolved_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(resolvedAt, requestId);
      if (updated.changes !== 1) throw new Error("friend request is not pending");
      try {
        database.prepare(`
          INSERT INTO friendships (id, account_a_id, account_b_id, created_at)
          VALUES (?, ?, ?, ?)
        `).run(friendship.id, friendship.accountAId, friendship.accountBId, friendship.createdAt);
      } catch (error) {
        if (error instanceof Error && error.message.includes("friendships_pair_unique")) {
          throw new Error("friendship already exists");
        }
        throw error;
      }
      return {
        request: { ...request, status: "accepted", resolvedAt },
        friendship,
      };
    });
  }

  async resolveRequest(
    accountId: string,
    requestId: string,
    status: Exclude<FriendRequestRecord["status"], "pending" | "accepted">,
    resolvedAt: string,
  ): Promise<FriendRequestRecord> {
    return withDatabaseTransaction(this.database, (database) => {
      const row = database.prepare(`
        SELECT id, from_account_id, to_account_id, status, created_at, resolved_at
        FROM friend_requests WHERE id = ?
      `).get(requestId);
      if (!row) throw new Error(`friend request not found: ${requestId}`);
      const request = requestFromRow(row);
      if (request.toAccountId !== accountId) throw new Error("friend request does not belong to account");
      if (request.status !== "pending") throw new Error("friend request is not pending");
      const updated = database.prepare(`
        UPDATE friend_requests SET status = ?, resolved_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(status, resolvedAt, requestId);
      if (updated.changes !== 1) throw new Error("friend request is not pending");
      return { ...request, status, resolvedAt };
    });
  }

  async expireRequests(requestIds: string[], resolvedAt: string): Promise<FriendRequestRecord[]> {
    if (requestIds.length === 0) return [];
    return withDatabaseTransaction(this.database, (database) => {
      const expired: FriendRequestRecord[] = [];
      for (const requestId of requestIds) {
        const row = database.prepare(`
          SELECT id, from_account_id, to_account_id, status, created_at, resolved_at
          FROM friend_requests WHERE id = ?
        `).get(requestId);
        if (!row) continue;
        const request = requestFromRow(row);
        if (request.status !== "pending") continue;
        const updated = database.prepare(`
          UPDATE friend_requests SET status = 'expired', resolved_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(resolvedAt, requestId);
        if (updated.changes === 1) expired.push({ ...request, status: "expired", resolvedAt });
      }
      return expired;
    });
  }
}

function friendshipFromRow(row: Record<string, unknown>): FriendshipRecord {
  return {
    id: String(row.id),
    accountAId: String(row.account_a_id),
    accountBId: String(row.account_b_id),
    createdAt: String(row.created_at),
  };
}

function requestFromRow(row: Record<string, unknown>): FriendRequestRecord {
  return {
    id: String(row.id),
    fromAccountId: String(row.from_account_id),
    toAccountId: String(row.to_account_id),
    status: row.status as FriendRequestRecord["status"],
    createdAt: String(row.created_at),
    ...(row.resolved_at === null ? {} : { resolvedAt: String(row.resolved_at) }),
  };
}

function sameAccountPair(leftA: string, leftB: string, rightA: string, rightB: string): boolean {
  return (leftA === rightA && leftB === rightB) || (leftA === rightB && leftB === rightA);
}
