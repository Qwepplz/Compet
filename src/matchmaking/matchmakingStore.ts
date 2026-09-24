import path from "node:path";
import { ensureJsonFile, readJsonFile, writeJsonFileAtomic } from "../storage/jsonFile.js";
import type { MatchConnectInfo } from "../game/matchExecutor.js";
import type { MatchPhase, MatchTeam } from "./types.js";
import { assertQueueFile, assertPartiesFile, assertInvitationsFile, assertRoomsFile } from "./matchmakingStoreValidation.js";

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
  preload?: { cancelled?: boolean; resourceVersion: string; completedAccountIds: string[]; deadlineAt: string };
  matchmakingDev?: boolean;
  draft?: PendingMatchDraft;
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

export interface ReadyPresentationState {
  token: string;
  completedAccountIds: string[];
  deadlineAt: string;
}


export interface MapSelectionContent {
  mapPool: string[];
  reel: string[];
  finalMap: string;
}

export type MatchMapSelectionState = MapSelectionContent & (
  | { startedAt: string; revealAt: string }
  | { startedAt?: undefined; revealAt?: undefined }
);

export interface PendingMatchDraft {
  teamA: MatchTeam;
  teamB: MatchTeam;
  mapSelection: MapSelectionContent;
}

export interface MatchRoomRecord {
  id: string;
  phase: MatchPhase;
  dev?: true;
  databaseWriteStarted?: boolean;
  teamA: MatchTeam;
  teamB: MatchTeam;
  humanAccountIds?: string[];
  botParticipantIds?: string[];
  ready?: MatchRoomReadyState[];
  readyPresentation?: ReadyPresentationState;
  readyStartsAt?: string;
  readyDeadlineAt?: string;
  partyId?: string;
  mapSelection?: MatchMapSelectionState;
  connect?: MatchConnectInfo;
  createdAt: string;
  terminalStateAt?: string;
}
export interface QueueFile {
  queue: QueueEntry[];
}

export interface PartiesFile {
  parties: PartyRecord[];
}

export interface PartyInvitationsFile {
  invitations: PartyInvitationRecord[];
}

export interface MatchFailedEventOutboxEntry {
  eventId: string;
  matchId: string;
  accountIds: string[];
  error?: unknown;
  readyDeclinedByDisplayName?: string;
}

