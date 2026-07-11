import { randomUUID } from "node:crypto";
import type { AccountRecord } from "../accounts/accountTypes.js";
import type { AccountService } from "../accounts/accountService.js";
import type { PresenceService } from "../presence/presenceService.js";
import type { RealtimeEvent } from "../realtime/realtimeTypes.js";
import { FriendStore, type FriendRequestRecord, type FriendshipRecord } from "./friendStore.js";

interface FriendEventPublisher {
  publish(event: RealtimeEvent): void;
}

export interface FriendSearchResult {
  accountId: string;
  displayName: string;
  steam64: string;
  steamPersonaName?: string;
  steamAvatarUrl?: string;
  online: boolean;
  lastSeenAt?: string;
}

export interface FriendDto extends FriendSearchResult {
  friendshipId: string;
  createdAt: string;
}

export interface FriendRequestDto extends FriendSearchResult {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  status: FriendRequestRecord["status"];
  createdAt: string;
  resolvedAt?: string;
}

export interface FriendListDto {
  friends: FriendDto[];
  incomingRequests: FriendRequestDto[];
  outgoingRequests: FriendRequestDto[];
}

interface FriendServiceDeps {
  store: FriendStore;
  accounts: AccountService;
  presence: PresenceService;
  events?: FriendEventPublisher;
  now?: () => string;
  idFactory?: () => string;
}

export class FriendService {
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(private readonly deps: FriendServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.idFactory = deps.idFactory ?? randomUUID;
  }

  async search(accountId: string, query: string): Promise<FriendSearchResult[]> {
    await this.requireEnabledAccount(accountId);
    const normalizedQuery = normalizeFriendSearchQuery(query);
    if (normalizedQuery.length === 0) return [];

    const accounts = (await this.deps.accounts.listAccounts())
      .filter(
        (account) =>
          account.enabled &&
          account.id !== accountId &&
          accountMatchesSearch(account, normalizedQuery),
      )
      .sort((left, right) => left.username.localeCompare(right.username));

    return accounts.map((account) => this.toSearchResult(account));
  }

  listFriends(accountId: string): Promise<FriendListDto> {
    return this.enqueueMutation(async () => {
      await this.requireEnabledAccount(accountId);
      await this.expireDisconnectedRequestsInternal(new Set([accountId]));
      return this.buildFriendList(accountId);
    });
  }

