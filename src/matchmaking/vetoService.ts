import type { MatchTeam, TeamSide } from "./types.js";

export type VetoAction = "ban" | "pick";
export type VetoActorType = "human" | "virtual" | "timeout_auto";
export type VetoCurrentActorType = "human" | "bot";

export interface VetoHistoryEntry {
  action: VetoAction;
  map: string;
  actorName: string;
  actorTeamId: TeamSide;
  actorType: VetoActorType;
  at: string;
}

interface VetoCaptain {
  teamId: TeamSide;
  displayName: string;
  accountId?: string;
  actorType: VetoCurrentActorType;
}

export interface PublicVetoState {
  matchId: string;
  mapPool: string[];
  availableMaps: string[];
  history: VetoHistoryEntry[];
  current?: {
    actorTeamId: TeamSide;
    actorName: string;
    actorType: VetoCurrentActorType;
    actorAccountId?: string;
    action: VetoAction;
    deadlineAt: string;
  };
  finalMap?: string;
}

export interface VetoState extends PublicVetoState {
  captains?: Record<TeamSide, VetoCaptain>;
}

const humanVetoStepMs = 60_000;
const botVetoStepMs = 2_000;

export function normalizeVetoState(state: VetoState): VetoState {
  const captains = state.captains
    ? {
        teamA: normalizeCaptain(state.captains.teamA, "teamA"),
        teamB: normalizeCaptain(state.captains.teamB, "teamB"),
      }
    : undefined;
  const current = fillCurrentActorAccountId(normalizeCurrent(state.current), captains);
  return {
    ...state,
    captains,
    current,
  };
}

export function toPublicVetoState(state: VetoState | PublicVetoState | undefined): PublicVetoState | undefined {
  if (!state) {
    return undefined;
  }

  const normalized = normalizeVetoState(state as VetoState);
  return {
    matchId: normalized.matchId,
    mapPool: normalized.mapPool.slice(),
    availableMaps: normalized.availableMaps.slice(),
    history: normalized.history.slice(),
    current: normalized.current ? { ...normalized.current } : undefined,
    finalMap: normalized.finalMap,
  };
}

export function createVetoState(input: {
  matchId: string;
  mapPool: string[];
  teamA: MatchTeam;
  teamB: MatchTeam;
  now: string;
  random?: () => number;
}): VetoState {
  validateMapPool(input.mapPool);
  const random = input.random ?? Math.random;
  const captains = {
    teamA: selectCaptain(input.teamA, random),
    teamB: selectCaptain(input.teamB, random),
  } satisfies Record<TeamSide, VetoCaptain>;

  const availableMaps = input.mapPool.slice();
  const finalMap = availableMaps.length === 1 ? availableMaps[0] : undefined;
  const state: VetoState = finalMap
    ? { matchId: input.matchId, mapPool: input.mapPool.slice(), availableMaps, history: [], captains, finalMap }
    : {
        matchId: input.matchId,
        mapPool: input.mapPool.slice(),
        availableMaps,
        history: [],
        current: nextCurrent(captains.teamA, input.now),
        captains,
      };
  return normalizeVetoState(state);
}

export function applyVetoAction(
  state: VetoState,
  input: { action: VetoAction; map: string; actorAccountId: string; now: string },
): VetoState {
  const normalizedState = normalizeVetoState(state);
  const current = requireCurrent(normalizedState, "action");
  const captain = getCaptain(normalizedState, current.actorTeamId);

  if (input.action !== current.action) {
    throw new Error(`Invalid veto action: expected ${current.action}, got ${input.action}`);
  }
  if (!normalizedState.availableMaps.includes(input.map)) {
    throw new Error(`Invalid veto map: ${input.map} is not available`);
  }
  if (current.actorType !== "human" || captain.accountId !== input.actorAccountId) {
    throw new Error(`Invalid veto actor: ${input.actorAccountId} cannot act for current veto`);
  }

  return applyBan(normalizedState, {
    map: input.map,
    now: input.now,
    actorType: "human",
  });
}

export function applyVetoTimeout(
  state: VetoState,
  input: { now: string; random?: () => number },
): VetoState {
  const normalizedState = normalizeVetoState(state);
  if (!normalizedState.current) {
    return normalizedState;
  }
  const nowMs = parseTimestamp(input.now, "now time");
  const deadlineMs = parseTimestamp(normalizedState.current.deadlineAt, "deadline time");
  if (nowMs < deadlineMs) {
    return normalizedState;
  }
  const map = chooseRandomMap(normalizedState.availableMaps, input.random ?? Math.random);
  return applyBan(normalizedState, {
    map,
    now: input.now,
    actorType: normalizedState.current.actorType === "human" ? "timeout_auto" : "virtual",
  });
}