export interface RoomsFile {
  rooms: MatchRoomRecord[];
  pendingBackupCleanupMatchIds?: string[];
  pendingMatchFailedEvents?: MatchFailedEventOutboxEntry[];
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
      ensureJsonFile(store.roomsPath, { rooms: [], pendingBackupCleanupMatchIds: [] }),
    ]);
    await Promise.all([
      store.readQueueFile(),
      store.readPartiesFile(),
      store.readInvitationsFile(),
      store.readRoomsFile(),
    ]);
    await store.recoverRuntimeStateOnLoad();
    return store;
  }

  listQueue(): Promise<QueueEntry[]> {
    return this.readQueueFile().then((file) => file.queue);
  }

  saveQueue(entries: QueueEntry[]): Promise<void> {
    return this.enqueueQueueWrite(async () => {
      const file = await this.readQueueFile();
      const next = { ...file, queue: entries };
      assertQueueFile(next);
      await writeJsonFileAtomic(this.queuePath, next);
    });
  }

  listParties(): Promise<PartyRecord[]> {
    return this.readPartiesFile().then((file) =>
      file.parties.map((party) => ({ ...party, status: party.status ?? "open" })),
    );
  }

  saveParties(parties: PartyRecord[]): Promise<void> {
    return this.enqueuePartyWrite(async () => {
      const file = await this.readPartiesFile();
      const next = { ...file, parties: parties };
      assertPartiesFile(next);
      await writeJsonFileAtomic(this.partiesPath, next);
    });
  }

  listInvitations(): Promise<PartyInvitationRecord[]> {
    return this.readInvitationsFile().then((file) => file.invitations);
  }

  saveInvitations(invitations: PartyInvitationRecord[]): Promise<void> {
    return this.enqueueInvitationWrite(async () => {
      const file = await this.readInvitationsFile();
      const next = { ...file, invitations: invitations };
      assertInvitationsFile(next);
      await writeJsonFileAtomic(this.invitationsPath, next);
    });
  }

  listRooms(): Promise<MatchRoomRecord[]> {
    return this.readRoomsFile().then((file) => file.rooms);
  }
  saveRooms(rooms: MatchRoomRecord[]): Promise<void> {
    return this.enqueueRoomWrite(async () => {
      const file = await this.readRoomsFile();
      await this.writeRoomsFile({ ...file, rooms });
    });
  }

  saveRoomsAndPendingMatchFailedEvents(
    rooms: MatchRoomRecord[],
    events: MatchFailedEventOutboxEntry[],
  ): Promise<void> {
    return this.enqueueRoomWrite(async () => {
      const file = await this.readRoomsFile();
      assertRoomsFile({ ...file, rooms, pendingMatchFailedEvents: events });
      const pending = file.pendingMatchFailedEvents ?? [];
      const seenEventIds = new Set(pending.map((event) => event.eventId));
      const nextPending = [...pending];
      for (const event of events) {
        if (seenEventIds.has(event.eventId)) continue;
        seenEventIds.add(event.eventId);
        nextPending.push(event);
      }
      await this.writeRoomsFile({
        ...file,
        rooms,
        pendingMatchFailedEvents: nextPending,
      });
    });
  }

  listPendingMatchFailedEvents(): Promise<MatchFailedEventOutboxEntry[]> {
    return this.readRoomsFile()
      .then((file) => file.pendingMatchFailedEvents ?? []);
  }

  acknowledgeMatchFailedEvent(eventId: string): Promise<void> {
    return this.enqueueRoomWrite(async () => {
      const file = await this.readRoomsFile();
      const pending = file.pendingMatchFailedEvents ?? [];
      if (!pending.some((event) => event.eventId === eventId)) return;
      await this.writeRoomsFile({
        ...file,
        pendingMatchFailedEvents: pending.filter((event) => event.eventId !== eventId),
      });
    });
  }

  saveRoomsAndAcknowledgeMatchFailedEvent(
    rooms: MatchRoomRecord[],
    eventId: string,
  ): Promise<void> {
    return this.enqueueRoomWrite(async () => {
      const file = await this.readRoomsFile();
      await this.writeRoomsFile({
        ...file,
        rooms,
        pendingMatchFailedEvents: (file.pendingMatchFailedEvents ?? []).filter((event) => event.eventId !== eventId),
      });
    });
  }

  listPendingBackupCleanupMatchIds(): Promise<string[]> {
    return this.readRoomsFile().then((file) => file.pendingBackupCleanupMatchIds ?? []);
  }

  savePendingBackupCleanupMatchIds(matchIds: string[]): Promise<void> {
    return this.enqueueRoomWrite(async () => {
      const file = await this.readRoomsFile();
      assertRoomsFile({ ...file, pendingBackupCleanupMatchIds: matchIds });
      await this.writeRoomsFile({
        ...file,
        pendingBackupCleanupMatchIds: [...new Set(matchIds)],
      });
    });
  }

  private async writeRoomsFile(file: RoomsFile): Promise<void> {
    assertRoomsFile(file);
    await writeJsonFileAtomic(this.roomsPath, file);
  }

  private async readFile(filePath: string, fallback: unknown): Promise<unknown> {
    try {
      return await readJsonFile<unknown>(filePath, fallback);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Invalid matchmaking " + path.basename(filePath) + " at <root>");
      }
      throw error;
    }
  }

  private async readQueueFile(): Promise<QueueFile> {
    const file = await this.readFile(this.queuePath, { queue: [] });
    assertQueueFile(file);
    return file;
  }

  private async readPartiesFile(): Promise<PartiesFile> {
    const file = await this.readFile(this.partiesPath, { parties: [] });
    assertPartiesFile(file);
    return file;
  }

  private async readInvitationsFile(): Promise<PartyInvitationsFile> {
    const file = await this.readFile(this.invitationsPath, { invitations: [] });
    assertInvitationsFile(file);
    return file;
  }

  private async readRoomsFile(): Promise<RoomsFile> {
    const file = await this.readFile(this.roomsPath, { rooms: [] });
    assertRoomsFile(file);
    return file;
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
    const queueFile = await this.readQueueFile();
    const queue = queueFile.queue.length > 0 ? [] : queueFile.queue;
    if (queue !== queueFile.queue) {
      const next = { ...queueFile, queue };
      assertQueueFile(next);
      await writeJsonFileAtomic(this.queuePath, next);
    }
  }

  private enqueueRoomWrite(write: () => Promise<void>): Promise<void> {
    const next = this.roomWrites.then(() => write(), () => write());
    this.roomWrites = next.catch(() => undefined);
    return next;
  }
}
