import { randomUUID } from "node:crypto";
import type { AccountService } from "../accounts/accountService.js";
import type { AccountRecord } from "../accounts/accountTypes.js";
import type { BotCatalog } from "../bots/botCatalog.js";
import type { FriendListDto } from "../friends/friendService.js";
import type { GameServerExitInfo } from "../game/gameServerLauncher.js";
import type { MatchConnectInfo } from "../game/matchExecutor.js";
import type { RealtimeEvent } from "../realtime/realtimeTypes.js";
import type { MatchRecordStore } from "../records/matchRecordStore.js";
import { assignDevTeams, assignTeams } from "./teamAssignment.js";
import type { MatchParticipant, MatchPlan } from "./types.js";
import {
  MatchmakingStore,
  type MatchMapSelectionState,
  type MatchRoomReadyState,
  type MatchRoomRecord,
  type PartyInvitationRecord,
  type PartyRecord,
  type QueueEntry,
} from "./matchmakingStore.js";

const DEFAULT_MAP_POOL = ["de_mirage", "de_inferno", "de_nuke", "de_overpass", "de_dust2", "de_ancient", "de_anubis"];
const MAP_RANDOMIZATION_MS = 7_000;
const MAP_RANDOMIZATION_REEL_LENGTH = 20;
const RECENT_MAP_EXCLUSION_COUNT = 3;
const MAX_PARTY_HUMANS = 5;
const PARTY_INVITE_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 45_000;

const TERMINAL_ROOM_MEMORY_TTL_MS = 60 * 60 * 1000;

function isSoloOpenParty(party: PartyRecord): boolean {
  return (party.status ?? "open") === "open" && party.memberAccountIds.length === 1;
}
type ReadyTimeoutHandle = ReturnType<typeof setTimeout>;
type ReadyTimeoutScheduler = (handler: () => void, timeoutMs: number) => ReadyTimeoutHandle;
type ReadyTimeoutCanceler = (handle: ReadyTimeoutHandle) => void;

export type PartyInvitationDto = PartyInvitationRecord;

export interface MatchExecutorPort {
  prepare(plan: MatchPlan): Promise<MatchConnectInfo>;
}

export interface MatchmakingServiceDeps {
  store: MatchmakingStore;
  accounts: AccountService;
  friends?: { listFriends(accountId: string): Promise<FriendListDto> };
  botCatalog: BotCatalog;
  executor?: MatchExecutorPort;
  records?: Pick<MatchRecordStore, "appendEvent" | "listRecentMatchMaps" | "readMatchPlan" | "saveMatchPlan" | "saveStatus">;
  events?: { publish(event: RealtimeEvent): void };
  mapPool?: string[];
  now?: () => string;
  idFactory?: () => string;
  random?: () => number;
  setTimeout?: ReadyTimeoutScheduler;
  clearTimeout?: ReadyTimeoutCanceler;
  unrefReadyTimeouts?: boolean;
}

export interface PublicMatchRoomRecord {
  id: string;
  phase: MatchRoomRecord["phase"];
  teamA: MatchRoomRecord["teamA"];
  teamB: MatchRoomRecord["teamB"];
  humanAccountIds?: string[];
  botParticipantIds?: string[];
  ready?: MatchRoomReadyState[];
  readyDeadlineAt?: string;
  partyId?: string;
  mapSelection?: MatchMapSelectionState;
  connect?: MatchConnectInfo;
  createdAt: string;
}