function applyBan(state: VetoState, input: { map: string; now: string; actorType: VetoActorType }): VetoState {
  parseTimestamp(input.now, "action time");
  const current = requireCurrent(state, "action");
  const availableMaps = state.availableMaps.filter((map) => map !== input.map);
  const history = state.history.concat({
    action: current.action,
    map: input.map,
    actorName: current.actorName,
    actorTeamId: current.actorTeamId,
    actorType: input.actorType,
    at: input.now,
  });

  const finalMap = availableMaps.length === 1 ? availableMaps[0] : undefined;
  const nextState: VetoState = finalMap
    ? {
        matchId: state.matchId,
        mapPool: state.mapPool.slice(),
        availableMaps,
        history,
        captains: state.captains,
        finalMap,
      }
    : {
        matchId: state.matchId,
        mapPool: state.mapPool.slice(),
        availableMaps,
        history,
        current: nextCurrent(getCaptain(state, otherTeam(current.actorTeamId)), input.now),
        captains: state.captains,
      };
  return nextState;
}

function selectCaptain(team: MatchTeam, random: () => number): VetoCaptain {
  const humanCaptains = team.participants.filter((participant) => participant.kind === "human" && participant.accountId);
  const humanCaptain = humanCaptains.length === 1
    ? humanCaptains[0]
    : humanCaptains[chooseRandomIndex(humanCaptains.length, random)];
  if (humanCaptain?.accountId) {
    return {
      teamId: team.id,
      displayName: humanCaptain.displayName,
      accountId: humanCaptain.accountId,
      actorType: "human",
    };
  }

  const botCaptain = team.participants[0];
  return {
    teamId: team.id,
    displayName: botCaptain?.displayName ?? (team.id === "teamA" ? "Team A Captain" : "Team B Captain"),
    actorType: "bot",
  };
}

function nextCurrent(actor: VetoCaptain, now: string): NonNullable<VetoState["current"]> {
  const stepMs = actor.actorType === "bot" ? botVetoStepMs : humanVetoStepMs;
  return {
    action: "ban",
    actorTeamId: actor.teamId,
    actorName: actor.displayName,
    actorType: actor.actorType,
    ...(actor.accountId ? { actorAccountId: actor.accountId } : {}),
    deadlineAt: new Date(parseTimestamp(now, "now time") + stepMs).toISOString(),
  };
}

function normalizeCurrent(current: VetoState["current"] | { action: VetoAction; actor?: { teamId: TeamSide; displayName: string; virtual?: boolean }; deadlineAt: string } | undefined): VetoState["current"] {
  if (!current) {
    return undefined;
  }
  if ("actorTeamId" in current && "actorName" in current && "actorType" in current) {
    return current;
  }

  return {
    action: current.action,
    actorTeamId: current.actor?.teamId ?? "teamA",
    actorName: current.actor?.displayName ?? "Team A Captain",
    actorType: current.actor?.virtual ? "bot" : "human",
    deadlineAt: current.deadlineAt,
  };
}

function fillCurrentActorAccountId(
  current: VetoState["current"],
  captains: Record<TeamSide, VetoCaptain> | undefined,
): VetoState["current"] {
  if (!current || current.actorType !== "human" || current.actorAccountId) {
    return current;
  }

  const accountId = captains?.[current.actorTeamId]?.accountId;
  return accountId ? { ...current, actorAccountId: accountId } : current;
}

function normalizeCaptain(captain: VetoCaptain | { teamId: TeamSide; displayName: string; accountId?: string; virtual?: boolean }, teamId: TeamSide): VetoCaptain {
  if ("actorType" in captain) {
    return captain;
  }
  return {
    teamId: captain.teamId ?? teamId,
    displayName: captain.displayName,
    accountId: captain.accountId,
    actorType: captain.virtual ? "bot" : "human",
  };
}

function validateMapPool(mapPool: string[]): void {
  if (mapPool.length === 0) {
    throw new Error("Invalid veto map pool: at least one map is required");
  }
  if (new Set(mapPool).size !== mapPool.length) {
    throw new Error("Invalid veto map pool: duplicate map entries are not allowed");
  }
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid veto ${label}: expected a valid date/time`);
  }
  return parsed;
}

function chooseRandomMap(availableMaps: string[], random: () => number): string {
  if (availableMaps.length === 0) {
    throw new Error("Invalid veto map: no available maps remain");
  }

  const index = chooseRandomIndex(availableMaps.length, random);
  return availableMaps[index] ?? availableMaps[0];
}

function chooseRandomIndex(length: number, random: () => number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.min(length - 1, Math.max(0, Math.floor(random() * length)));
}

function otherTeam(teamId: TeamSide): TeamSide {
  return teamId === "teamA" ? "teamB" : "teamA";
}

function requireCurrent(state: VetoState, keyword: string): NonNullable<VetoState["current"]> {
  if (!state.current) {
    throw new Error(`Invalid veto ${keyword}: no current veto step`);
  }
  return state.current;
}

function getCaptain(state: VetoState, teamId: TeamSide): VetoCaptain {
  const captain = state.captains?.[teamId];
  if (captain) {
    return captain;
  }

  return {
    teamId,
    displayName: teamId === "teamA" ? "Team A Captain" : "Team B Captain",
    actorType: "bot",
  };
}
