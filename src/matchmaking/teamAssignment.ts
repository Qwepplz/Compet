import type { BotCandidate } from "../bots/botCatalog.js";
import type { MatchParticipant, MatchTeam } from "./types.js";

export interface PartySnapshot {
  id: string;
  memberAccountIds: string[];
}

export interface AssignTeamsInput {
  humans: MatchParticipant[];
  parties: PartySnapshot[];
  botCandidates: BotCandidate[];
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
  const botParticipants = selectedBots.map((candidate) => toBotParticipant(candidate, humanIds, usedBotIds));
  const participants = shuffle([...shuffledHumans, ...botParticipants], random);

  return {
    teamA: createTeam("teamA", "t", "Team A", participants.slice(0, 5)),
    teamB: createTeam("teamB", "ct", "Team B", participants.slice(5, 10)),
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

function toBotParticipant(
  candidate: BotCandidate,
  humanIds: ReadonlySet<string>,
  usedBotIds: Set<string>,
): MatchParticipant {
  const baseId = `bot:${candidate.name}`;
  let id = baseId;
  let suffix = 1;

  while (humanIds.has(id) || usedBotIds.has(id)) {
    id = `${baseId}:${suffix++}`;
  }

  usedBotIds.add(id);

  return {
    id,
    kind: "bot",
    displayName: candidate.name,
    botProfileName: candidate.name,
  };
}

function createTeam(id: "teamA" | "teamB", gameSide: "t" | "ct", name: string, participants: MatchParticipant[]): MatchTeam {
  return {
    id,
    gameSide,
    name,
    participants,
  };
}
