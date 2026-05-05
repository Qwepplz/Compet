import type { MatchParticipant, MatchPlan, MatchTeam } from "../matchmaking/types.js";

export interface Get5BuildInput {
  matchPlan: MatchPlan;
  mapPool: string[];
}

export interface Get5TeamConfig {
  name: string;
  tag: string;
  players: string[];
}

export interface Get5MatchConfig {
  matchid: string;
  players_per_team: 5;
  num_maps: 1;
  skip_veto: true;
  maplist: string[];
  map_sides: string[];
  team1: Get5TeamConfig;
  team2: Get5TeamConfig;
  cvars: Record<string, string>;
}

export function buildGet5Config(input: Get5BuildInput): Get5MatchConfig {
  const team1 = buildTeamConfig(input.matchPlan.teamA);
  const team2 = buildTeamConfig(input.matchPlan.teamB);

  return {
    matchid: input.matchPlan.id,
    players_per_team: 5,
    num_maps: 1,
    skip_veto: true,
    maplist: input.matchPlan.map ? [input.matchPlan.map] : [...input.mapPool],
    map_sides: buildMapSides(input.matchPlan.teamA),
    team1,
    team2,
    cvars: {
      mp_autoteambalance: "0",
      mp_limitteams: "0",
      tv_enable: "1",
    },
  };
}

function buildTeamConfig(team: MatchTeam): Get5TeamConfig {
  const players: string[] = [];

  team.participants.forEach((participant) => {
    const steam64 = resolveHumanSteam64(participant);

    if (steam64) {
      players.push(steam64);
    }
  });

  return {
    name: team.name,
    tag: "",
    players,
  };
}

function buildMapSides(team1: MatchTeam): string[] {
  return [team1.gameSide === "t" ? "team1_t" : "team1_ct"];
}

function resolveHumanSteam64(participant: MatchParticipant): string | undefined {
  if (participant.kind !== "human") return undefined;

  const steam64 = participant.steam64?.trim();
  return steam64 || undefined;
}