  removeFriend(accountId: string, friendshipId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.requireEnabledAccount(accountId);
      const friendships = await this.deps.store.listFriendships();
      const friendship = friendships.find((record) => record.id === friendshipId);
      if (!friendship) throw new Error(`friendship not found: ${friendshipId}`);
      if (friendship.accountAId !== accountId && friendship.accountBId !== accountId) {
        throw new Error("friendship does not belong to account");
      }

      await this.deps.store.saveFriendships(friendships.filter((record) => record.id !== friendshipId));
      this.publish({ type: "friend_list_refresh", accountId: friendship.accountAId });
      this.publish({ type: "friend_list_refresh", accountId: friendship.accountBId });
    });
  }

  sendRequest(fromAccountId: string, toAccountId: string): Promise<FriendRequestDto> {
    return this.enqueueMutation(async () => {
      const fromAccount = await this.requireEnabledAccount(fromAccountId);
      const toAccount = await this.requireEnabledAccount(toAccountId);

      if (fromAccountId === toAccountId) throw new Error("cannot send friend request to self");
      const requests = await this.expireDisconnectedRequestsInternal(new Set([fromAccountId, toAccountId]));
      const friendships = await this.deps.store.listFriendships();

      if (this.hasFriendship(friendships, fromAccountId, toAccountId)) throw new Error("friendship already exists");
      if (this.hasPendingRequest(requests, fromAccountId, toAccountId)) throw new Error("pending friend request already exists");

      const request: FriendRequestRecord = {
        id: this.idFactory(),
        fromAccountId,
        toAccountId,
        status: "pending",
        createdAt: this.now(),
      };

      await this.deps.store.saveRequests([...requests, request]);

      const accounts = new Map<string, AccountRecord>([
        [fromAccount.id, fromAccount],
        [toAccount.id, toAccount],
      ]);
      this.publish({
        type: "friend_request_received",
        accountId: toAccountId,
        request: this.toRequestDto(request, toAccountId, accounts),
      });
      this.publish({ type: "friend_list_refresh", accountId: fromAccountId });
      this.publish({ type: "friend_list_refresh", accountId: toAccountId });
      return this.toRequestDto(request, fromAccountId, accounts);
    });
  }

  acceptRequest(accountId: string, requestId: string): Promise<FriendListDto> {
    return this.enqueueMutation(async () => {
      await this.requireEnabledAccount(accountId);
      const requests = await this.expireDisconnectedRequestsInternal(new Set([accountId]));
      const requestIndex = requests.findIndex((request) => request.id === requestId);
      if (requestIndex === -1) throw new Error(`friend request not found: ${requestId}`);

      const request = requests[requestIndex];
      if (request.toAccountId !== accountId) throw new Error("friend request does not belong to account");
      if (request.status !== "pending") throw new Error("friend request is not pending");

      const friendships = await this.deps.store.listFriendships();
      if (this.hasFriendship(friendships, request.fromAccountId, request.toAccountId)) throw new Error("friendship already exists");

      const resolvedAt = this.now();
      const acceptedRequest: FriendRequestRecord = { ...request, status: "accepted", resolvedAt };
      const nextRequests = [...requests];
      nextRequests[requestIndex] = acceptedRequest;
      const friendship: FriendshipRecord = {
        id: this.idFactory(),
        accountAId: request.fromAccountId,
        accountBId: request.toAccountId,
        createdAt: resolvedAt,
      };
      const nextFriendships = [...friendships, friendship];

      await this.deps.store.saveRequests(nextRequests);
      await this.deps.store.saveFriendships(nextFriendships);

      const accounts = await this.loadAccountMap();
      this.publishRequestResolved(acceptedRequest, accounts);
      this.publish({ type: "friend_list_refresh", accountId: request.fromAccountId });
      this.publish({ type: "friend_list_refresh", accountId: request.toAccountId });
      return this.buildFriendList(accountId, nextFriendships, nextRequests, accounts);
    });
  }

  declineRequest(accountId: string, requestId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.requireEnabledAccount(accountId);
      const requests = await this.expireDisconnectedRequestsInternal(new Set([accountId]));
      const requestIndex = requests.findIndex((request) => request.id === requestId);
      if (requestIndex === -1) throw new Error(`friend request not found: ${requestId}`);

      const request = requests[requestIndex];
      if (request.toAccountId !== accountId) throw new Error("friend request does not belong to account");
      if (request.status !== "pending") throw new Error("friend request is not pending");

      const declinedRequest: FriendRequestRecord = {
        ...request,
        status: "declined",
        resolvedAt: this.now(),
      };
      const nextRequests = [...requests];
      nextRequests[requestIndex] = declinedRequest;

      await this.deps.store.saveRequests(nextRequests);

      const accounts = await this.loadAccountMap();
      this.publishRequestResolved(declinedRequest, accounts);
      this.publish({ type: "friend_list_refresh", accountId: request.fromAccountId });
      this.publish({ type: "friend_list_refresh", accountId: request.toAccountId });
    });
  }

  expireDisconnectedRequests(accountId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.requireEnabledAccount(accountId);
      await this.expireDisconnectedRequestsInternal(new Set([accountId]));
    });
  }

  private async buildFriendList(
    accountId: string,
    friendships?: FriendshipRecord[],
    requests?: FriendRequestRecord[],
    accounts?: Map<string, AccountRecord>,
  ): Promise<FriendListDto> {
    const currentFriendships = friendships ?? (await this.deps.store.listFriendships());
    const currentRequests = requests ?? (await this.deps.store.listRequests());
    const currentAccounts = accounts ?? (await this.loadAccountMap());
    const friends = friendships
      ?? currentFriendships;
    const mappedFriends = friends
      .filter((record) => record.accountAId === accountId || record.accountBId === accountId)
      .map((record) => {
        const friendAccountId = record.accountAId === accountId ? record.accountBId : record.accountAId;
        const account = currentAccounts.get(friendAccountId);
        if (!account || !account.enabled) return undefined;
        return {
          ...this.toSearchResult(account),
          friendshipId: record.id,
          createdAt: record.createdAt,
        } satisfies FriendDto;
      })
      .filter((record): record is FriendDto => record !== undefined)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));

    const incomingRequests = currentRequests
      .filter((record) => record.status === "pending" && record.toAccountId === accountId)
      .map((record) => this.toRequestDto(record, accountId, currentAccounts))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));

    const outgoingRequests = currentRequests
      .filter((record) => record.status === "pending" && record.fromAccountId === accountId)
      .map((record) => this.toRequestDto(record, accountId, currentAccounts))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));

    return { friends: mappedFriends, incomingRequests, outgoingRequests };
  }

  private async expireDisconnectedRequestsInternal(accountIds: Set<string>): Promise<FriendRequestRecord[]> {
    const requests = await this.deps.store.listRequests();
    const accounts = await this.loadAccountMap();
    const expiredRequests: FriendRequestRecord[] = [];
    const nextRequests = requests.map((request) => {
      if (request.status !== "pending") return request;
      if (!accountIds.has(request.fromAccountId) && !accountIds.has(request.toAccountId)) return request;
      if (!this.isDisconnectedRequest(request, accounts)) return request;

      const expiredRequest: FriendRequestRecord = {
        ...request,
        status: "expired",
        resolvedAt: this.now(),
      };
      expiredRequests.push(expiredRequest);
      return expiredRequest;
    });

    if (expiredRequests.length === 0) return requests;

    await this.deps.store.saveRequests(nextRequests);
    for (const request of expiredRequests) {
      this.publishRequestResolved(request, accounts);
      this.publish({ type: "friend_list_refresh", accountId: request.fromAccountId });
      this.publish({ type: "friend_list_refresh", accountId: request.toAccountId });
    }
    return nextRequests;
  }

  private publishRequestResolved(request: FriendRequestRecord, accounts: Map<string, AccountRecord>): void {
    this.publish({
      type: "friend_request_resolved",
      accountId: request.fromAccountId,
      request: this.toRequestDto(request, request.fromAccountId, accounts),
    });
    this.publish({
      type: "friend_request_resolved",
      accountId: request.toAccountId,
      request: this.toRequestDto(request, request.toAccountId, accounts),
    });
  }

  private isDisconnectedRequest(request: FriendRequestRecord, accounts: Map<string, AccountRecord>): boolean {
    const fromAccount = accounts.get(request.fromAccountId);
    const toAccount = accounts.get(request.toAccountId);
    if (!fromAccount?.enabled || !toAccount?.enabled) return true;
    return false;
  }

  private hasFriendship(records: FriendshipRecord[], accountAId: string, accountBId: string): boolean {
    return records.some(
      (record) =>
        (record.accountAId === accountAId && record.accountBId === accountBId) ||
        (record.accountAId === accountBId && record.accountBId === accountAId),
    );
  }

  private hasPendingRequest(records: FriendRequestRecord[], accountAId: string, accountBId: string): boolean {
    return records.some(
      (record) =>
        record.status === "pending" &&
        ((record.fromAccountId === accountAId && record.toAccountId === accountBId) ||
          (record.fromAccountId === accountBId && record.toAccountId === accountAId)),
    );
  }

  private async requireEnabledAccount(accountId: string): Promise<AccountRecord> {
    const account = await this.deps.accounts.getById(accountId);
    if (!account) throw new Error(`account not found: ${accountId}`);
    if (!account.enabled) throw new Error(`account disabled: ${accountId}`);
    return account;
  }

  private async loadAccountMap(): Promise<Map<string, AccountRecord>> {
    return new Map((await this.deps.accounts.listAccounts()).map((account) => [account.id, account]));
  }

  private toSearchResult(account: AccountRecord): FriendSearchResult {
    const presence = this.deps.presence.get(account.id);
    const steam64 = account.steam64.trim();
    return {
      accountId: account.id,
      displayName: steam64 || "玩家",
      steam64,
      online: presence.online,
      lastSeenAt: presence.lastSeenAt,
    };
  }

  private toRequestDto(
    request: FriendRequestRecord,
    perspectiveAccountId: string,
    accounts: Map<string, AccountRecord>,
  ): FriendRequestDto {
    const counterpartId = request.fromAccountId === perspectiveAccountId ? request.toAccountId : request.fromAccountId;
    const counterpart = accounts.get(counterpartId);
    if (!counterpart) throw new Error(`account not found: ${counterpartId}`);
    return {
      ...this.toSearchResult(counterpart),
      id: request.id,
      fromAccountId: request.fromAccountId,
      toAccountId: request.toAccountId,
      status: request.status,
      createdAt: request.createdAt,
      resolvedAt: request.resolvedAt,
    };
  }

  private publish(event: RealtimeEvent): void {
    this.deps.events?.publish(event);
  }

  private enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(run, run);
    this.mutationQueue = next.catch(() => undefined);
    return next;
  }
}

function normalizeFriendSearchQuery(query: string): string {
  return query.trim();
}

function accountMatchesSearch(account: AccountRecord, normalizedQuery: string): boolean {
  return account.username.trim().includes(normalizedQuery);
}
