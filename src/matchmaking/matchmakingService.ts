import { randomUUID } from "node:crypto";
import type { AccountService } from "../accounts/accountService.js";
import type { AccountRecord } from "../accounts/accountTypes.js";
import type { BotCatalog } from "../bots/botCatalog.js";
import type { FriendListDto } from "../friends/friendService.js";
import type { CompetMatchHalfScores, CompetMatchPlayerStats, CompetSideHalfScore } from "../game/competMatchStats.js";
import type { Get5MatchSeriesResult } from "../game/get5MatchResult.js";
import { calculateHltvRating2 } from "../game/matchRating.js";
import type { MatchConnectInfo, MatchServerExitReport } from "../game/matchExecutor.js";
import { DEFAULT_RANKME_SCORE, lookupRankmeScore, type RankmeScoreReader } from "../rankme/rankmeScoreStore.js";
import { rankmeDisplayFromLookup, type RankmeDisplay } from "../rankme/rankmeStandings.js";
import type { GamePresenceChange, PresenceService } from "../presence/presenceService.js";
import { PRELOAD_RESOURCE_VERSION, type RealtimeEvent } from "../realtime/realtimeTypes.js";
import type { CompletedMatchRecord, MatchRecordStore } from "../records/matchRecordStore.js";
import { assignDevTeams, assignTeams } from "./teamAssignment.js";
import type { PartyInvitationDto } from "./partyInvitationTypes.js";
import type { GameSide, MatchHalfScore, MatchParticipant, MatchPlan, MatchPlayerResult, MatchSeriesResult, MatchTeam, TeamSide } from "./types.js";
import {
  MatchmakingStore,
  type MatchMapSelectionState,
  type MatchRoomReadyState,
  type MatchRoomRecord,
  type PartyInvitationRecord,
  type PartyRecord,
  type QueueEntry,
} from "./matchmakingStore.js";

const DEFAULT_MAP_POOL = ["de_mirage", "de_inferno", "de_nuke", "de_cache", "de_dust2", "de_ancient", "de_anubis"];
const MAP_RANDOMIZATION_MS = 7_000;
const MAP_RANDOMIZATION_REEL_LENGTH = 20;
const RECENT_MAP_EXCLUSION_COUNT = 3;
const MAX_PARTY_HUMANS = 5;
const PRELOAD_TIMEOUT_MS = 45_000;
const PARTY_INVITE_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 45_000;

const TERMINAL_ROOM_MEMORY_TTL_MS = 60 * 60 * 1000;

function mergeMatchResultPlayers(
  room: MatchRoomRecord,
  competStats: CompetMatchPlayerStats[],
): MatchPlayerResult[] {
  const competBySteam64 = new Map(competStats.filter((stats) => stats.steam64).map((stats) => [stats.steam64, stats]));
  const competByName = new Map<string, CompetMatchPlayerStats>();
  for (const stats of competStats) {
    const name = normalizePlayerName(stats.name);
    if (name && !competByName.has(name)) {
      competByName.set(name, stats);
    }
  }
  return [
    ...room.teamA.participants.map((participant) => mergeParticipantResult(participant, "teamA", competBySteam64, competByName)),
    ...room.teamB.participants.map((participant) => mergeParticipantResult(participant, "teamB", competBySteam64, competByName)),
  ];
}

function alignGet5ResultToRoom(room: MatchRoomRecord, result: Get5MatchSeriesResult): Get5MatchSeriesResult {
  if (!shouldSwapGet5Teams(room, result.players)) return result;
  return {
    ...result,
    winner: oppositeTeam(result.winner),
    team1SeriesScore: result.team2SeriesScore,
    team2SeriesScore: result.team1SeriesScore,
    team1Score: result.team2Score,
    team2Score: result.team1Score,
    team1StartingSide: result.team2StartingSide,
    team2StartingSide: result.team1StartingSide,
  };
}

function shouldSwapGet5Teams(room: MatchRoomRecord, players: Get5MatchSeriesResult["players"]): boolean {
  const roomTeamA = new Set(room.teamA.participants.map((participant) => participant.steam64).filter(Boolean));
  const roomTeamB = new Set(room.teamB.participants.map((participant) => participant.steam64).filter(Boolean));
  let direct = 0;
  let swapped = 0;

  for (const player of players) {
    if (!player.steam64) continue;
    if (player.team === "teamA") {
      if (roomTeamA.has(player.steam64)) direct++;
      if (roomTeamB.has(player.steam64)) swapped++;
    } else {
      if (roomTeamB.has(player.steam64)) direct++;
      if (roomTeamA.has(player.steam64)) swapped++;
    }
  }

  return swapped > direct;
}

function oppositeTeam(team: TeamSide): TeamSide {
  return team === "teamA" ? "teamB" : "teamA";
}

function matchHalfScoresForRoom(
  halfScores: CompetMatchHalfScores | undefined,
  result: Get5MatchSeriesResult,
): { firstHalfScore?: MatchHalfScore; secondHalfScore?: MatchHalfScore } {
  if (!halfScores) return {};
  return matchHalfScoresForSides(result.team1StartingSide, result.team2StartingSide, halfScores);
}

function matchHalfScoresForSides(
  team1StartingSide: GameSide,
  team2StartingSide: GameSide,
  halfScores: CompetMatchHalfScores,
): { firstHalfScore?: MatchHalfScore; secondHalfScore?: MatchHalfScore } {
  return {
    ...(halfScores.firstHalfScore ? { firstHalfScore: matchHalfScoreForSides(team1StartingSide, team2StartingSide, halfScores.firstHalfScore) } : {}),
    ...(halfScores.secondHalfScore ? {
      secondHalfScore: matchHalfScoreForSides(
        oppositeGameSide(team1StartingSide),
        oppositeGameSide(team2StartingSide),
        halfScores.secondHalfScore,
      ),
    } : {}),
  };
}

function matchHalfScoreForSides(team1Side: GameSide, team2Side: GameSide, halfScore: CompetSideHalfScore): MatchHalfScore {
  return {
    team1Score: halfScore[team1Side],
    team2Score: halfScore[team2Side],
  };
}

function oppositeGameSide(side: GameSide): GameSide {
  return side === "t" ? "ct" : "t";
}

