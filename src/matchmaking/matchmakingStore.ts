import path from "node:path";
import { ensureJsonFile, readJsonFile, writeJsonFileAtomic } from "../storage/jsonFile.js";
import type { MatchConnectInfo } from "../game/matchExecutor.js";
import type { MatchPhase, MatchTeam } from "./types.js";

export interface QueueEntry {
  accountId: string;
  partyId?: string;
  queuedAt: string;
  readyAcceptedAt?: string;
}

export type PartyStatus = "open" | "matchmaking" | "in_match";

export interface PartyRecord {
  id: string;
  ownerAccountId: string;
  memberAccountIds: string[];
  createdAt: string;
  updatedAt?: string;
  status?: PartyStatus;
  lockedMatchId?: string;
  matchmakingPendingAt?: string;
  matchmakingStartAt?: string;
  matchmakingDev?: boolean;
}

export interface PartyInvitationRecord {
  id: string;
  partyId: string;
  fromAccountId: string;
  toAccountId: string;
  status: "pending" | "accepted" | "declined" | "expired" | "timed_out";
  createdAt: string;
  resolvedAt?: string;
}

export interface MatchRoomReadyState {
  accountId: string;
  ready: boolean;
  respondedAt?: string;
}

export type MatchClientStage = "room_entered" | "map_stage_entered" | "map_revealed";

interface MatchStageBarrier {
  stage: MatchClientStage;
  requiredAccountIds: string[];
  acknowledgements: Array<{ accountId: string; connectionId: string }>;
  deadlineAt: string;
}


export interface MatchMapSelectionState {
  mapPool: string[];
  reel: string[];
  finalMap: string;
  startedAt: string;
  revealAt: string;
}

export interface MatchRoomRecord {
  id: string;
  phase: MatchPhase;
  teamA: MatchTeam;
  teamB: MatchTeam;
  humanAccountIds?: string[];
  botParticipantIds?: string[];
  ready?: MatchRoomReadyState[];
  readyDeadlineAt?: string;
  stageBarrier?: MatchStageBarrier;
  partyId?: string;
  mapSelection?: MatchMapSelectionState;
  connect?: MatchConnectInfo;
  createdAt: string;
  terminalStateAt?: string;
}
interface QueueFile {
  queue: QueueEntry[];
}

interface PartiesFile {
  parties: PartyRecord[];
}

interface PartyInvitationsFile {
  invitations: PartyInvitationRecord[];
}

interface RoomsFile {
  rooms: MatchRoomRecord[];
}

export class MatchmakingStore {
  private queueWrites: Promise<void> = Promise.resolve();
  private partyWrites: Promise<void> = Promise.resolve();
  private invitationWrites: Promise<void> = Promise.resolve();
  private roomWrites: Promise<void> = Promise.resolve();

  private constructor(private readonly dir: string) {}

  static async create(dir: string): Promise<MatchmakingStore> {
    const store = new MatchmakingStore(dir);
    await Promise.all([
      ensureJsonFile(store.queuePath, { queue: [] }),
      ensureJsonFile(store.partiesPath, { parties: [] }),
      ensureJsonFile(store.invitationsPath, { invitations: [] }),
      ensureJsonFile(store.roomsPath, { rooms: [] }),
    ]);
    await store.recoverRuntimeStateOnLoad();
    return store;
  }

  listQueue(): Promise<QueueEntry[]> {
    return readJsonFile<QueueFile>(this.queuePath, { queue: [] }).then((file) => file.queue);
  }

  saveQueue(entries: QueueEntry[]): Promise<void> {
    return this.enqueueQueueWrite(() => writeJsonFileAtomic(this.queuePath, { queue: entries }));
  }

  listParties(): Promise<PartyRecord[]> {
    return readJsonFile<PartiesFile>(this.partiesPath, { parties: [] }).then((file) =>
      file.parties.map((party) => ({ ...party, status: party.status ?? "open" })),
    );
  }

  saveParties(parties: PartyRecord[]): Promise<void> {
    return this.enqueuePartyWrite(() => writeJsonFileAtomic(this.partiesPath, { parties }));
  }

  listInvitations(): Promise<PartyInvitationRecord[]> {
    return readJsonFile<PartyInvitationsFile>(this.invitationsPath, { invitations: [] }).then((file) => file.invitations);
  }

  saveInvitations(invitations: PartyInvitationRecord[]): Promise<void> {
    return this.enqueueInvitationWrite(() => writeJsonFileAtomic(this.invitationsPath, { invitations }));
  }

  listRooms(): Promise<MatchRoomRecord[]> {
    return readJsonFile<RoomsFile>(this.roomsPath, { rooms: [] }).then((file) => file.rooms);
  }
  saveRooms(rooms: MatchRoomRecord[]): Promise<void> {
    return this.enqueueRoomWrite(() => writeJsonFileAtomic(this.roomsPath, { rooms }));
  }

  private get queuePath(): string {
    return path.join(this.dir, "queue.json");
  }

  private get partiesPath(): string {
    return path.join(this.dir, "parties.json");
  }

  private get invitationsPath(): string {
    return path.join(this.dir, "invitations.json");
  }

  private get roomsPath(): string {
    return path.join(this.dir, "rooms.json");
  }

  private enqueueQueueWrite(write: () => Promise<void>): Promise<void> {
    const next = this.queueWrites.then(() => write(), () => write());
    this.queueWrites = next.catch(() => undefined);
    return next;
  }
  private enqueuePartyWrite(write: () => Promise<void>): Promise<void> {
    const next = this.partyWrites.then(() => write(), () => write());
    this.partyWrites = next.catch(() => undefined);
    return next;
  }

  private enqueueInvitationWrite(write: () => Promise<void>): Promise<void> {
    const next = this.invitationWrites.then(() => write(), () => write());
    this.invitationWrites = next.catch(() => undefined);
    return next;
  }

  private async recoverRuntimeStateOnLoad(): Promise<void> {
    const queueFile = await readJsonFile<QueueFile>(this.queuePath, { queue: [] });
    const queue = queueFile.queue.length > 0 ? [] : queueFile.queue;
    if (queue !== queueFile.queue) {
      await writeJsonFileAtomic(this.queuePath, { queue });
    }
  }

  private enqueueRoomWrite(write: () => Promise<void>): Promise<void> {
    const next = this.roomWrites.then(() => write(), () => write());
    this.roomWrites = next.catch(() => undefined);
    return next;
  }
}
