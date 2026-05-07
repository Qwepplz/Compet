import type { BotCandidate } from "../bots/botCatalog.js";
import type { BotRosterTeam } from "../bots/botRosterParser.js";
import type { MatchParticipant, MatchTeam } from "./types.js";

const STEAM64_ACCOUNT_ID_OFFSET = 76561197960265728n;

export interface PartySnapshot {
  id: string;
  memberAccountIds: string[];
}

export interface AssignTeamsInput {
  humans: MatchParticipant[];
  parties: PartySnapshot[];
  botCandidates: BotCandidate[];
  botRosters?: BotRosterTeam[];
  random?: () => number;
}

export interface AssignTeamsResult {
  teamA: MatchTeam;
  teamB: MatchTeam;
  selectedBots: BotCandidate[];
}

export function assignTeams(input: AssignTeamsInput): AssignTeamsResult {
  const random = input.random ?? Math.random;
  const shuffledHumans = shuffle(input.humans, random).slice(0, 10);
  const botCount = 10 - shuffledHumans.length;

  if (input.botCandidates.length < botCount) {
    throw new Error(`Not enough bot candidates to assign fixed 5v5 teams: need ${botCount}, got ${input.botCandidates.length}`);
  }

  const selectedBots = shuffle(input.botCandidates, random).slice(0, botCount);
  const humanIds = new Set(shuffledHumans.map((human) => human.id));
  const usedBotIds = new Set<string>();
  const proBotNames = buildProBotNames(input.botRosters);
  const botParticipants = selectedBots.map((candidate) => toBotParticipant(candidate, humanIds, usedBotIds, proBotNames));
  const participants = shuffle([...shuffledHumans, ...botParticipants], random);
  const [teamAName, teamBName] = pickTeamNames(input.botRosters, random);

  return {
    teamA: createTeam("teamA", "t", teamAName, participants.slice(0, 5), random),
    teamB: createTeam("teamB", "ct", teamBName, participants.slice(5, 10), random),
    selectedBots,
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1, random);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

function randomIndex(maxExclusive: number, random: () => number): number {
  const index = Math.floor(random() * maxExclusive);
  return Math.min(Math.max(index, 0), maxExclusive - 1);
}

function pickTeamNames(botRosters: readonly BotRosterTeam[] | undefined, random: () => number): [string, string] {
  const rosterNames = Array.from(new Set((botRosters ?? []).map((roster) => roster.name.trim()).filter(Boolean)));
  const selected = shuffle(rosterNames, random).slice(0, 2);
  const teamAName = selected[0] ?? "Team A";
  const teamBName = selected[1] ?? (teamAName === "Team B" ? "Team A" : "Team B");
  return [teamAName, teamBName];
}

function buildProBotNames(botRosters: readonly BotRosterTeam[] | undefined): ReadonlySet<string> {
  return new Set((botRosters ?? []).flatMap((roster) => roster.players.map(normalizeBotName)).filter(Boolean));
}

function hasProProfileTemplate(candidate: BotCandidate): boolean {
  return candidate.templates.some((template) => template.trim().toLowerCase().startsWith("pro"));
}

function normalizeBotName(name: string): string {
  return name.trim().toLowerCase();
}

function steamAccountIdToSteam64(steamAccountId: number | undefined): string | undefined {
  if (steamAccountId === undefined) return undefined;
  if (!Number.isSafeInteger(steamAccountId) || steamAccountId < 0) return undefined;
  return (STEAM64_ACCOUNT_ID_OFFSET + BigInt(steamAccountId)).toString();
}

function toBotParticipant(
  candidate: BotCandidate,
  humanIds: ReadonlySet<string>,
  usedBotIds: Set<string>,
  proBotNames: ReadonlySet<string>,
): MatchParticipant {
  const baseId = `bot:${candidate.name}`;
  let id = baseId;
  let suffix = 1;

  while (humanIds.has(id) || usedBotIds.has(id)) {
    id = `${baseId}:${suffix++}`;
  }

  usedBotIds.add(id);
  const steam64 = steamAccountIdToSteam64(candidate.steamAccountId);
  const isProBot = proBotNames.has(normalizeBotName(candidate.name)) || hasProProfileTemplate(candidate);

  return {
    id,
    kind: "bot",
    displayName: candidate.name,
    botProfileName: candidate.name,
    ...(steam64 ? { steam64 } : {}),
    ...(isProBot ? { botCategory: "pro" as const } : {}),
  };
}

function createTeam(id: "teamA" | "teamB", gameSide: "t" | "ct", name: string, participants: MatchParticipant[], random: () => number): MatchTeam {
  return {
    id,
    gameSide,
    name,
    participants: markCaptain(participants, random),
  };
}

function markCaptain(participants: MatchParticipant[], random: () => number): MatchParticipant[] {
  const candidates = participants.filter((participant) => participant.kind === "human" && participant.accountId);
  const captainPool = candidates.length > 0 ? candidates : participants;
  const captainId = captainPool[randomIndex(captainPool.length, random)]?.id;

  return participants.map((participant) => {
    const { isCaptain: _isCaptain, ...rest } = participant;
    return participant.id === captainId ? { ...rest, isCaptain: true } : rest;
  });
}