export class MatchmakingService {
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly random?: () => number;
  private readonly setTimeoutFn: ReadyTimeoutScheduler;
  private readonly clearTimeoutFn: ReadyTimeoutCanceler;
  private readonly unrefReadyTimeouts: boolean;
  private readonly partyInviteTimeouts = new Map<string, ReadyTimeoutHandle>();
  private readonly readyTimeouts = new Map<string, ReadyTimeoutHandle>();
  private readonly mapSelectionTimeouts = new Map<string, ReadyTimeoutHandle>();
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: MatchmakingServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.idFactory = deps.idFactory ?? randomUUID;
    this.random = deps.random;
    this.setTimeoutFn = deps.setTimeout ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeout ?? clearTimeout;
    this.unrefReadyTimeouts = deps.unrefReadyTimeouts ?? true;
  }
  createParty(ownerAccountId: string): Promise<PartyRecord> {
    return this.enqueueMutation(async () => {
      await this.requireAccount(ownerAccountId);
      const parties = await this.deps.store.listParties();
      const existing = parties.find((candidate) => candidate.memberAccountIds.includes(ownerAccountId));
      if (existing) return existing;
      const now = this.now();
      const party: PartyRecord = {
        id: this.idFactory(),
        ownerAccountId,
        memberAccountIds: [ownerAccountId],
        createdAt: now,
        updatedAt: now,
        status: "open",
      };

      await this.deps.store.saveParties([...parties, party]);
      await this.expirePendingInvitationsForAccount(ownerAccountId);
      await this.emitPartyUpdated(party);
      return party;
    });
  }

  async getPartyForAccount(accountId: string): Promise<PartyRecord | undefined> {
    await this.requireAccount(accountId);
    const parties = await this.deps.store.listParties();
    return parties.find((party) => party.memberAccountIds.includes(accountId) && !isSoloOpenParty(party));
  }

  joinParty(partyId: string, accountId: string): Promise<PartyRecord> {
    return this.enqueueMutation(async () => {
      await this.requireAccount(accountId);
      const parties = await this.deps.store.listParties();
      const party = parties.find((candidate) => candidate.id === partyId);
      if (!party) throw new Error(`party not found: ${partyId}`);
      this.requireOpenParty(party);
      if (party.memberAccountIds.includes(accountId)) return party;
      if (parties.some((candidate) => candidate.id !== party.id && candidate.memberAccountIds.includes(accountId) && !isSoloOpenParty(candidate))) {
        throw new Error("account is already in another party");
      }
      const invitations = await this.deps.store.listInvitations();
      const invitation = invitations.find(
        (candidate) => candidate.partyId === partyId && candidate.toAccountId === accountId && candidate.status === "pending",
      );
      if (!invitation) throw new Error("party invitation required");
      if (party.memberAccountIds.length >= MAX_PARTY_HUMANS) throw new Error("party is full");

      const resolvedAt = this.now();
      const updated = { ...party, memberAccountIds: [...party.memberAccountIds, accountId], updatedAt: resolvedAt };
      const resolvedInvitations = this.resolveAcceptedInvitationAndExpireOthers(invitations, invitation, resolvedAt);
      await this.deps.store.saveParties(
        parties
          .filter((candidate) => candidate.id === partyId || !candidate.memberAccountIds.includes(accountId) || !isSoloOpenParty(candidate))
          .map((candidate) => (candidate.id === partyId ? updated : candidate)),
      );
      await this.deps.store.saveInvitations(resolvedInvitations);
      await this.emitResolvedInvitations(invitations, resolvedInvitations);
      await this.emitPartyUpdated(updated);
      return updated;
    });
  }

  leaveParty(accountId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const parties = await this.deps.store.listParties();
      const party = parties.find((candidate) => candidate.memberAccountIds.includes(accountId));
      if (!party) return;
      this.requireOpenParty(party);

      const remainingMemberIds = party.memberAccountIds.filter((memberId) => memberId !== accountId);
      const ownerLeft = party.ownerAccountId === accountId;
      const nextParty: PartyRecord | undefined = remainingMemberIds.length > 0
        ? {
            ...party,
            ownerAccountId: ownerLeft ? remainingMemberIds[0]! : party.ownerAccountId,
            memberAccountIds: remainingMemberIds,
            updatedAt: this.now(),
          }
        : undefined;
      const updated = nextParty
        ? parties.map((candidate) => (candidate.id === party.id ? nextParty : candidate))
        : parties.filter((candidate) => candidate.id !== party.id);

      await this.deps.store.saveParties(updated);
      if (ownerLeft) await this.expirePendingInvitationsForParty(party.id);
      await this.emit({ type: "party_updated", accountIds: [accountId, ...remainingMemberIds], party: nextParty ?? null });
    });
  }

  handleAccountOffline(accountId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.expirePendingInvitationsForAccount(accountId);
      const rooms = await this.deps.store.listRooms();
      const readyRoom = this.findReadyRoomForAccount(rooms, accountId);
      if (readyRoom) {
        await this.failReadyRoom(rooms, readyRoom, "player offline");
      }

      const parties = await this.deps.store.listParties();
      const party = parties.find((candidate) => (
        candidate.memberAccountIds.includes(accountId)
        && (candidate.status ?? "open") === "open"
      ));
      if (!party) return;

      const remainingMemberIds = party.memberAccountIds.filter((memberId) => memberId !== accountId);
      const ownerLeft = party.ownerAccountId === accountId;
      const nextParty: PartyRecord | undefined = remainingMemberIds.length > 0
        ? {
            ...party,
            ownerAccountId: ownerLeft ? remainingMemberIds[0]! : party.ownerAccountId,
            memberAccountIds: remainingMemberIds,
            updatedAt: this.now(),
          }
        : undefined;
      const updated = nextParty
        ? parties.map((candidate) => (candidate.id === party.id ? nextParty : candidate))
        : parties.filter((candidate) => candidate.id !== party.id);

      await this.deps.store.saveParties(updated);
      if (ownerLeft) await this.expirePendingInvitationsForParty(party.id);
      await this.emit({ type: "party_updated", accountIds: [accountId, ...remainingMemberIds], party: nextParty ?? null });
    });
  }

  inviteToParty(ownerAccountId: string, toAccountId: string): Promise<PartyInvitationDto> {
    return this.enqueueMutation(async () => {
      await this.requireAccount(toAccountId);
      const parties = await this.deps.store.listParties();
      const party = parties.find((candidate) => candidate.memberAccountIds.includes(ownerAccountId));
      if (!party) throw new Error(`party not found for owner: ${ownerAccountId}`);
      if (party.ownerAccountId !== ownerAccountId) throw new Error("party owner required");
      this.requireOpenParty(party);
      if (party.memberAccountIds.length >= MAX_PARTY_HUMANS) throw new Error("party is full");
      if (party.memberAccountIds.includes(toAccountId)) throw new Error("account is already a party member");
      if (parties.some((candidate) => candidate.id !== party.id && candidate.memberAccountIds.includes(toAccountId) && !isSoloOpenParty(candidate))) {
        throw new Error("account is already in another party");
      }
      const invitations = await this.timeoutOverduePartyInvites(await this.deps.store.listInvitations());
      if (invitations.some((candidate) => candidate.partyId === party.id && candidate.toAccountId === toAccountId && candidate.status === "pending")) {
        throw new Error("party invitation already pending");
      }

      const friendList = await this.deps.friends?.listFriends(ownerAccountId);
      const friend = friendList?.friends.find((candidate) => candidate.accountId === toAccountId);
      if (!friend) throw new Error("party invite target is not a friend");

      const invitation: PartyInvitationRecord = {
        id: this.idFactory(),
        partyId: party.id,
        fromAccountId: ownerAccountId,
        toAccountId,
        status: "pending",
        createdAt: this.now(),
      };
      await this.deps.store.saveInvitations([...invitations, invitation]);
      this.schedulePartyInviteTimeout(invitation);
      await this.emit({ type: "party_invite_received", accountIds: [ownerAccountId, toAccountId], invitation });
      return invitation;
    });
  }

  acceptPartyInvite(accountId: string, invitationId: string): Promise<PartyRecord> {
    return this.enqueueMutation(async () => {
      await this.requireAccount(accountId);
      const invitations = await this.timeoutOverduePartyInvites(await this.deps.store.listInvitations());
      const invitation = this.findInvitation(invitations, invitationId);
      if (invitation.toAccountId !== accountId) throw new Error("party invitation does not belong to account");
      if (invitation.status !== "pending") throw new Error("party invitation is not pending");

      const parties = await this.deps.store.listParties();
      const party = parties.find((candidate) => candidate.id === invitation.partyId);
      if (!party) throw new Error(`party not found: ${invitation.partyId}`);
      this.requireOpenParty(party);
      if (parties.some((candidate) => candidate.id !== party.id && candidate.memberAccountIds.includes(accountId) && !isSoloOpenParty(candidate))) {
        throw new Error("account is already in another party");
      }
      if (!party.memberAccountIds.includes(accountId) && party.memberAccountIds.length >= MAX_PARTY_HUMANS) throw new Error("party is full");

      const resolvedAt = this.now();
      const updated = party.memberAccountIds.includes(accountId)
        ? { ...party, updatedAt: resolvedAt }
        : { ...party, memberAccountIds: [...party.memberAccountIds, accountId], updatedAt: resolvedAt };
      const resolvedInvitations = this.resolveAcceptedInvitationAndExpireOthers(invitations, invitation, resolvedAt);
      await this.deps.store.saveParties(
        parties
          .filter((candidate) => candidate.id === party.id || !candidate.memberAccountIds.includes(accountId) || !isSoloOpenParty(candidate))
          .map((candidate) => (candidate.id === party.id ? updated : candidate)),
      );
      await this.deps.store.saveInvitations(resolvedInvitations);
      await this.emitResolvedInvitations(invitations, resolvedInvitations);
      await this.emitPartyUpdated(updated);
      return updated;
    });
  }

  declinePartyInvite(accountId: string, invitationId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.requireAccount(accountId);
      const invitations = await this.timeoutOverduePartyInvites(await this.deps.store.listInvitations());
      const invitation = this.findInvitation(invitations, invitationId);
      if (invitation.toAccountId !== accountId) throw new Error("party invitation does not belong to account");
      if (invitation.status !== "pending") throw new Error("party invitation is not pending");

      const resolvedInvitation: PartyInvitationRecord = { ...invitation, status: "declined", resolvedAt: this.now() };
      const resolvedInvitations = invitations.map((candidate) => (candidate.id === invitation.id ? resolvedInvitation : candidate));
      await this.deps.store.saveInvitations(resolvedInvitations);
      await this.emitResolvedInvitations(invitations, resolvedInvitations);
    });
  }

  ignorePartyInvite(accountId: string, invitationId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.requireAccount(accountId);
      const invitations = await this.timeoutOverduePartyInvites(await this.deps.store.listInvitations());
      const invitation = this.findInvitation(invitations, invitationId);
      if (invitation.toAccountId !== accountId) throw new Error("party invitation does not belong to account");
      if (invitation.status !== "pending") throw new Error("party invitation is not pending");

      const resolvedInvitation: PartyInvitationRecord = { ...invitation, status: "timed_out", resolvedAt: this.now() };
      const resolvedInvitations = invitations.map((candidate) => (candidate.id === invitation.id ? resolvedInvitation : candidate));
      await this.deps.store.saveInvitations(resolvedInvitations);
      await this.emitResolvedInvitations(invitations, resolvedInvitations);
    });
  }

  beginPartyMatchmaking(ownerAccountId: string): Promise<PartyRecord> {
    return this.enqueueMutation(async () => {
      const parties = await this.deps.store.listParties();
      const party = parties.find((candidate) => candidate.memberAccountIds.includes(ownerAccountId));
      if (!party) throw new Error(`party not found for owner: ${ownerAccountId}`);
      if (party.ownerAccountId !== ownerAccountId) throw new Error("party owner required");
      this.requireOpenParty(party);
      await Promise.all(party.memberAccountIds.map((accountId) => this.requireMatchmakingAccount(accountId)));

      const now = this.now();
      const updatedParty: PartyRecord = { ...party, matchmakingPendingAt: now, updatedAt: now };
      await this.deps.store.saveParties(parties.map((candidate) => (candidate.id === party.id ? updatedParty : candidate)));
      await this.emitPartyUpdated(updatedParty);
      return updatedParty;
    });
  }

  cancelPartyMatchmaking(ownerAccountId: string): Promise<PartyRecord | undefined> {
    return this.enqueueMutation(async () => {
      const parties = await this.deps.store.listParties();
      const party = parties.find((candidate) => candidate.memberAccountIds.includes(ownerAccountId));
      if (!party) return undefined;
      if (party.ownerAccountId !== ownerAccountId) throw new Error("party owner required");
      if ((party.status ?? "open") !== "open" || !party.matchmakingPendingAt) return party;

      const updatedParty: PartyRecord = { ...party, matchmakingPendingAt: undefined, updatedAt: this.now() };
      await this.deps.store.saveParties(parties.map((candidate) => (candidate.id === party.id ? updatedParty : candidate)));
      await this.emitPartyUpdated(updatedParty);
      return updatedParty;
    });
  }

  startPartyMatchmaking(ownerAccountId: string, options: { dev?: boolean } = {}): Promise<PublicMatchRoomRecord> {
    return this.enqueueMutation(async () => {
      const ownerAccount = await this.requireMatchmakingAccount(ownerAccountId);
      const useDev = options.dev === true && ownerAccount.dev === true;
      const parties = await this.deps.store.listParties();
      const party = parties.find((candidate) => candidate.memberAccountIds.includes(ownerAccountId));
      if (!party) throw new Error(`party not found for owner: ${ownerAccountId}`);
      if (party.ownerAccountId !== ownerAccountId) throw new Error("party owner required");
      this.requireOpenParty(party);
      if (party.memberAccountIds.length > MAX_PARTY_HUMANS) throw new Error("party is full");
      await Promise.all(party.memberAccountIds.map((accountId) => this.requireMatchmakingAccount(accountId)));
      const existingRooms = this.pruneTerminalRooms(await this.deps.store.listRooms());
      if (existingRooms.some((room) => isServerManagedPhase(room.phase))) {
        throw new Error("game server is already active");
      }

      const startedAt = this.now();
      const humans = await Promise.all(party.memberAccountIds.map((accountId) => this.toHumanParticipant(accountId)));
      const teams = useDev
        ? assignDevTeams({ humans, botCandidates: this.deps.botCatalog.candidates, random: this.random })
        : assignTeams({ humans, parties, botCandidates: this.deps.botCatalog.candidates, botRosters: this.deps.botCatalog.rosters, random: this.random });
      const participants = [...teams.teamA.participants, ...teams.teamB.participants];
      const room: MatchRoomRecord = {
        id: this.idFactory(),
        phase: "ready",
        teamA: teams.teamA,
        teamB: teams.teamB,
        humanAccountIds: humans.map((participant) => participant.accountId ?? participant.id),
        botParticipantIds: participants.filter((participant) => participant.kind === "bot").map((participant) => participant.id),
        ready: this.buildReadyStates(humans),
        readyDeadlineAt: this.buildReadyDeadlineAt(startedAt),
        readyEnteredAccountIds: [],
        partyId: party.id,
        createdAt: startedAt,
      };
      const updatedParty: PartyRecord = { ...party, status: "matchmaking", lockedMatchId: room.id, matchmakingPendingAt: undefined, updatedAt: startedAt };
      const rooms = [...existingRooms, room];

      await this.deps.store.saveRooms(rooms);
      await this.deps.store.saveParties(parties.map((candidate) => (candidate.id === party.id ? updatedParty : candidate)));
      await this.expirePendingInvitationsForParty(party.id);
      this.scheduleReadyTimeout(room);
      await this.emitPartyUpdated(updatedParty);
      await this.emitReadyRoomCreatedPerAccount(room);
      await this.emit(this.toReadyEvent("ready_check_started", room));
      await this.emit(this.toReadyEvent("ready_check_updated", room));
      return this.toPlayerPublicRoom(room, ownerAccountId);
    });
  }

  enqueue(input: { accountId: string; partyId?: string }): Promise<QueueEntry[]> {
    return this.enqueueMutation(async () => {
      await this.requireMatchmakingAccount(input.accountId);
      if (input.partyId) throw new Error("party matchmaking must be started by owner");
      const parties = await this.deps.store.listParties();
      if (parties.some((party) => party.memberAccountIds.includes(input.accountId))) {
        throw new Error("party matchmaking must be started by owner");
      }

      const queue = await this.deps.store.listQueue();
      const queuedAccountIds = new Set(queue.map((entry) => entry.accountId));
      const added = queuedAccountIds.has(input.accountId) ? [] : [{ accountId: input.accountId, queuedAt: this.now() }];
      const updated = [...queue, ...added];

      await this.deps.store.saveQueue(updated);
      await this.emit({
        type: "queue_updated",
        accountIds: [input.accountId],
        queue: updated.filter((entry) => entry.accountId === input.accountId),
      });
      return updated;
    });
  }
  cancelQueue(accountId: string): Promise<QueueEntry[]> {
    return this.enqueueMutation(async () => {
      const updated = (await this.deps.store.listQueue()).filter((entry) => entry.accountId !== accountId);
      await this.deps.store.saveQueue(updated);
      await this.emit({ type: "queue_updated", accountIds: [accountId], queue: [] });
      return updated;
    });
  }

  ackReadyRoomEntered(roomId: string, accountId: string): Promise<PublicMatchRoomRecord> {
    return this.enqueueMutation(async () => {
      await this.requireAccount(accountId);
      const rooms = await this.deps.store.listRooms();
      const room = rooms.find((candidate) => candidate.id === roomId && candidate.phase === "ready");
      if (!room) throw new Error(`ready room not found: ${roomId}`);

      const audience = this.roomAudience(room);
      if (!audience.includes(accountId)) throw new Error("account is not in match room");

      const enteredAccountIds = room.readyEnteredAccountIds ?? [];
      const nextEnteredAccountIds = enteredAccountIds.includes(accountId)
        ? enteredAccountIds
        : [...enteredAccountIds, accountId];
      const shouldStartCountdown = !room.readyDeadlineAt && audience.every((id) => nextEnteredAccountIds.includes(id));
      const updatedReadyRoom: MatchRoomRecord = {
        ...room,
        readyEnteredAccountIds: nextEnteredAccountIds,
        readyDeadlineAt: room.readyDeadlineAt ?? (shouldStartCountdown ? this.buildReadyDeadlineAt(this.now()) : undefined),
      };

      if (updatedReadyRoom.readyEnteredAccountIds === room.readyEnteredAccountIds && updatedReadyRoom.readyDeadlineAt === room.readyDeadlineAt) {
        return this.toPlayerPublicRoom(room, accountId);
      }

      const updatedRooms = rooms.map((candidate) => (candidate.id === room.id ? updatedReadyRoom : candidate));
      await this.deps.store.saveRooms(updatedRooms);

      if (shouldStartCountdown) {
        this.scheduleReadyTimeout(updatedReadyRoom);
        await this.emit(this.toReadyEvent("ready_check_started", updatedReadyRoom));
        await this.emit(this.toReadyEvent("ready_check_updated", updatedReadyRoom));
      }

      return this.toPlayerPublicRoom(updatedReadyRoom, accountId);
    });
  }

  acceptReady(accountId: string): Promise<PublicMatchRoomRecord> {
    return this.enqueueMutation(async () => {
      await this.requireAccount(accountId);
      const rooms = await this.deps.store.listRooms();
      const room = this.findReadyRoomForAccount(rooms, accountId);
      if (!room) throw new Error(`ready room not found for account: ${accountId}`);
      if (!room.readyDeadlineAt) throw new Error("ready check has not started");

      const acceptedAt = this.now();
      const ready = (room.ready ?? []).map((entry) => {
        if (entry.accountId !== accountId) return entry;
        if (entry.ready) return entry;
        return { ...entry, ready: true, respondedAt: acceptedAt };
      });
      const updatedReadyRoom: MatchRoomRecord = { ...room, ready };
      const updatedRooms = rooms.map((candidate) => (candidate.id === room.id ? updatedReadyRoom : candidate));
      await this.deps.store.saveRooms(updatedRooms);
      await this.emit(this.toReadyEvent("ready_check_updated", updatedReadyRoom));

      if (ready.some((entry) => !entry.ready)) {
        return this.toPlayerPublicRoom(updatedReadyRoom, accountId);
      }

      this.clearReadyTimeout(room.id);

      let mapSelection: MatchMapSelectionState;
      try {
        mapSelection = await this.buildMapSelection(acceptedAt);
      } catch (error) {
        const failedAt = this.now();
        const failure = error instanceof Error ? error.message : String(error);
        const failedRoom: MatchRoomRecord = { ...updatedReadyRoom, phase: "failed", terminalStateAt: failedAt };
        await this.deps.store.saveRooms(updatedRooms.map((candidate) => (candidate.id === room.id ? failedRoom : candidate)));
        await this.unlockPartyForRoom(failedRoom, failedAt);
        await this.emit({ type: "match_failed", matchId: room.id, accountIds: this.roomAudience(failedRoom), error: failure }, room.id);
        return this.toPublicRoom(failedRoom);
      }

      const randomizingRoom: MatchRoomRecord = {
        ...updatedReadyRoom,
        phase: "map_randomizing",
        mapSelection,
      };
      await this.deps.records?.saveMatchPlan(this.buildMatchPlan(randomizingRoom, mapSelection.finalMap));
      const finalizedRooms = updatedRooms.map((candidate) => (candidate.id === room.id ? randomizingRoom : candidate));
      const audience = this.roomAudience(randomizingRoom);

      await this.deps.store.saveRooms(finalizedRooms);
      this.scheduleMapSelectionReveal(randomizingRoom);

      await this.emit({ type: "match_room_created", matchId: randomizingRoom.id, accountIds: audience, room: this.toPublicRoom(randomizingRoom) }, randomizingRoom.id);
      await this.emit({ type: "teams_assigned", matchId: randomizingRoom.id, accountIds: audience, teamA: randomizingRoom.teamA, teamB: randomizingRoom.teamB }, randomizingRoom.id);
      await this.emit({ type: "map_randomizing_started", matchId: randomizingRoom.id, accountIds: audience, mapSelection }, randomizingRoom.id);
      return this.toPublicRoom(randomizingRoom);
    });
  }

  declineReady(accountId: string): Promise<PublicMatchRoomRecord> {
    return this.enqueueMutation(async () => {
      await this.requireAccount(accountId);
      const rooms = await this.deps.store.listRooms();
      const room = this.findReadyRoomForAccount(rooms, accountId);
      if (!room) throw new Error(`ready room not found for account: ${accountId}`);
      if (!room.readyDeadlineAt) throw new Error("ready check has not started");
      return this.toPublicRoom(await this.failReadyRoom(rooms, room, "ready declined"));
    });
  }

  expireReady(roomId: string): Promise<PublicMatchRoomRecord> {
    return this.enqueueMutation(async () => {
      const rooms = await this.deps.store.listRooms();
      const room = rooms.find((candidate) => candidate.id === roomId && candidate.phase === "ready");
      if (!room) throw new Error(`ready room not found: ${roomId}`);
      return this.toPublicRoom(await this.failReadyRoom(rooms, room, "ready timed out"));
    });
  }

  async getState(accountId: string): Promise<{
    queue: QueueEntry[];
    rooms: PublicMatchRoomRecord[];
    party: PartyRecord | null;
    partyInvitations: PartyInvitationDto[];
    room: PublicMatchRoomRecord | null;
  }> {
    const queue = (await this.deps.store.listQueue()).filter((entry) => entry.accountId === accountId);
    const rooms = this.pruneTerminalRooms(await this.deps.store.listRooms())
      .filter((room) => this.roomHasAccount(room, accountId))
      .map((room) => this.toPlayerPublicRoom(room, accountId));
    const party = (await this.deps.store.listParties()).find((candidate) => candidate.memberAccountIds.includes(accountId) && !isSoloOpenParty(candidate)) ?? null;
    const partyInvitations = (await this.deps.store.listInvitations()).filter(
      (invitation) => invitation.toAccountId === accountId && invitation.status === "pending" && !this.isPartyInviteOverdue(invitation),
    );
    return { queue, rooms, party, partyInvitations, room: this.findCurrentRoom(rooms) };
  }

  completeMatchFromServerExit(matchId: string, exitInfo: GameServerExitInfo): Promise<PublicMatchRoomRecord | undefined> {
    return this.enqueueMutation(async () => {
      const rooms = await this.deps.store.listRooms();
      const room = rooms.find((candidate) => candidate.id === matchId);
      if (!room) return undefined;
      if (!isServerManagedPhase(room.phase)) return this.toPublicRoom(room);

      const completedAt = this.now();
      const completed: MatchRoomRecord = { ...room, phase: "completed", terminalStateAt: completedAt };
      await this.deps.store.saveRooms(rooms.map((candidate) => (candidate.id === matchId ? completed : candidate)));
      await this.deps.records?.saveStatus(matchId, { phase: "completed", completedAt, serverExit: exitInfo });
      await this.unlockPartyForRoom(completed, completedAt);
      await this.emit({ type: "match_completed", matchId, accountIds: this.roomAudience(completed) }, matchId);
      return this.toPublicRoom(completed);
    });
  }

  completeServerManagedRoomsFromServerUnavailable(exitInfo: GameServerExitInfo): Promise<PublicMatchRoomRecord[]> {
    return this.enqueueMutation(async () => {
      const rooms = await this.deps.store.listRooms();
      const targets = rooms.filter((room) => isServerManagedPhase(room.phase));
      if (targets.length === 0) return [];

      const completedAt = this.now();
      const completedById = new Map(
        targets.map((room) => [room.id, { ...room, phase: "completed" as const, terminalStateAt: completedAt }]),
      );
      await this.deps.store.saveRooms(rooms.map((room) => completedById.get(room.id) ?? room));

      for (const completed of completedById.values()) {
        await this.deps.records?.saveStatus(completed.id, { phase: "completed", completedAt, serverExit: exitInfo });
        await this.unlockPartyForRoom(completed, completedAt);
        await this.emit({ type: "match_completed", matchId: completed.id, accountIds: this.roomAudience(completed) }, completed.id);
      }

      return [...completedById.values()].map((room) => this.toPublicRoom(room));
    });
  }

  private findInvitation(invitations: PartyInvitationRecord[], invitationId: string): PartyInvitationRecord {
    const invitation = invitations.find((candidate) => candidate.id === invitationId);
    if (!invitation) throw new Error(`party invitation not found: ${invitationId}`);
    return invitation;
  }

  private requireOpenParty(party: PartyRecord): void {
    if ((party.status ?? "open") !== "open") throw new Error("party is not open");
  }

  private async emitPartyUpdated(party: PartyRecord): Promise<void> {
    await this.emit({ type: "party_updated", accountIds: party.memberAccountIds, party });
  }

  private resolveAcceptedInvitationAndExpireOthers(
    invitations: PartyInvitationRecord[],
    accepted: PartyInvitationRecord,
    resolvedAt: string,
  ): PartyInvitationRecord[] {
    return invitations.map((invitation) => {
      if (invitation.id === accepted.id) return { ...invitation, status: "accepted", resolvedAt };
      if (invitation.toAccountId === accepted.toAccountId && invitation.status === "pending") {
        return { ...invitation, status: "expired", resolvedAt };
      }
      return invitation;
    });
  }

  private async emitResolvedInvitations(
    previous: PartyInvitationRecord[],
    next: PartyInvitationRecord[],
  ): Promise<void> {
    for (const invitation of next) {
      const previousInvitation = previous.find((candidate) => candidate.id === invitation.id);
      if (previousInvitation?.status === "pending" && invitation.status !== "pending") {
        this.clearPartyInviteTimeout(invitation.id);
        await this.emit({ type: "party_invite_resolved", accountIds: [invitation.fromAccountId, invitation.toAccountId], invitation });
      }
    }
  }

  private async expirePendingInvitationsForAccount(accountId: string): Promise<void> {
    const invitations = await this.deps.store.listInvitations();
    const resolvedAt = this.now();
    const resolvedInvitations = invitations.map((invitation) =>
      invitation.toAccountId === accountId && invitation.status === "pending"
        ? { ...invitation, status: "expired" as const, resolvedAt }
        : invitation,
    );
    await this.deps.store.saveInvitations(resolvedInvitations);
    await this.emitResolvedInvitations(invitations, resolvedInvitations);
  }

  private async expirePendingInvitationsForParty(partyId: string): Promise<void> {
    const invitations = await this.deps.store.listInvitations();
    const resolvedAt = this.now();
    const expired = invitations
      .filter((invitation) => invitation.partyId === partyId && invitation.status === "pending")
      .map((invitation): PartyInvitationRecord => ({ ...invitation, status: "expired", resolvedAt }));
    if (expired.length === 0) return;

    const expiredById = new Map(expired.map((invitation) => [invitation.id, invitation]));
    await this.deps.store.saveInvitations(invitations.map((invitation) => expiredById.get(invitation.id) ?? invitation));
    for (const invitation of expired) {
      this.clearPartyInviteTimeout(invitation.id);
      await this.emit({ type: "party_invite_resolved", accountIds: [invitation.fromAccountId, invitation.toAccountId], invitation });
    }
  }

  private schedulePartyInviteTimeout(invitation: PartyInvitationRecord): void {
    if (invitation.status !== "pending") return;
    this.clearPartyInviteTimeout(invitation.id);
    const timeout = this.setTimeoutFn(() => {
      void this.timeoutPartyInvite(invitation.id).catch(() => undefined);
    }, PARTY_INVITE_TIMEOUT_MS);
    if (this.unrefReadyTimeouts) timeout.unref?.();
    this.partyInviteTimeouts.set(invitation.id, timeout);
  }

  private isPartyInviteOverdue(invitation: PartyInvitationRecord): boolean {
    if (invitation.status !== "pending") return false;
    const createdAtMs = Date.parse(invitation.createdAt);
    const nowMs = Date.parse(this.now());
    return Number.isFinite(createdAtMs) && Number.isFinite(nowMs) && nowMs - createdAtMs >= PARTY_INVITE_TIMEOUT_MS;
  }

  private async timeoutOverduePartyInvites(invitations: PartyInvitationRecord[]): Promise<PartyInvitationRecord[]> {
    if (!invitations.some((invitation) => this.isPartyInviteOverdue(invitation))) return invitations;
    const resolvedAt = this.now();
    const resolvedInvitations = invitations.map((invitation) => (
      this.isPartyInviteOverdue(invitation)
        ? { ...invitation, status: "timed_out" as const, resolvedAt }
        : invitation
    ));
    await this.deps.store.saveInvitations(resolvedInvitations);
    await this.emitResolvedInvitations(invitations, resolvedInvitations);
    return resolvedInvitations;
  }

  private clearPartyInviteTimeout(invitationId: string): void {
    const timeout = this.partyInviteTimeouts.get(invitationId);
    if (!timeout) return;
    this.clearTimeoutFn(timeout);
    this.partyInviteTimeouts.delete(invitationId);
  }

  private timeoutPartyInvite(invitationId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const invitations = await this.deps.store.listInvitations();
      const invitation = invitations.find((candidate) => candidate.id === invitationId);
      if (!invitation || invitation.status !== "pending") {
        this.clearPartyInviteTimeout(invitationId);
        return;
      }
      const resolvedInvitation: PartyInvitationRecord = { ...invitation, status: "timed_out", resolvedAt: this.now() };
      const resolvedInvitations = invitations.map((candidate) => (candidate.id === invitationId ? resolvedInvitation : candidate));
      await this.deps.store.saveInvitations(resolvedInvitations);
      await this.emitResolvedInvitations(invitations, resolvedInvitations);
    });
  }

  private enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(run, run);
    this.mutationQueue = next.catch(() => undefined);
    return next;
  }

  

  private async emit(event: RealtimeEvent, matchId?: string): Promise<void> {
    if (matchId) {
      void this.deps.records?.appendEvent(matchId, { ...event, at: this.now() }).catch((error) => {
        process.stderr.write(
          `Failed to append match event for ${matchId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }
    this.deps.events?.publish(event);
  }

  private async emitReadyRoomCreatedPerAccount(room: MatchRoomRecord): Promise<void> {
    for (const accountId of this.roomAudience(room)) {
      await this.emit(
        { type: "match_room_created", matchId: room.id, accountIds: [accountId], room: this.toPlayerPublicRoom(room, accountId) },
        room.id,
      );
    }
  }

  

  

  private async saveRoomAfterMapSelected(rooms: MatchRoomRecord[], room: MatchRoomRecord, finalMap: string): Promise<MatchRoomRecord> {
    if (rooms.some((candidate) => candidate.id !== room.id && isServerManagedPhase(candidate.phase))) {
      return this.failRoomBecauseGameServerActive(rooms, room);
    }

    this.clearMapSelectionTimeout(room.id);
    const preparing: MatchRoomRecord = { ...room, phase: "server_prepare", connect: undefined };
    await this.deps.store.saveRooms(rooms.map((candidate) => (candidate.id === room.id ? preparing : candidate)));
    await this.emit({ type: "server_preparing", matchId: room.id, accountIds: this.roomAudience(preparing) }, room.id);

    const savedPlan = await this.readSavedMatchPlan(room.id);
    const plan = savedPlan?.map === finalMap ? savedPlan : this.buildMatchPlan(preparing, finalMap);
    if (plan !== savedPlan) {
      await this.deps.records?.saveMatchPlan(plan);
    }

    if (!this.deps.executor) {
      return preparing;
    }

    try {
      const connect = await this.deps.executor.prepare(plan);
      const latestRooms = await this.deps.store.listRooms();
      const latestRoom = latestRooms.find((candidate) => candidate.id === room.id) ?? preparing;
      if (!isServerManagedPhase(latestRoom.phase)) return latestRoom;

      const roomsToSave = latestRooms.some((candidate) => candidate.id === room.id) ? latestRooms : rooms;
      const connected: MatchRoomRecord = { ...latestRoom, phase: "connect", connect };
      await this.deps.store.saveRooms(roomsToSave.map((candidate) => (candidate.id === room.id ? connected : candidate)));
      await this.deps.records?.saveStatus(room.id, { phase: "connect", connect });
      await this.emit({ type: "connect_ready", matchId: room.id, accountIds: this.roomAudience(connected), connect }, room.id);
      return connected;
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      const failedAt = this.now();
      const failed: MatchRoomRecord = { ...preparing, phase: "failed", terminalStateAt: failedAt };
      await this.deps.store.saveRooms(rooms.map((candidate) => (candidate.id === room.id ? failed : candidate)));
      await this.deps.records?.saveStatus(room.id, { phase: "failed", error: failure });
      await this.unlockPartyForRoom(failed, failedAt);
      await this.emit({ type: "match_failed", matchId: room.id, accountIds: this.roomAudience(room), error: failure }, room.id);
      return failed;
    }
  }

  private buildMatchPlan(room: MatchRoomRecord, map: string): MatchPlan {
    return {
      id: room.id,
      phase: "server_prepare",
      map,
      teamA: room.teamA,
      teamB: room.teamB,
      connectPassword: `match_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      createdAt: this.now(),
    };
  }

  private async readSavedMatchPlan(matchId: string): Promise<MatchPlan | undefined> {
    try {
      return await this.deps.records?.readMatchPlan(matchId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("JSON file does not exist:")) {
        return undefined;
      }
      throw error;
    }
  }

  private async requireAccount(accountId: string): Promise<void> {
    if (!(await this.deps.accounts.getById(accountId))) throw new Error(`account not found: ${accountId}`);
  }

  private async requireMatchmakingAccount(accountId: string): Promise<AccountRecord> {
    const account = await this.deps.accounts.getById(accountId);
    if (!account) throw new Error(`account not found: ${accountId}`);
    if (!account.steam64.trim()) throw new Error("steam64 required for matchmaking");
    return account;
  }

  private async toHumanParticipant(accountId: string): Promise<MatchParticipant> {
    const account = await this.deps.accounts.getById(accountId);
    if (!account) throw new Error(`account not found: ${accountId}`);
    const steam64 = account.steam64.trim();
    if (!steam64) throw new Error("steam64 required for matchmaking");

    const accountDisplayName = account.displayName.trim();

    return {
      id: account.id,
      kind: "human",
      displayName: accountDisplayName || steam64,
      steam64,
      accountId: account.id,
    };
  }

  private buildReadyStates(humans: MatchParticipant[]): MatchRoomReadyState[] {
    return humans.map((participant) => ({ accountId: participant.accountId ?? participant.id, ready: false }));
  }

  private buildReadyDeadlineAt(createdAt: string): string {
    return new Date(Date.parse(createdAt) + READY_TIMEOUT_MS).toISOString();
  }

  private scheduleReadyTimeout(room: MatchRoomRecord): void {
    if (room.phase !== "ready" || !room.readyDeadlineAt) return;

    const deadlineMs = Date.parse(room.readyDeadlineAt);
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return;

    this.clearReadyTimeout(room.id);
    const timeout = this.setTimeoutFn(() => {
      void this.expireReady(room.id).catch(() => undefined);
    }, Math.max(0, deadlineMs - nowMs));
    if (this.unrefReadyTimeouts) timeout.unref?.();
    this.readyTimeouts.set(room.id, timeout);
  }

  

  private clearReadyTimeout(roomId: string): void {
    const timeout = this.readyTimeouts.get(roomId);
    if (!timeout) return;
    this.clearTimeoutFn(timeout);
    this.readyTimeouts.delete(roomId);
  }

  

  private humanParticipantsForRoom(room: MatchRoomRecord): MatchParticipant[] {
    const audience = new Set(this.roomAudience(room));
    return [...room.teamA.participants, ...room.teamB.participants].filter(
      (participant): participant is MatchParticipant => participant.kind === "human" && !!participant.accountId && audience.has(participant.accountId),
    );
  }

  private roomAudience(room: MatchRoomRecord): string[] {
    if (room.humanAccountIds && room.humanAccountIds.length > 0) return room.humanAccountIds;
    if (room.ready && room.ready.length > 0) return room.ready.map((entry) => entry.accountId);
    return [...room.teamA.participants, ...room.teamB.participants]
      .filter((participant) => participant.kind === "human" && participant.accountId)
      .map((participant) => participant.accountId as string);
  }

  private getMapPool(): string[] {
    const mapPool = this.deps.mapPool ?? DEFAULT_MAP_POOL;
    const normalized = mapPool.map((map) => map.trim()).filter(Boolean);
    if (normalized.length === 0) throw new Error("map pool is empty");
    return normalized;
  }

  private chooseRandomIndex(length: number): number {
    if (length <= 0) throw new Error("cannot choose from empty list");
    const random = this.random ?? Math.random;
    return Math.min(Math.floor(random() * length), length - 1);
  }

  private async buildMapSelection(startedAt: string): Promise<MatchMapSelectionState> {
    const mapPool = this.getMapPool();
    const recentMatchMaps = await this.listRecentMatchMaps();
    const finalMapPool = this.getFinalMapPool(mapPool, recentMatchMaps);
    const finalMap = finalMapPool[this.chooseRandomIndex(finalMapPool.length)]!;
    const nonFinalPool = mapPool.filter((map) => map !== finalMap);
    const reelPool = nonFinalPool.length > 0 ? nonFinalPool : mapPool;
    const reel: string[] = [];
    while (reel.length < MAP_RANDOMIZATION_REEL_LENGTH - 1) {
      reel.push(reelPool[this.chooseRandomIndex(reelPool.length)]!);
    }
    reel.push(finalMap);
    return {
      mapPool: mapPool.slice(),
      reel,
      finalMap,
      startedAt,
      revealAt: new Date(Date.parse(startedAt) + MAP_RANDOMIZATION_MS).toISOString(),
    };
  }

  private getFinalMapPool(mapPool: string[], recentMatchMaps: string[]): string[] {
    const recentMaps = new Set(recentMatchMaps.slice(-RECENT_MAP_EXCLUSION_COUNT));
    const eligibleMaps = mapPool.filter((map) => !recentMaps.has(map));
    return eligibleMaps.length > 0 ? eligibleMaps : mapPool;
  }

  private async listRecentMatchMaps(): Promise<string[]> {
    return this.deps.records?.listRecentMatchMaps(RECENT_MAP_EXCLUSION_COUNT) ?? [];
  }

  private scheduleMapSelectionReveal(room: MatchRoomRecord): void {
    const revealAt = room.mapSelection?.revealAt;
    if (room.phase !== "map_randomizing" || !revealAt) return;

    const revealMs = Date.parse(revealAt);
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(revealMs) || !Number.isFinite(nowMs)) return;

    this.clearMapSelectionTimeout(room.id);
    const timeout = this.setTimeoutFn(() => {
      void this.revealSelectedMap(room.id, revealAt).catch(() => undefined);
    }, Math.max(0, revealMs - nowMs));
    if (this.unrefReadyTimeouts) timeout.unref?.();
    this.mapSelectionTimeouts.set(room.id, timeout);
  }

  private clearMapSelectionTimeout(roomId: string): void {
    const timeout = this.mapSelectionTimeouts.get(roomId);
    if (!timeout) return;
    this.clearTimeoutFn(timeout);
    this.mapSelectionTimeouts.delete(roomId);
  }

  private revealSelectedMap(roomId: string, expectedRevealAt: string): Promise<PublicMatchRoomRecord> {
    return this.enqueueMutation(async () => {
      const rooms = await this.deps.store.listRooms();
      const room = rooms.find((candidate) => candidate.id === roomId);
      if (!room || room.phase !== "map_randomizing" || !room.mapSelection) throw new Error(`map randomizing room not found: ${roomId}`);
      if (room.mapSelection.revealAt !== expectedRevealAt) return this.toPublicRoom(room);
      return this.toPublicRoom(await this.saveRoomAfterMapSelected(rooms, room, room.mapSelection.finalMap));
    });
  }

  private pruneTerminalRooms(rooms: MatchRoomRecord[]): MatchRoomRecord[] {
    const cutoff = Date.parse(this.now()) - TERMINAL_ROOM_MEMORY_TTL_MS;
    return rooms.filter((room) => {
      if (!isTerminalMatchPhase(room.phase)) return true;
      const roomTime = Date.parse(room.terminalStateAt ?? room.createdAt);
      return !Number.isFinite(roomTime) || roomTime >= cutoff;
    });
  }

  private toPublicRoom(room: MatchRoomRecord): PublicMatchRoomRecord {
    return {
      id: room.id,
      phase: room.phase,
      teamA: {
        ...room.teamA,
        participants: room.teamA.participants.slice(),
      },
      teamB: {
        ...room.teamB,
        participants: room.teamB.participants.slice(),
      },
      humanAccountIds: room.humanAccountIds?.slice(),
      botParticipantIds: room.botParticipantIds?.slice(),
      ready: room.ready?.map((entry) => ({ ...entry })),
      readyDeadlineAt: room.readyDeadlineAt,
      partyId: room.partyId,
      mapSelection: room.mapSelection
        ? {
            mapPool: room.mapSelection.mapPool.slice(),
            reel: room.mapSelection.reel.slice(),
            finalMap: room.mapSelection.finalMap,
            startedAt: room.mapSelection.startedAt,
            revealAt: room.mapSelection.revealAt,
          }
        : undefined,
      connect: room.connect ? { ...room.connect } : undefined,
      createdAt: room.createdAt,
    };
  }

  private maskReadyParticipant(participant: MatchParticipant): MatchParticipant {
    return {
      id: participant.id,
      kind: participant.kind,
      displayName: "已匹配玩家",
      steam64: undefined,
      steamPersonaName: undefined,
      steamAvatarUrl: undefined,
      isCaptain: false,
      botCategory: undefined,
      botProfileName: undefined,
      accountId: participant.accountId,
      identityMasked: true,
    };
  }

  private toPlayerPublicRoom(room: MatchRoomRecord, viewerAccountId: string): PublicMatchRoomRecord {
    if (room.phase !== "ready") return this.toPublicRoom(room);
    return {
      ...this.toPublicRoom(room),
      teamA: {
        ...room.teamA,
        participants: room.teamA.participants.map((p) =>
          p.accountId === viewerAccountId ? p : this.maskReadyParticipant(p),
        ),
      },
      teamB: {
        ...room.teamB,
        participants: room.teamB.participants.map((p) =>
          p.accountId === viewerAccountId ? p : this.maskReadyParticipant(p),
        ),
      },
    };
  }

  private toReadyEvent(type: "ready_check_started" | "ready_check_updated", room: MatchRoomRecord): RealtimeEvent {
    return {
      type,
      matchId: room.id,
      roomId: room.id,
      accountIds: this.roomAudience(room),
      deadlineAt: room.readyDeadlineAt ?? room.createdAt,
      ready: room.ready ?? this.buildReadyStates(this.humanParticipantsForRoom(room)),
      humanParticipants: this.humanParticipantsForRoom(room).map((p) => ({
        id: p.id,
        kind: p.kind,
        displayName: p.displayName,
        accountId: p.accountId,
      })),
    };
  }

  private findReadyRoomForAccount(rooms: MatchRoomRecord[], accountId: string): MatchRoomRecord | undefined {
    return rooms.find((room) => room.phase === "ready" && this.roomAudience(room).includes(accountId));
  }

  private findCurrentRoom<T extends { phase: string }>(rooms: T[]): T | null {
    return [...rooms].reverse().find((room) => !isTerminalMatchPhase(room.phase)) ?? rooms.at(-1) ?? null;
  }

  private async failRoomBecauseGameServerActive(rooms: MatchRoomRecord[], room: MatchRoomRecord): Promise<MatchRoomRecord> {
    const failedAt = this.now();
    const reason = "game server is already active";
    const failedRoom: MatchRoomRecord = { ...room, phase: "failed", terminalStateAt: failedAt };
    this.clearReadyTimeout(room.id);
    this.clearMapSelectionTimeout(room.id);

    const updatedRooms = rooms.map((candidate) => (candidate.id === room.id ? failedRoom : candidate));
    await this.deps.store.saveRooms(updatedRooms);
    await this.unlockPartyForRoom(failedRoom, failedAt);
    await this.deps.records?.saveStatus(room.id, { phase: "failed", error: reason });
    await this.emit({ type: "match_failed", matchId: room.id, accountIds: this.roomAudience(failedRoom), error: reason }, room.id);
    return failedRoom;
  }

  private async failReadyRoom(rooms: MatchRoomRecord[], room: MatchRoomRecord, reason: string): Promise<MatchRoomRecord> {
    const failedAt = this.now();
    const failedRoom: MatchRoomRecord = { ...room, phase: "failed", terminalStateAt: failedAt };
    this.clearReadyTimeout(room.id);
    const updatedRooms = rooms.map((candidate) => (candidate.id === room.id ? failedRoom : candidate));
    await this.deps.store.saveRooms(updatedRooms);

    if (room.partyId) {
      const parties = await this.deps.store.listParties();
      const party = parties.find((candidate) => candidate.id === room.partyId);
      if (party) {
        const updatedParty: PartyRecord = { ...party, status: "open", lockedMatchId: undefined, updatedAt: failedAt };
        await this.deps.store.saveParties(parties.map((candidate) => (candidate.id === party.id ? updatedParty : candidate)));
        await this.emitPartyUpdated(updatedParty);
      }
    }

    await this.emit(this.toReadyEvent("ready_check_updated", failedRoom));
    await this.emit({ type: "match_failed", matchId: room.id, accountIds: this.roomAudience(failedRoom), error: reason });
    return failedRoom;
  }

  private async unlockPartyForRoom(room: MatchRoomRecord, updatedAt: string): Promise<void> {
    if (!room.partyId) return;
    const parties = await this.deps.store.listParties();
    const party = parties.find((candidate) => candidate.id === room.partyId);
    if (!party) return;
    if (party.lockedMatchId && party.lockedMatchId !== room.id) return;
    if ((party.status ?? "open") === "open" && !party.lockedMatchId) return;

    const updatedParty: PartyRecord = { ...party, status: "open", lockedMatchId: undefined, updatedAt };
    await this.deps.store.saveParties(parties.map((candidate) => (candidate.id === party.id ? updatedParty : candidate)));
    await this.emitPartyUpdated(updatedParty);
  }

  private roomHasAccount(room: MatchRoomRecord, accountId: string): boolean {
    if (this.roomAudience(room).includes(accountId)) return true;
    return [...room.teamA.participants, ...room.teamB.participants].some((participant) => participant.accountId === accountId);
  }
}

function isServerManagedPhase(phase: MatchRoomRecord["phase"]): boolean {
  return phase === "server_prepare" || phase === "connect" || phase === "live";
}

function isTerminalMatchPhase(phase: string): boolean {
  return phase === "completed" || phase === "failed";
}