function mergeParticipantResult(
  participant: MatchParticipant,
  team: TeamSide,
  competBySteam64: Map<string, CompetMatchPlayerStats>,
  competByName: Map<string, CompetMatchPlayerStats>,
): MatchPlayerResult {
  const stats = findCompetStats(participant, competBySteam64, competByName);
  const humanName = participant.steamPersonaName?.trim()
    || stats?.name.trim()
    || participant.displayName.trim()
    || participant.steam64
    || "";
  const botName = stats?.name.trim()
    || participant.botProfileName?.trim()
    || participant.displayName.trim()
    || "";
  const avatarUrl = participant.kind === "human" ? participant.steamAvatarUrl?.trim() : undefined;
  const kills = stats?.kills ?? 0;
  const deaths = stats?.deaths ?? 0;
  const assists = stats?.assists ?? 0;
  const damage = stats?.damage ?? 0;
  const rating2 = calculateHltvRating2(
    { kills, deaths, assists, damage },
    stats?.kastRounds,
    stats?.roundsPlayed,
  );
  return {
    steam64: participant.steam64 ?? stats?.steam64 ?? "",
    name: participant.kind === "human" ? humanName : botName,
    kind: participant.kind,
    ...(participant.botCategory ? { botCategory: participant.botCategory } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    team,
    kills,
    deaths,
    assists,
    damage,
    headshots: stats?.headshots ?? 0,
    ...(rating2 !== undefined ? { rating2 } : {}),
  };
}

function findCompetStats(
  participant: MatchParticipant,
  competBySteam64: Map<string, CompetMatchPlayerStats>,
  competByName: Map<string, CompetMatchPlayerStats>,
): CompetMatchPlayerStats | undefined {
  if (participant.steam64) {
    const bySteam64 = competBySteam64.get(participant.steam64);
    if (bySteam64) return bySteam64;
  }
  if (participant.kind !== "bot") return undefined;
  return competByName.get(normalizePlayerName(participant.botProfileName))
    ?? competByName.get(normalizePlayerName(participant.displayName));
}

function normalizePlayerName(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isSoloOpenParty(party: PartyRecord): boolean {
  return (party.status ?? "open") === "open" && party.memberAccountIds.length === 1;
}
type ReadyTimeoutHandle = ReturnType<typeof setTimeout>;
type ReadyTimeoutScheduler = (handler: () => void, timeoutMs: number) => ReadyTimeoutHandle;
type ReadyTimeoutCanceler = (handle: ReadyTimeoutHandle) => void;

export interface MatchExecutorPort {
  prepare(plan: MatchPlan): Promise<MatchConnectInfo>;
  deleteMatchArtifacts?(matchId: string): Promise<void>;
  stopGameServerPresence?(matchId: string): Promise<void>;
}

export interface MatchDatabaseBackup {
  create(matchId: string, signal?: AbortSignal): Promise<void>;
  restore(matchId: string, options?: { preserveBackup?: boolean }): Promise<void>;
  discard(matchId: string): Promise<void>;
}

export interface MatchmakingServiceDeps {
  store: MatchmakingStore;
  accounts: AccountService;
  friends?: { listFriends(accountId: string): Promise<FriendListDto> };
  botCatalog: BotCatalog;
  executor?: MatchExecutorPort;
  databaseBackup?: MatchDatabaseBackup;
  records?: Pick<MatchRecordStore, "appendEvent" | "completeMatch" | "cleanupCompletedMatchFiles" | "deleteMatch" | "listPlayerCompletedMatches" | "listRecentMatchMaps" | "readCompletedMatch" | "readMatchPlan" | "saveMatchPlan" | "saveStatus">;
  rankme?: RankmeScoreReader;
  events?: { publish(event: RealtimeEvent): void };
  presence?: Pick<PresenceService, "get" | "replaceInGameAccounts">;
  steamPersonas?: {
    displayName(steam64: string): string;
  };
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

export interface PublicPartyRecord extends PartyRecord {
  rankmeStandings: Record<string, RankmeDisplay | null>;
}

export interface MatchmakingOccupancySummary {
  activeCount: number;
}

interface CommittedMatchRepair {
  room: MatchRoomRecord;
  cleanupComplete: boolean;
}

interface CommittedMatchReconciliation {
  room: MatchRoomRecord;
  retryRequired: boolean;
}

export class MatchmakingService {
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly random?: () => number;
  private readonly setTimeoutFn: ReadyTimeoutScheduler;
  private readonly clearTimeoutFn: ReadyTimeoutCanceler;
  private readonly unrefReadyTimeouts: boolean;
  private readonly partyInviteTimeouts = new Map<string, ReadyTimeoutHandle>();
  private readonly partyMatchmakingTimeouts = new Map<string, { startAt: string; timeout: ReadyTimeoutHandle }>();
  private readonly readyTimeouts = new Map<string, ReadyTimeoutHandle>();
  private readonly mapRevealTimers = new Map<string, ReadyTimeoutHandle>();
  private readonly recoveredOfflineTimers = new Map<string, { matchId: string; timeout: ReadyTimeoutHandle }>();
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private readonly matchTasks = new Map<string, { controller: AbortController; backup: Promise<void>; prepare?: Promise<void>; cancelled: boolean }>();

  private ensureMatchTask(matchId: string) {
    let task = this.matchTasks.get(matchId);
    if (!task) {
      const controller = new AbortController();
      const backup = Promise.resolve().then(() => this.deps.databaseBackup?.create(matchId, controller.signal));
      task = { controller, backup, cancelled: false };
      this.matchTasks.set(matchId, task);
      void backup.catch(() => undefined);
    }
    return task;
  }

  private async stopMatchTask(matchId: string): Promise<void> {
    this.clearRecoveredOfflineTimers(matchId);
    const task = this.matchTasks.get(matchId);
    if (task) {
      task.cancelled = true;
      task.controller.abort();
      await task.backup.catch(() => undefined);
      await task.prepare?.catch(() => undefined);
    }
    await this.deps.databaseBackup?.discard(matchId);
    this.matchTasks.delete(matchId);
  }

  constructor(private readonly deps: MatchmakingServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.idFactory = deps.idFactory ?? randomUUID;
    this.random = deps.random;
    this.setTimeoutFn = deps.setTimeout ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeout ?? clearTimeout;
    this.unrefReadyTimeouts = deps.unrefReadyTimeouts ?? true;
  }

  private readonly cleanupTasks = new Set<Promise<void>>();

  private clearPendingTimeouts(): void {
    this.clearRecoveredOfflineTimers();
    for (const entry of this.partyMatchmakingTimeouts.values()) this.clearTimeoutFn(entry.timeout);
    for (const timer of [...this.readyTimeouts.values(), ...this.mapRevealTimers.values(), ...this.partyInviteTimeouts.values()]) this.clearTimeoutFn(timer);
    this.partyMatchmakingTimeouts.clear();
    this.readyTimeouts.clear();
    this.mapRevealTimers.clear();
    this.partyInviteTimeouts.clear();
  }

  async stopBackgroundTasks(): Promise<void> {
    this.clearPendingTimeouts();
    for (const task of this.matchTasks.values()) { task.cancelled = true; task.controller.abort(); }
    await Promise.allSettled([...this.matchTasks.values()].flatMap((task) => [task.backup, ...(task.prepare ? [task.prepare] : [])]));
    await Promise.allSettled([...this.cleanupTasks]);
    await this.mutationQueue;
    this.clearPendingTimeouts();
  }

  async resumePendingTimeouts(): Promise<void> {
    const [rooms, parties] = await Promise.all([
      this.deps.store.listRooms(),
      this.deps.store.listParties(),
    ]);
    const resumedParties = parties.map((party) => {
      if (!party.matchmakingPendingAt || (party.preload && party.lockedMatchId)) return party;
      return { ...party, matchmakingPendingAt: undefined, matchmakingDev: undefined, lockedMatchId: undefined, updatedAt: this.now() };
    });
    if (resumedParties.some((party, index) => party !== parties[index])) {
      await this.deps.store.saveParties(resumedParties);
    }

    for (const party of resumedParties) {
      if (party.preload?.cancelled) {
        await this.cancelScheduledPartyMatchmaking(party.id, party.preload.deadlineAt);
      } else {
        if (party.lockedMatchId && (party.preload || rooms.some((room) => room.id === party.lockedMatchId && ["ready", "map_randomizing"].includes(room.phase)))) {
          this.ensureMatchTask(party.lockedMatchId);
        }
        const matchId = party.lockedMatchId;
        for (const accountId of party.memberAccountIds) {
          if (!matchId) continue;
          const current = (await this.deps.store.listParties()).find((entry) => entry.id === party.id);
          if (current?.lockedMatchId !== matchId) break;
          if (this.isConfirmedOffline(accountId)) {
            await this.handleAccountOffline(accountId, matchId);
          } else {
            this.scheduleRecoveredOfflineCheck(accountId, matchId);
          }
        }
      }
    }
    // Reconciliation may have advanced or cancelled a persisted stage.
    for (const room of await this.deps.store.listRooms()) {
      if (room.phase === "ready" && room.ready?.length && room.ready.every((entry) => entry.ready)) {
        await this.acceptReady(room.ready[0]!.accountId);
      } else {
        this.scheduleMapReveal(room);
        this.scheduleReadyTimeout(room);
      }
    }
    for (const party of await this.deps.store.listParties()) {
      this.schedulePartyMatchmakingStart(party);
    }
  }
  createParty(ownerAccountId: string): Promise<PublicPartyRecord> {
    return this.enqueueMutation(async () => {
      await this.requireAccount(ownerAccountId);
      const parties = await this.deps.store.listParties();
      const existing = parties.find((candidate) => candidate.memberAccountIds.includes(ownerAccountId));
      if (existing) return this.toPlayerPublicParty(existing);
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
      const publicParty = await this.toPlayerPublicParty(party);
      await this.emitPartyUpdated(publicParty);
      return publicParty;
    });
  }

  async getPartyForAccount(accountId: string): Promise<PublicPartyRecord | undefined> {
    await this.requireAccount(accountId);
    const parties = await this.deps.store.listParties();
    const party = parties.find((candidate) => candidate.memberAccountIds.includes(accountId) && !isSoloOpenParty(candidate));
    return party ? this.toPlayerPublicParty(party) : undefined;
  }

  joinParty(partyId: string, accountId: string): Promise<PublicPartyRecord> {
    return this.enqueueMutation(async () => {
      await this.requireAccount(accountId);
      const parties = await this.deps.store.listParties();
      const party = parties.find((candidate) => candidate.id === partyId);
      if (!party) throw new Error(`party not found: ${partyId}`);
      this.requireOpenParty(party);
      if (party.memberAccountIds.includes(accountId)) return this.toPlayerPublicParty(party);
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
      const publicParty = await this.toPlayerPublicParty(updated);
      await this.emitPartyUpdated(publicParty);
      return publicParty;
    });
  }

  async leaveParty(accountId: string): Promise<void> {
    const snapshot = (await this.deps.store.listParties()).find((entry) => entry.memberAccountIds.includes(accountId));
    if (snapshot?.preload) await this.cancelScheduledPartyMatchmaking(snapshot.id, snapshot.preload.deadlineAt);
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
            matchmakingPendingAt: undefined,
            lockedMatchId: undefined,
            preload: undefined,
            matchmakingDev: undefined,
            updatedAt: this.now(),
          }
        : undefined;
      const updated = nextParty
        ? parties.map((candidate) => (candidate.id === party.id ? nextParty : candidate))
        : parties.filter((candidate) => candidate.id !== party.id);

      await this.deps.store.saveParties(updated);
      this.clearPartyMatchmakingTimeout(party.id);
      if (ownerLeft) await this.expirePendingInvitationsForParty(party.id);
      await this.emit({ type: "party_updated", accountIds: [accountId, ...remainingMemberIds], party: nextParty ?? null });
      if (party.matchmakingPendingAt) await this.emitOccupancyUpdated();
    });
  }

  async handleAccountOffline(accountId: string, expectedMatchId?: string): Promise<void> {
    const action = await this.enqueueMutation(async () => {
      const activeParties = await this.deps.store.listParties();
      const activeParty = activeParties.find((p) => p.memberAccountIds.includes(accountId) && p.lockedMatchId);
      if (expectedMatchId && activeParty?.lockedMatchId !== expectedMatchId) return;
      if (activeParty) {
        const rooms = await this.deps.store.listRooms();
        const room = rooms.find((r) => r.id === activeParty.lockedMatchId);
        if (activeParty.matchmakingPendingAt) {
          if (activeParty.memberAccountIds.every((id) => this.isConfirmedOffline(id))) return { cancel: activeParty.id, deadline: activeParty.preload?.deadlineAt };
          if (activeParty.memberAccountIds.every((id) => this.isConfirmedOffline(id) || activeParty.preload?.completedAccountIds.includes(id))) return { start: activeParty.ownerAccountId, matchId: activeParty.lockedMatchId };
          return;
        }
        if (room && ["ready", "map_randomizing"].includes(room.phase)) {
          if (this.roomAudience(room).every((id) => this.isConfirmedOffline(id))) {
            await this.failMatchRoom(rooms, room, "match_failed");
          } else if (room.phase === "ready" && this.isConfirmedOffline(accountId)) {
            if (room.readyDeadlineAt) return { ready: accountId };
            const updated = { ...room, ready: room.ready?.map((entry) => entry.accountId === accountId ? { ...entry, ready: true, respondedAt: this.now() } : entry) };
            await this.deps.store.saveRooms(rooms.map((entry) => entry.id === room.id ? updated : entry));
            await this.emitRoomUpdated(updated);
          }
        }
        return;
      }
      await this.expirePendingInvitationsForAccount(accountId);
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
            matchmakingPendingAt: undefined,
            lockedMatchId: undefined,
            preload: undefined,
            matchmakingDev: undefined,
            updatedAt: this.now(),
          }
        : undefined;
      const updated = nextParty
        ? parties.map((candidate) => (candidate.id === party.id ? nextParty : candidate))
        : parties.filter((candidate) => candidate.id !== party.id);

      await this.deps.store.saveParties(updated);
      this.clearPartyMatchmakingTimeout(party.id);
      if (ownerLeft) await this.expirePendingInvitationsForParty(party.id);
      await this.emit({ type: "party_updated", accountIds: [accountId, ...remainingMemberIds], party: nextParty ?? null });
      if (party.matchmakingPendingAt) await this.emitOccupancyUpdated();
    });
    if (action?.cancel) await this.cancelScheduledPartyMatchmaking(action.cancel, action.deadline);
    if (action?.start) await this.startPartyMatchmaking(action.start, {}, action.matchId);
    if (action?.ready) await this.acceptReady(action.ready);
  }

  private clearRecoveredOfflineTimers(matchId?: string): void {
    for (const [accountId, entry] of this.recoveredOfflineTimers) {
      if (matchId && entry.matchId !== matchId) continue;
      this.clearTimeoutFn(entry.timeout);
      this.recoveredOfflineTimers.delete(accountId);
    }
  }

  private scheduleRecoveredOfflineCheck(accountId: string, matchId: string): void {
    const existing = this.recoveredOfflineTimers.get(accountId);
    if (existing) {
      this.clearTimeoutFn(existing.timeout);
      this.recoveredOfflineTimers.delete(accountId);
    }
    const state = this.deps.presence?.get(accountId);
    if (!state || state.online) return;
    const remainingMs = state.lastSeenAt ? Date.parse(state.lastSeenAt) + 8000 - Date.parse(this.now()) : 0;
    if (!Number.isFinite(remainingMs)) return;
    const timeout = this.setTimeoutFn(() => {
      if (this.recoveredOfflineTimers.get(accountId)?.timeout !== timeout) return;
      this.recoveredOfflineTimers.delete(accountId);
      if (!this.isConfirmedOffline(accountId)) {
        this.scheduleRecoveredOfflineCheck(accountId, matchId);
        return;
      }
      const task = this.handleAccountOffline(accountId, matchId).catch(() => undefined);
      this.cleanupTasks.add(task);
      void task.finally(() => this.cleanupTasks.delete(task));
    }, Math.max(0, remainingMs));
    if (this.unrefReadyTimeouts) timeout.unref?.();
    this.recoveredOfflineTimers.set(accountId, { matchId, timeout });
  }

  private isConfirmedOffline(accountId: string): boolean {
    const state = this.deps.presence?.get(accountId);
    return Boolean(state && !state.online && (!state.lastSeenAt || Date.parse(this.now()) - Date.parse(state.lastSeenAt) >= 8000));
  }

  async isMatchmakingParticipant(accountId: string): Promise<boolean> {
    const parties = await this.deps.store.listParties();
    const party = parties.find((entry) => entry.memberAccountIds.includes(accountId) && entry.lockedMatchId);
    if (!party || party.preload?.cancelled) return false;
    if (party.preload) return true;
    return (await this.deps.store.listRooms()).some((room) => room.id === party.lockedMatchId && !isTerminalMatchPhase(room.phase));
  }

  updateGameServerPresence(matchId: string, steam64s: readonly string[]): Promise<void> {
    return this.enqueueMutation(async () => {
      const room = (await this.deps.store.listRooms()).find((candidate) => (
        candidate.id === matchId && !isTerminalMatchPhase(candidate.phase)
      ));
      if (!room || !this.deps.presence) return;

      const activeSteam64s = new Set(steam64s.filter((steam64) => steam64.trim().length > 0));
      const inGameAccountIds = this.humanParticipantsForRoom(room)
        .filter((participant) => participant.steam64 && activeSteam64s.has(participant.steam64))
        .map((participant) => participant.accountId as string);
      await this.publishGamePresenceChanges(this.deps.presence.replaceInGameAccounts(inGameAccountIds));
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
      if (this.deps.presence?.get(toAccountId).inGame) throw new Error("party invitation target is in game");

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
      const publicInvitation = await this.toPartyInvitationDto(invitation);
      await this.emit({ type: "party_invite_received", accountIds: [ownerAccountId, toAccountId], invitation: publicInvitation });
      return publicInvitation;
    });
  }

  acceptPartyInvite(accountId: string, invitationId: string): Promise<PublicPartyRecord> {
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
      const publicParty = await this.toPlayerPublicParty(updated);
      await this.emitPartyUpdated(publicParty);
      return publicParty;
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

  async beginPartyMatchmaking(ownerAccountId: string, options: { dev?: boolean } = {}): Promise<PublicPartyRecord> {
    const accepted = await this.enqueueMutation(async () => {
      const ownerAccount = await this.requireMatchmakingAccount(ownerAccountId);
      const parties = await this.deps.store.listParties();
      const party = parties.find((candidate) => candidate.memberAccountIds.includes(ownerAccountId));
      if (!party) throw new Error(`party not found for owner: ${ownerAccountId}`);
      if (party.ownerAccountId !== ownerAccountId) throw new Error("party owner required");
      this.requireOpenParty(party, true);
      if (party.preload?.cancelled) throw new Error("match cancellation is in progress");
      if (party.matchmakingPendingAt && party.preload && party.lockedMatchId) return this.toPlayerPublicParty(party);
      await Promise.all(party.memberAccountIds.map((accountId) => this.requireMatchmakingAccount(accountId)));
      if (this.hasActiveMatchmaking(await this.deps.store.listRooms(), parties)) {
        throw new Error("matchmaking is already active");
      }

      const now = this.now();
      const updatedParty: PartyRecord = {
        ...party,
        matchmakingPendingAt: now,
        lockedMatchId: this.idFactory(),
        preload: { resourceVersion: PRELOAD_RESOURCE_VERSION, completedAccountIds: [], deadlineAt: new Date(Date.parse(now) + PRELOAD_TIMEOUT_MS).toISOString() },
        matchmakingDev: options.dev === true && ownerAccount.dev === true ? true : undefined,
        updatedAt: now,
      };
      await this.deps.store.saveParties(parties.map((candidate) => (candidate.id === party.id ? updatedParty : candidate)));
      this.ensureMatchTask(updatedParty.lockedMatchId!);
      this.schedulePartyMatchmakingStart(updatedParty);
      const publicParty = await this.toPlayerPublicParty(updatedParty);
      await this.emitPartyUpdated(publicParty);
      await this.emitOccupancyUpdated();
      return publicParty;
    });
    return accepted;
  }

  async cancelPartyMatchmaking(ownerAccountId: string): Promise<PublicPartyRecord | undefined> {
    const party = await this.enqueueMutation(async () => {
      const found = (await this.deps.store.listParties()).find((entry) => entry.memberAccountIds.includes(ownerAccountId));
      if (found && found.ownerAccountId !== ownerAccountId) throw new Error("party owner required");
      return found;
    });
    if (!party) return undefined;
    if (party.preload) await this.cancelScheduledPartyMatchmaking(party.id, party.preload.deadlineAt);
    const current = (await this.deps.store.listParties()).find((entry) => entry.id === party.id);
    return current ? this.toPlayerPublicParty(current) : undefined;
  }

  startPartyMatchmaking(ownerAccountId: string, options: { dev?: boolean } = {}, expectedMatchId?: string): Promise<PublicMatchRoomRecord> {
    return this.enqueueMutation(async () => {
      const ownerAccount = await this.requireMatchmakingAccount(ownerAccountId);
      const parties = await this.deps.store.listParties();
      const party = parties.find((candidate) => candidate.memberAccountIds.includes(ownerAccountId));
      if (!party) throw new Error(`party not found for owner: ${ownerAccountId}`);
      if (party.ownerAccountId !== ownerAccountId) throw new Error("party owner required");
      if (expectedMatchId && party.lockedMatchId !== expectedMatchId) throw new Error("match preload is not active");
      const existingRooms = this.pruneTerminalRooms(await this.deps.store.listRooms(), parties);
      const lockedRoom = party.lockedMatchId
        ? existingRooms.find((candidate) => (
            candidate.id === party.lockedMatchId
            && candidate.partyId === party.id
            && !isTerminalMatchPhase(candidate.phase)
          ))
        : undefined;
      if ((party.status ?? "open") === "matchmaking" && lockedRoom) {
        return this.toPlayerPublicRoom(lockedRoom, ownerAccountId);
      }
      this.requireOpenParty(party, true);
      if (!party.preload || party.preload.cancelled || !party.lockedMatchId || !party.memberAccountIds.some((id) => !this.isConfirmedOffline(id)) || !party.memberAccountIds.every((id) => this.isConfirmedOffline(id) || party.preload!.completedAccountIds.includes(id))) throw new Error("match preload is incomplete");
      const useDev = party.matchmakingDev === true && ownerAccount.dev === true;
      if (party.memberAccountIds.length > MAX_PARTY_HUMANS) throw new Error("party is full");
      await Promise.all(party.memberAccountIds.map((accountId) => this.requireMatchmakingAccount(accountId)));
      if (this.hasActiveMatchmaking(existingRooms, parties, { allowedPendingPartyId: party.id })) {
        throw new Error("matchmaking is already active");
      }

      const startedAt = this.now();
      const humans = await Promise.all(party.memberAccountIds.map((accountId) => this.toHumanParticipant(accountId)));
      const teams = useDev
        ? assignDevTeams({
            humans,
            botCandidates: this.deps.botCatalog.candidates,
            botRosters: this.deps.botCatalog.rosters,
            random: this.random,
          })
        : assignTeams({ humans, parties, botCandidates: this.deps.botCatalog.candidates, botRosters: this.deps.botCatalog.rosters, random: this.random });
      const [teamA, teamB] = await Promise.all([
        this.withRankmeStandings(teams.teamA),
        this.withRankmeStandings(teams.teamB),
      ]);
      const participants = [...teamA.participants, ...teamB.participants];
      const humanAccountIds = humans.map((participant) => participant.accountId ?? participant.id);
      const room: MatchRoomRecord = {
        id: party.lockedMatchId,
        phase: "ready",
        ...(useDev ? { dev: true as const } : {}),
        teamA,
        teamB,
        humanAccountIds,
        botParticipantIds: participants.filter((participant) => participant.kind === "bot").map((participant) => participant.id),
        ready: this.buildReadyStates(humans).map((entry) => this.isConfirmedOffline(entry.accountId) ? { ...entry, ready: true, respondedAt: startedAt } : entry),
        readyDeadlineAt: this.buildReadyDeadlineAt(startedAt),
        partyId: party.id,
        createdAt: startedAt,
      };
      const updatedParty: PartyRecord = {
        ...party,
        status: "matchmaking",
        lockedMatchId: room.id,
        matchmakingPendingAt: undefined,
        preload: undefined,
        matchmakingDev: undefined,
        updatedAt: startedAt,
      };
      const rooms = [...existingRooms, room];

      await this.deps.store.saveRooms(rooms);
      await this.deps.store.saveParties(parties.map((candidate) => (candidate.id === party.id ? updatedParty : candidate)));
      this.clearPartyMatchmakingTimeout(party.id);
      await this.expirePendingInvitationsForParty(party.id);
      this.scheduleReadyTimeout(room);
      const publicParty = await this.toPlayerPublicParty(updatedParty);
      await this.emitPartyUpdated(publicParty);
      await this.emitOccupancyUpdated();
      await this.emitReadyRoomCreatedPerAccount(room);
      await this.emit(this.toReadyEvent("ready_check_started", room));
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

      let mapSelection: MatchMapSelectionState;
      try { mapSelection = await this.buildMapSelection(acceptedAt); }
      catch { return this.toPublicRoom(await this.failMatchRoom(updatedRooms, updatedReadyRoom, "match_failed")); }
      const randomizingRoom: MatchRoomRecord = {
        ...updatedReadyRoom,
        phase: "map_randomizing",
        readyDeadlineAt: undefined,
        mapSelection,
      };
      const finalizedRooms = updatedRooms.map((candidate) => (candidate.id === room.id ? randomizingRoom : candidate));

      try { await this.deps.records?.saveMatchPlan(await this.buildMatchPlan(randomizingRoom, mapSelection.finalMap)); }
      catch { return this.toPublicRoom(await this.failMatchRoom(updatedRooms, updatedReadyRoom, "match_failed")); }
      await this.deps.store.saveRooms(finalizedRooms);
      this.clearReadyTimeout(room.id);
      this.scheduleMapReveal(randomizingRoom);

      await this.emitRoomUpdated(randomizingRoom);
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
      const readyEntry = room.ready?.find((entry) => entry.accountId === accountId);
      if (!readyEntry) throw new Error("ready state not found for account");
      if (readyEntry.ready) throw new Error("ready response is already accepted");
      const declinedParticipant = this.humanParticipantsForRoom(room).find(
        (participant) => participant.accountId === accountId,
      );
      if (!declinedParticipant) throw new Error("ready participant not found for account");
      const readyDeclinedByDisplayName = this.displayNameForSteam64(declinedParticipant.steam64 ?? "");
      return this.toPublicRoom(await this.failMatchRoom(rooms, room, "match_failed", readyDeclinedByDisplayName));
    });
  }

  expireReady(roomId: string): Promise<PublicMatchRoomRecord> {
    return this.enqueueMutation(async () => {
      const rooms = await this.deps.store.listRooms();
      const room = rooms.find((candidate) => candidate.id === roomId && candidate.phase === "ready");
      if (!room) throw new Error(`ready room not found: ${roomId}`);
      return this.toPublicRoom(await this.failMatchRoom(rooms, room, "match_failed"));
    });
  }

  async getState(accountId: string): Promise<{
    queue: QueueEntry[];
    rooms: PublicMatchRoomRecord[];
    party: PublicPartyRecord | null;
    partyInvitations: PartyInvitationDto[];
    room: PublicMatchRoomRecord | null;
    occupancy: MatchmakingOccupancySummary;
  }> {
    const snapshot = await this.enqueueMutation(async () => {
      const queue = (await this.deps.store.listQueue()).filter((entry) => entry.accountId === accountId);
      const parties = await this.deps.store.listParties();
      const allRooms = this.pruneTerminalRooms(await this.deps.store.listRooms(), parties);
      const rooms = allRooms
        .filter((room) => this.roomHasAccount(room, accountId))
        .map((room) => this.toPlayerPublicRoom(room, accountId));
      const partyRecord = parties.find((candidate) => candidate.memberAccountIds.includes(accountId) && !isSoloOpenParty(candidate)) ?? null;
      const pendingInvitations = (await this.deps.store.listInvitations()).filter(
        (invitation) => invitation.toAccountId === accountId && invitation.status === "pending" && !this.isPartyInviteOverdue(invitation),
      );
      return {
        queue,
        rooms,
        partyRecord,
        pendingInvitations,
        occupancy: this.occupancySummary(allRooms, parties),
      };
    });

    const party = snapshot.partyRecord ? await this.toPlayerPublicParty(snapshot.partyRecord) : null;
    const partyInvitations = await Promise.all(
      snapshot.pendingInvitations.map((invitation) => this.toPartyInvitationDto(invitation)),
    );
    return {
      queue: snapshot.queue,
      rooms: snapshot.rooms,
      party,
      partyInvitations,
      room: this.findCurrentRoom(snapshot.rooms),
      occupancy: snapshot.occupancy,
    };
  }

  async getOccupancy(): Promise<MatchmakingOccupancySummary> {
    const [rooms, parties] = await Promise.all([
      this.deps.store.listRooms(),
      this.deps.store.listParties(),
    ]);
    return this.occupancySummary(this.pruneTerminalRooms(rooms, parties), parties);
  }

  private occupancySummary(rooms: MatchRoomRecord[], parties: PartyRecord[]): MatchmakingOccupancySummary {
    return { activeCount: this.hasActiveMatchmaking(rooms, parties) ? 1 : 0 };
  }

  private hasActiveMatchmaking(
    rooms: MatchRoomRecord[],
    parties: PartyRecord[],
    options: { allowedPendingPartyId?: string } = {},
  ): boolean {
    if (rooms.some((room) => !isTerminalMatchPhase(room.phase))) return true;
    return parties.some((party) => (
      (party.id !== options.allowedPendingPartyId && Boolean(party.lockedMatchId))
      || (party.id !== options.allowedPendingPartyId
        && (party.status ?? "open") === "open"
        && Boolean(party.matchmakingPendingAt))
    ));
  }

  async recoverCompletedMatches(): Promise<void> {
    for (const room of await this.deps.store.listRooms()) {
      if (room.phase === "failed") await this.stopMatchTask(room.id);
    }
    return this.enqueueMutation(async () => {
      const records = this.deps.records;
      let rooms = await this.deps.store.listRooms();
      let recoveryFailed = false;
      if (records?.readCompletedMatch) {
        for (const room of rooms) {
          const completedRecord = await records.readCompletedMatch(room.id);
          if (!completedRecord) continue;
          const completed = await this.reconcileCommittedMatch(rooms, room, completedRecord);
          rooms = await this.deps.store.listRooms();
          if (!completed || completed.retryRequired) recoveryFailed = true;
        }
      }
      const parties = await this.deps.store.listParties();
      for (const room of rooms) {
        if (room.phase !== "completed") continue;
        const party = parties.find((candidate) => candidate.lockedMatchId === room.id);
        if (!party) continue;
        try {
          await this.unlockPartyForRoom(room, room.terminalStateAt ?? this.now());
        } catch (error) {
          recoveryFailed = true;
          process.stderr.write(`Failed to recover terminal match party ${room.id}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      for (const room of rooms) {
        if (room.phase !== "failed") continue;
        try {
          await this.deleteFailedMatchArtifacts(room.id);
          await this.unlockPartyForRoom(room, room.terminalStateAt ?? this.now());
        } catch (error) {
          recoveryFailed = true;
          process.stderr.write(`Failed to recover failed match artifacts ${room.id}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      if (recoveryFailed) process.stderr.write("Some match state requires another recovery attempt\n");
    });
  }

  private async recoverCommittedMatch(matchId: string): Promise<void> {
    const records = this.deps.records;
    if (!records?.readCompletedMatch) return;
    const committed = await records.readCompletedMatch(matchId);
    if (!committed) return;
    const rooms = await this.deps.store.listRooms();
    const room = rooms.find((candidate) => candidate.id === matchId);
    if (!room) return;
    const completed = await this.reconcileCommittedMatch(rooms, room, committed);
    if (!completed || completed.retryRequired) throw new Error(`Committed match recovery is incomplete: ${matchId}`);
  }

  private scheduleCommittedMatchRecovery(matchId: string): void {
    void this.enqueueMutation(() => this.recoverCommittedMatch(matchId)).catch((error) => {
      process.stderr.write(
        `Failed to retry completed match recovery ${matchId}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }

  async completeMatchFromServerExit(matchId: string, report: MatchServerExitReport): Promise<PublicMatchRoomRecord | undefined> {
    await this.matchTasks.get(matchId)?.prepare;
    return this.enqueueMutation(async () => {
      const rooms = await this.deps.store.listRooms();
      const room = rooms.find((candidate) => candidate.id === matchId);
      if (!room) return undefined;

      const committed = await this.deps.records?.readCompletedMatch?.(matchId);
      if (committed) {
        return this.finalizeCommittedMatch(rooms, room, committed);
      }
      if (!isServerManagedPhase(room.phase)) return this.toPublicRoom(room);

      if (report.get5Result.status !== "normal") {
        const restoreError = await this.restoreMatchDatabase(matchId);
        if (restoreError) return this.toPublicRoom(room);
        return this.toPublicRoom(await this.failMatchRoom(rooms, room, "match_failed"));
      }

      let result: MatchSeriesResult;
      let savedPlan: MatchPlan | undefined;
      try {
        const alignedGet5Result = alignGet5ResultToRoom(room, report.get5Result.result);
        const { team1StartingSide: _team1StartingSide, team2StartingSide: _team2StartingSide, ...publicGet5Result } = alignedGet5Result;
        savedPlan = await this.readSavedMatchPlan(matchId);
        const players = await this.applyRankmeScores(
          mergeMatchResultPlayers(room, report.competStats),
          savedPlan?.rankmeScoresBefore,
          savedPlan?.dev === true,
        );
        result = {
          ...publicGet5Result,
          team1Name: room.teamA.name,
          ...(room.teamA.logoImage ? { team1LogoImage: room.teamA.logoImage } : {}),
          team2Name: room.teamB.name,
          ...(room.teamB.logoImage ? { team2LogoImage: room.teamB.logoImage } : {}),
          ...matchHalfScoresForRoom(report.competHalfScores, alignedGet5Result),
          players,
        } as MatchSeriesResult;
      } catch (error) {
        process.stderr.write(`Match result processing failed for ${matchId}: ${error instanceof Error ? error.message : String(error)}\n`);
        const restoreError = await this.restoreMatchDatabase(matchId);
        if (restoreError) return this.toPublicRoom(room);
        return this.toPublicRoom(await this.failMatchRoom(rooms, room, "match_failed"));
      }
      const completedStatus = { phase: "completed", completedAt: result.completedAt, result, serverExit: report.exitInfo };
      try {
        if (!this.deps.records?.completeMatch) throw new Error("match records unavailable");
        await this.deps.records.completeMatch(matchId, result, completedStatus);
      } catch (error) {
        let committedAfterFailure;
        try {
          committedAfterFailure = await this.deps.records?.readCompletedMatch?.(matchId);
        } catch (readError) {
          process.stderr.write(`Failed to verify completed match ${matchId}: ${readError instanceof Error ? readError.message : String(readError)}\n`);
          return this.toPublicRoom(room);
        }
        if (committedAfterFailure) {
          return this.finalizeCommittedMatch(rooms, room, committedAfterFailure);
        }
        process.stderr.write(`Match result persistence failed for ${matchId}: ${error instanceof Error ? error.message : String(error)}\n`);
        const restoreError = await this.restoreMatchDatabase(matchId);
        if (restoreError) return this.toPublicRoom(room);
        return this.toPublicRoom(await this.failMatchRoom(rooms, room, "match_failed"));
      }
      let committedRecord: Pick<CompletedMatchRecord, "plan" | "result" | "completionEventPublished"> | undefined;
      try {
        const stored = await this.deps.records?.readCompletedMatch?.(matchId);
        if (stored) committedRecord = stored;
      } catch (error) {
        process.stderr.write(
          `Failed to read completed match event state ${matchId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      if (!committedRecord && savedPlan) {
        committedRecord = { plan: savedPlan, result };
      }
      if (!committedRecord) {
        const restoreError = await this.restoreMatchDatabase(matchId);
        if (restoreError) return this.toPublicRoom(room);
        return this.toPublicRoom(await this.failMatchRoom(rooms, room, "match_failed"));
      }
      return this.finalizeCommittedMatch(rooms, room, committedRecord);
    });
  }

  completeServerManagedRoomsFromServerUnavailable(): Promise<PublicMatchRoomRecord[]> {
    return this.enqueueMutation(async () => {
      let rooms = await this.deps.store.listRooms();
      const targets: MatchRoomRecord[] = [];
      for (const room of rooms) {
        if (!isServerManagedPhase(room.phase)) continue;
        const committed = await this.deps.records?.readCompletedMatch?.(room.id);
        if (committed) {
          const reconciliation = await this.reconcileCommittedMatch(rooms, room, committed);
          if (!reconciliation || reconciliation.retryRequired) this.scheduleCommittedMatchRecovery(room.id);
          rooms = await this.deps.store.listRooms();
          continue;
        }
        targets.push(room);
      }
      if (targets.length === 0) return [];

      const failedRooms: MatchRoomRecord[] = [];
      for (const target of targets) {
        const restoreError = target.databaseWriteStarted === false ? undefined : await this.restoreMatchDatabase(target.id);
        if (restoreError) continue;

        const latestRooms = await this.deps.store.listRooms();
        const latestRoom = latestRooms.find((candidate) => candidate.id === target.id);
        if (!latestRoom || !isServerManagedPhase(latestRoom.phase)) continue;
        const committed = await this.deps.records?.readCompletedMatch?.(latestRoom.id);
        if (committed) {
          const reconciliation = await this.reconcileCommittedMatch(latestRooms, latestRoom, committed);
          if (!reconciliation || reconciliation.retryRequired) this.scheduleCommittedMatchRecovery(latestRoom.id);
          continue;
        }

        const failed = await this.failMatchRoom(latestRooms, latestRoom, "match_failed");
        failedRooms.push(failed);
      }

      return failedRooms.map((room) => this.toPublicRoom(room));
    });
  }

  private async repairCommittedMatchRoom(
    rooms: MatchRoomRecord[],
    room: MatchRoomRecord,
    completedAt: string,
    options: { discardDatabaseBackup: boolean },
  ): Promise<CommittedMatchRepair | undefined> {
    const completed: MatchRoomRecord = {
      ...room,
      phase: "completed",
      terminalStateAt: completedAt,
    };
    try {
      await this.deps.store.saveRooms(rooms.map((candidate) => (candidate.id === room.id ? completed : candidate)));
    } catch (error) {
      process.stderr.write(`Failed to persist completed match room ${room.id}: ${error instanceof Error ? error.message : String(error)}\n`);
      return undefined;
    }
    this.clearReadyTimeout(room.id);
    this.clearMapReveal(room.id);
    try {
      await this.unlockPartyForRoom(completed, completedAt);
    } catch (error) {
      process.stderr.write(`Failed to unlock completed match party ${room.id}: ${error instanceof Error ? error.message : String(error)}\n`);
      try {
        await this.deps.store.saveRooms(rooms);
      } catch (rollbackError) {
        process.stderr.write(`Failed to roll back completed match room ${room.id}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}\n`);
      }
      return undefined;
    }
    let cleanupComplete = options.discardDatabaseBackup
      ? await this.discardMatchDatabaseBackup(room.id)
      : true;
    try {
      await this.deps.records?.cleanupCompletedMatchFiles?.(room.id);
    } catch (error) {
      process.stderr.write(`Failed to clean completed match files ${room.id}: ${error instanceof Error ? error.message : String(error)}\n`);
      cleanupComplete = false;
    }
    return { room: completed, cleanupComplete };
  }

  private async finalizeCommittedMatch(
    rooms: MatchRoomRecord[],
    room: MatchRoomRecord,
    committed: Pick<CompletedMatchRecord, "plan" | "result" | "completionEventPublished">,
  ): Promise<PublicMatchRoomRecord> {
    const reconciliation = await this.reconcileCommittedMatch(rooms, room, committed);
    if (!reconciliation || reconciliation.retryRequired) {
      this.scheduleCommittedMatchRecovery(room.id);
    }
    return this.toPublicRoom(reconciliation?.room ?? room);
  }

  private async reconcileCommittedMatch(
    rooms: MatchRoomRecord[],
    room: MatchRoomRecord,
    committed: Pick<CompletedMatchRecord, "plan" | "result" | "completionEventPublished">,
  ): Promise<CommittedMatchReconciliation | undefined> {
    const dev = committed.plan.dev === true;
    if (dev && !committed.completionEventPublished) {
      const restoreError = await this.restoreMatchDatabase(room.id, { preserveBackup: true });
      if (restoreError) return { room, retryRequired: true };
    }

    const repaired = await this.repairCommittedMatchRoom(
      rooms,
      room,
      committed.result.completedAt,
      { discardDatabaseBackup: !dev },
    );
    if (!repaired) return undefined;
    if (!committed.completionEventPublished) {
      try {
        await this.emit(
          {
            type: "match_completed",
            matchId: room.id,
            accountIds: this.roomAudience(repaired.room),
            result: committed.result,
          },
          room.id,
        );
      } catch (error) {
        process.stderr.write(
          `Failed to publish completed match ${room.id}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return { room: repaired.room, retryRequired: true };
      }
    }

    if (dev) {
      const backupDiscarded = await this.discardMatchDatabaseBackup(room.id);
      return {
        room: repaired.room,
        retryRequired: !repaired.cleanupComplete || !backupDiscarded,
      };
    }
    return { room: repaired.room, retryRequired: !repaired.cleanupComplete };
  }

  private findInvitation(invitations: PartyInvitationRecord[], invitationId: string): PartyInvitationRecord {
    const invitation = invitations.find((candidate) => candidate.id === invitationId);
    if (!invitation) throw new Error(`party invitation not found: ${invitationId}`);
    return invitation;
  }

  private requireOpenParty(party: PartyRecord, allowPending = false): void {
    if ((party.status ?? "open") !== "open") throw new Error("party is not open");
    if (!allowPending && party.matchmakingPendingAt) throw new Error("party preload is active");
  }

  private async emitPartyUpdated(publicParty: PublicPartyRecord): Promise<void> {
    await this.emit({
      type: "party_updated",
      accountIds: publicParty.memberAccountIds,
      party: publicParty,
    });
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
        const publicInvitation = await this.toPartyInvitationDto(invitation);
        await this.emit({ type: "party_invite_resolved", accountIds: [invitation.fromAccountId, invitation.toAccountId], invitation: publicInvitation });
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
    const resolvedInvitations = invitations.map((invitation): PartyInvitationRecord => (
      invitation.partyId === partyId && invitation.status === "pending"
        ? { ...invitation, status: "expired", resolvedAt }
        : invitation
    ));
    if (resolvedInvitations.every((invitation, index) => invitation === invitations[index])) return;

    await this.deps.store.saveInvitations(resolvedInvitations);
    await this.emitResolvedInvitations(invitations, resolvedInvitations);
  }

  async acknowledgePreload(accountId: string, matchId: string, resourceVersion: string): Promise<void> {
    const ownerId = await this.enqueueMutation(async () => {
      const parties = await this.deps.store.listParties();
      const party = parties.find((entry) => entry.memberAccountIds.includes(accountId));
      if (party?.lockedMatchId === matchId && party.status === "matchmaking" && resourceVersion === PRELOAD_RESOURCE_VERSION) return undefined;
      if (!party?.preload || party.preload.cancelled || party.lockedMatchId !== matchId || party.preload.resourceVersion !== resourceVersion) throw new Error("match preload is not active");
      if (Date.parse(party.preload.deadlineAt) <= Date.parse(this.now())) throw new Error("match preload expired");
      const completedAccountIds = [...new Set([...party.preload.completedAccountIds, accountId])];
      const updated = { ...party, preload: { ...party.preload, completedAccountIds } };
      await this.deps.store.saveParties(parties.map((entry) => entry.id === party.id ? updated : entry));
      await this.emitPartyUpdated(await this.toPlayerPublicParty(updated));
      return party.memberAccountIds.some((id) => !this.isConfirmedOffline(id)) && party.memberAccountIds.every((id) => this.isConfirmedOffline(id) || completedAccountIds.includes(id)) ? party.ownerAccountId : undefined;
    });
    if (ownerId) {
      try { await this.startPartyMatchmaking(ownerId, {}, matchId); }
      catch (error) {
        const current = (await this.deps.store.listParties()).find((entry) => entry.lockedMatchId === matchId && entry.preload);
        if (current) await this.cancelScheduledPartyMatchmaking(current.id, current.preload!.deadlineAt, "match_failed");
        throw error;
      }
    }
  }

  private schedulePartyMatchmakingStart(party: PartyRecord): void {
    if (!party.matchmakingPendingAt || !party.preload) return;
    const deadline = party.preload.deadlineAt;
    this.clearPartyMatchmakingTimeout(party.id);
    const timeout = this.setTimeoutFn(() => {
      void this.startScheduledPartyMatchmaking(party.id, deadline).catch(() => undefined);
    }, Math.max(0, Date.parse(deadline) - Date.parse(this.now())));
    if (this.unrefReadyTimeouts) timeout.unref?.();
    this.partyMatchmakingTimeouts.set(party.id, { startAt: deadline, timeout });
  }

  private async startScheduledPartyMatchmaking(partyId: string, deadline: string): Promise<void> {
    const party = (await this.deps.store.listParties()).find((entry) => entry.id === partyId);
    if (party?.preload?.deadlineAt !== deadline) return;
    if (Date.parse(this.now()) < Date.parse(deadline)) { this.schedulePartyMatchmakingStart(party); return; }
    await this.cancelScheduledPartyMatchmaking(partyId, deadline, "preload_timeout");
  }

  private async cancelScheduledPartyMatchmaking(partyId: string, deadline?: string, reason?: string): Promise<void> {
    const matchId = await this.enqueueMutation(async () => {
      const parties = await this.deps.store.listParties();
      const party = parties.find((entry) => entry.id === partyId);
      if (!party?.preload || !party.lockedMatchId || (deadline && party.preload.deadlineAt !== deadline)) return undefined;
      await this.deps.store.saveParties(parties.map((entry) => entry.id === partyId ? { ...entry, preload: { ...party.preload!, cancelled: true } } : entry));
      this.clearPartyMatchmakingTimeout(partyId);
      return party.lockedMatchId;
    });
    if (!matchId) return;
    await this.stopMatchTask(matchId);
    await this.enqueueMutation(async () => {
      const parties = await this.deps.store.listParties();
      const party = parties.find((entry) => entry.id === partyId);
      if (party?.lockedMatchId !== matchId || !party.preload?.cancelled) return;
      if (reason) await this.emit({ type: "match_failed", matchId, accountIds: party.memberAccountIds, error: reason });
      const updated = { ...party, lockedMatchId: undefined, matchmakingPendingAt: undefined, matchmakingDev: undefined, preload: undefined, updatedAt: this.now() };
      await this.deps.store.saveParties(parties.map((entry) => entry.id === partyId ? updated : entry));
      await this.emitPartyUpdated(await this.toPlayerPublicParty(updated));
      await this.emitOccupancyUpdated();
    });
  }

  private clearPartyMatchmakingTimeout(partyId: string): void {
    const entry = this.partyMatchmakingTimeouts.get(partyId);
    if (!entry) return;
    this.clearTimeoutFn(entry.timeout);
    this.partyMatchmakingTimeouts.delete(partyId);
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
    // A persisted completion event is the restart-recovery proof, so publish it first.
    if (event.type === "match_completed") {
      this.deps.events?.publish(event);
    }
    if (matchId && event.type !== "match_failed") {
      try {
        await this.deps.records?.appendEvent(matchId, { ...event, at: this.now() });
      } catch (error) {
        process.stderr.write(
          `Failed to append match event for ${matchId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        if (event.type === "match_completed") throw error;
      }
    }
    if (event.type !== "match_completed") {
      this.deps.events?.publish(event);
    }
  }


  private async emitOccupancyUpdated(): Promise<void> {
    await this.emit({ type: "matchmaking_occupancy_updated", occupancy: await this.getOccupancy() });
  }

  private async emitReadyRoomCreatedPerAccount(room: MatchRoomRecord): Promise<void> {
    for (const accountId of this.roomAudience(room)) {
      await this.emit(
        { type: "match_room_created", matchId: room.id, accountIds: [accountId], room: this.toPlayerPublicRoom(room, accountId) },
        room.id,
      );
    }
  }

  private async emitRoomUpdated(room: MatchRoomRecord): Promise<void> {
    const audience = this.roomAudience(room);
    if (room.phase === "ready") {
      for (const accountId of audience) {
        await this.emit(
          { type: "match_room_updated", matchId: room.id, accountIds: [accountId], room: this.toPlayerPublicRoom(room, accountId) },
          room.id,
        );
      }
      return;
    }
    await this.emit(
      { type: "match_room_updated", matchId: room.id, accountIds: audience, room: this.toPublicRoom(room) },
      room.id,
    );
  }





  private async saveRoomAfterMapSelected(rooms: MatchRoomRecord[], room: MatchRoomRecord, finalMap: string): Promise<MatchRoomRecord> {
    if (rooms.some((candidate) => candidate.id !== room.id && isServerManagedPhase(candidate.phase))) {
      return this.failMatchRoom(rooms, room, "match_failed");
    }
    const preparing: MatchRoomRecord = { ...room, phase: "server_prepare", connect: undefined, databaseWriteStarted: false };
    await this.deps.store.saveRooms(rooms.map((candidate) => candidate.id === room.id ? preparing : candidate));
    this.clearMapReveal(room.id);
    await this.emit({ type: "server_preparing", matchId: room.id, accountIds: this.roomAudience(preparing) }, room.id);
    if (!this.deps.executor) return preparing;
    const task = this.ensureMatchTask(room.id);
    if (!task.prepare) {
      task.prepare = Promise.resolve().then(async () => {
        try {
          await task.backup;
          const saved = await this.readSavedMatchPlan(room.id);
          const plan = saved?.map === finalMap ? saved : await this.buildMatchPlan(preparing, finalMap);
          if (plan !== saved) await this.deps.records?.saveMatchPlan(plan);
          const permitted = await this.enqueueMutation(async () => {
            const current = await this.deps.store.listRooms();
            const target = current.find((entry) => entry.id === room.id);
            if (task.cancelled || target?.phase !== "server_prepare" || target.databaseWriteStarted) return false;
            await this.deps.store.saveRooms(current.map((entry) => entry.id === room.id ? { ...entry, databaseWriteStarted: true } : entry));
            return true;
          });
          if (!permitted) return;
          const connect = await this.deps.executor!.prepare(plan);
          await this.enqueueMutation(async () => {
            const current = await this.deps.store.listRooms();
            const target = current.find((entry) => entry.id === room.id);
            if (task.cancelled || target?.phase !== "server_prepare") return;
            const connected: MatchRoomRecord = { ...target, phase: "connect", connect };
            await this.deps.store.saveRooms(current.map((entry) => entry.id === room.id ? connected : entry));
            await this.deps.records?.saveStatus(room.id, { phase: "connect", connect });
            await this.emit({ type: "connect_ready", matchId: room.id, accountIds: this.roomAudience(connected), connect }, room.id);
          });
        } catch (error) {
          process.stderr.write(`Game server preparation failed for ${room.id}: ${error instanceof Error ? error.message : String(error)}\n`);
          const current = (await this.deps.store.listRooms()).find((entry) => entry.id === room.id);
          if (current?.databaseWriteStarted && await this.restoreMatchDatabase(room.id)) return;
          await this.enqueueMutation(async () => {
            const latest = await this.deps.store.listRooms();
            const target = latest.find((entry) => entry.id === room.id);
            if (target?.phase === "server_prepare") await this.failMatchRoom(latest, target, "match_failed");
          });
        }
      });
      void task.prepare.catch((error: unknown) => process.stderr.write(`Match task failed: ${String(error)}\n`));
    }
    return preparing;
  }

  private async buildMatchPlan(room: MatchRoomRecord, map: string): Promise<MatchPlan> {
    const rankmeScoresBefore = await this.rankmeScoresBefore(room);
    return {
      id: room.id,
      phase: "server_prepare",
      ...(room.dev === true ? { dev: true as const } : {}),
      map,
      teamA: room.teamA,
      teamB: room.teamB,
      connectPassword: `match_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      createdAt: this.now(),
      ...(rankmeScoresBefore ? { rankmeScoresBefore } : {}),
    };
  }

  private async rankmeScoresBefore(room: MatchRoomRecord): Promise<Record<string, number> | undefined> {
    const rankme = this.deps.rankme;
    if (!rankme) return undefined;
    const entries = await Promise.all(
      [...room.teamA.participants, ...room.teamB.participants]
        .filter((participant) => participant.kind === "human" && participant.steam64)
        .map(async (participant) => {
          const steam64 = participant.steam64!;
          const lookup = await lookupRankmeScore(rankme, steam64);
          if (lookup.status === "found") return [steam64, lookup.score] as const;
          if (lookup.status === "missing" && await this.isFirstCompletedMatch(participant)) {
            return [steam64, DEFAULT_RANKME_SCORE] as const;
          }
          throw new Error("rankme starting score unavailable");
        }),
    );
    const rankmeScoresBefore = Object.fromEntries(entries);
    return Object.keys(rankmeScoresBefore).length > 0 ? rankmeScoresBefore : undefined;
  }

  private async isFirstCompletedMatch(participant: MatchParticipant): Promise<boolean> {
    const steam64 = participant.steam64?.trim();
    if (!steam64 || !this.deps.records?.listPlayerCompletedMatches) return false;
    const matches = await this.deps.records.listPlayerCompletedMatches(steam64, { page: 1, pageSize: 1 });
    return matches.total === 0;
  }

  private async applyRankmeScores(
    players: MatchPlayerResult[],
    rankmeScoresBefore: Record<string, number> | undefined,
    dev: boolean,
  ): Promise<MatchPlayerResult[]> {
    if (!rankmeScoresBefore) return players;
    if (dev) {
      return players.map((player) => {
        const before = rankmeScoresBefore[player.steam64];
        return player.kind === "human" && typeof before === "number" && Number.isFinite(before)
          ? { ...player, rankmeScore: before, rankmeScoreDelta: 0 }
          : player;
      });
    }
    if (!this.deps.rankme) return players;
    return Promise.all(players.map(async (player) => {
      const before = rankmeScoresBefore[player.steam64];
      if (player.kind !== "human" || typeof before !== "number" || !Number.isFinite(before)) return player;
      const after = await lookupRankmeScore(this.deps.rankme!, player.steam64);
      if (after.status !== "found") throw new Error("rankme final score unavailable");
      const rankmeScore = after.score;
      return { ...player, rankmeScore, rankmeScoreDelta: rankmeScore - before };
    }));
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

  private async restoreMatchDatabase(
    matchId: string,
    options: { preserveBackup?: boolean } = {},
  ): Promise<string | undefined> {
    if (!this.deps.databaseBackup) return undefined;
    try {
      await this.deps.databaseBackup.restore(matchId, options);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Failed to restore mysql backup for ${matchId}: ${message}\n`);
      return message;
    }
  }

  private async discardMatchDatabaseBackup(matchId: string): Promise<boolean> {
    try {
      await this.deps.databaseBackup?.discard(matchId);
      this.matchTasks.delete(matchId);
      return true;
    } catch (error) {
      process.stderr.write(`Failed to discard mysql backup for ${matchId}: ${error instanceof Error ? error.message : String(error)}\n`);
      return false;
    }
  }

  private async deleteFailedMatchArtifacts(matchId: string): Promise<void> {
    let cleanupError: unknown;
    try {
      await this.deps.records?.deleteMatch(matchId);
    } catch (error) {
      cleanupError = error;
      process.stderr.write(`Failed to delete failed match record for ${matchId}: ${error instanceof Error ? error.message : String(error)}\n`);
    }

    try {
      await this.deps.executor?.deleteMatchArtifacts?.(matchId);
    } catch (error) {
      cleanupError ??= error;
      process.stderr.write(`Failed to delete failed match artifacts for ${matchId}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (cleanupError) throw cleanupError;
  }

  private async requireAccount(accountId: string): Promise<void> {
    if (!(await this.deps.accounts.getById(accountId))) throw new Error(`account not found: ${accountId}`);
  }

  private displayNameForSteam64(steam64: string): string {
    const normalized = steam64.trim();
    const resolved = normalized ? this.deps.steamPersonas?.displayName(normalized)?.trim() : "";
    return resolved || normalized || "";
  }

  private displayNameForInvitationAccount(account: AccountRecord | null | undefined): string {
    return this.displayNameForSteam64(account?.steam64 ?? "");
  }

  private async toPartyInvitationDto(invitation: PartyInvitationRecord): Promise<PartyInvitationDto> {
    const [fromAccount, toAccount] = await Promise.all([
      this.deps.accounts.getById(invitation.fromAccountId),
      this.deps.accounts.getById(invitation.toAccountId),
    ]);
    return {
      id: invitation.id,
      partyId: invitation.partyId,
      fromAccountId: invitation.fromAccountId,
      toAccountId: invitation.toAccountId,
      status: invitation.status,
      createdAt: invitation.createdAt,
      ...(invitation.resolvedAt ? { resolvedAt: invitation.resolvedAt } : {}),
      fromDisplayName: this.displayNameForInvitationAccount(fromAccount),
      toDisplayName: this.displayNameForInvitationAccount(toAccount),
    };
  }

  private async toPlayerPublicParty(party: PartyRecord): Promise<PublicPartyRecord> {
    const rankmeEntries = await Promise.all(
      party.memberAccountIds.map(async (accountId) => {
        const account = await this.deps.accounts.getById(accountId);
        const standing = account ? (await this.rankmeStandingForSteam64(account.steam64)) ?? null : null;
        return [accountId, standing] as const;
      }),
    );
    return { ...party, rankmeStandings: Object.fromEntries(rankmeEntries) };
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

    const displayName = this.displayNameForSteam64(steam64);

    return {
      id: account.id,
      kind: "human",
      displayName,
      steam64,
      ...(displayName !== steam64 ? { steamPersonaName: displayName } : {}),
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

  private scheduleMapReveal(room: MatchRoomRecord): void {
    if (room.phase !== "map_randomizing" || !room.mapSelection) return;
    this.clearMapReveal(room.id);
    const revealAt = room.mapSelection.revealAt;
    const timeout = this.setTimeoutFn(() => {
      void this.revealMap(room.id, revealAt).catch(() => undefined);
    }, Math.max(0, Date.parse(revealAt) - Date.parse(this.now())));
    if (this.unrefReadyTimeouts) timeout.unref?.();
    this.mapRevealTimers.set(room.id, timeout);
  }

  private clearMapReveal(roomId: string): void {
    const timeout = this.mapRevealTimers.get(roomId);
    if (!timeout) return;
    this.clearTimeoutFn(timeout);
    this.mapRevealTimers.delete(roomId);
  }

  private revealMap(roomId: string, revealAt: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const rooms = await this.deps.store.listRooms();
      const room = rooms.find((candidate) => candidate.id === roomId);
      if (room?.phase !== "map_randomizing" || room.mapSelection?.revealAt !== revealAt) return;
      if (Date.parse(this.now()) < Date.parse(revealAt)) { this.scheduleMapReveal(room); return; }
      if (this.roomAudience(room).every((id) => this.isConfirmedOffline(id))) {
        await this.failMatchRoom(rooms, room, "match_failed");
        return;
      }
      await this.saveRoomAfterMapSelected(rooms, room, room.mapSelection.finalMap);
    });
  }

  private pruneTerminalRooms(rooms: MatchRoomRecord[], parties: PartyRecord[] = []): MatchRoomRecord[] {
    const cutoff = Date.parse(this.now()) - TERMINAL_ROOM_MEMORY_TTL_MS;
    const lockedMatchIds = new Set(
      parties
        .map((party) => party.lockedMatchId)
        .filter((matchId): matchId is string => Boolean(matchId)),
    );
    return rooms.filter((room) => {
      if (!isTerminalMatchPhase(room.phase)) return true;
      if (lockedMatchIds.has(room.id)) return true;
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

  private async withRankmeStandings(team: MatchTeam): Promise<MatchTeam> {
    const participants = await Promise.all(team.participants.map((participant) => this.withRankmeStanding(participant)));
    return { ...team, participants };
  }

  private async withRankmeStanding(participant: MatchParticipant): Promise<MatchParticipant> {
    const standing = await this.rankmeStandingForParticipant(participant);
    return standing ? { ...participant, rankmeStanding: standing } : participant;
  }

  private async rankmeStandingForParticipant(participant: MatchParticipant): Promise<RankmeDisplay | undefined> {
    if (participant.kind === "human" && participant.steam64) {
      return this.rankmeStandingForSteam64(participant.steam64);
    }
    const rankme = this.deps.rankme;
    if (!rankme) return undefined;
    if (participant.kind === "bot" && participant.botProfileName) {
      const fallbackLevel = participant.botCategory === "pro" ? 8 : 4;
      return rankmeDisplayFromLookup(
        await rankme.lookupStandingByBotName(participant.botProfileName),
        fallbackLevel,
        null,
      ) ?? undefined;
    }
    return undefined;
  }

  private async rankmeStandingForSteam64(steam64: string): Promise<RankmeDisplay | undefined> {
    const rankme = this.deps.rankme;
    const normalizedSteam64 = steam64.trim();
    if (!rankme || !normalizedSteam64) return undefined;
    return (
      rankmeDisplayFromLookup(await rankme.lookupStandingBySteam64(normalizedSteam64), 6, null) ?? undefined
    );
  }

  private maskReadyParticipant(participant: MatchParticipant): MatchParticipant {
    return {
      id: participant.id,
      kind: participant.kind,
      displayName: "",
      steam64: undefined,
      steamPersonaName: undefined,
      steamAvatarUrl: undefined,
      isCaptain: false,
      botCategory: undefined,
      botProfileName: undefined,
      rankmeStanding: undefined,
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

  private async failMatchRoom(
    rooms: MatchRoomRecord[],
    room: MatchRoomRecord,
    reason: "match_failed",
    readyDeclinedByDisplayName?: string,
  ): Promise<MatchRoomRecord> {
    const failedAt = this.now();
    const failedRoom: MatchRoomRecord = { ...room, phase: "failed", terminalStateAt: failedAt };
    this.clearReadyTimeout(room.id);
    this.clearMapReveal(room.id);
    const updatedRooms = rooms.map((candidate) => (candidate.id === room.id ? failedRoom : candidate));
    await this.deps.store.saveRooms(updatedRooms);
    const cleanup = async () => {
      await this.stopMatchTask(room.id);
      await this.enqueueMutation(async () => {
        const current = (await this.deps.store.listRooms()).find((entry) => entry.id === room.id);
        if (current?.phase !== "failed") return;
        await this.clearGameServerPresenceForRoom(room);
        await this.deleteFailedMatchArtifacts(room.id);
        await this.unlockPartyForRoom(current, failedAt);
        await this.emit({
          type: "match_failed",
          matchId: room.id,
          accountIds: this.roomAudience(current),
          error: reason,
          ...(readyDeclinedByDisplayName ? { readyDeclinedByDisplayName } : {}),
        });
      });
    };
    const pending = cleanup().catch((error: unknown) => { process.stderr.write(`Match cleanup failed for ${room.id}: ${String(error)}\n`); });
    this.cleanupTasks.add(pending);
    void pending.finally(() => this.cleanupTasks.delete(pending));
    return failedRoom;
  }

  private async clearGameServerPresenceForRoom(room: MatchRoomRecord): Promise<void> {
    if (!isServerManagedPhase(room.phase)) return;
    try {
      const presence = this.deps.presence;
      if (presence) await this.publishGamePresenceChanges(presence.replaceInGameAccounts([]));
    } catch (error) {
      process.stderr.write(
        `Failed to clear game server presence for ${room.id}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    void Promise.resolve()
      .then(() => this.deps.executor?.stopGameServerPresence?.(room.id))
      .catch(() => undefined);
  }

  private async publishGamePresenceChanges(changes: readonly GamePresenceChange[]): Promise<void> {
    for (const change of changes) {
      const friendList = await this.deps.friends?.listFriends(change.accountId);
      const accountIds = [...new Set(friendList?.friends.map((friend) => friend.accountId) ?? [])];
      await this.emit({
        type: "game_presence_updated",
        accountId: change.accountId,
        accountIds,
        inGame: change.inGame,
      });
    }
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
    try {
      const publicParty = await this.toPlayerPublicParty(updatedParty);
      await this.emitPartyUpdated(publicParty);
    } catch (error) {
      process.stderr.write(`Failed to publish unlocked party ${party.id}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    try {
      await this.emitOccupancyUpdated();
    } catch (error) {
      process.stderr.write(`Failed to publish matchmaking occupancy after unlocking party ${party.id}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
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
