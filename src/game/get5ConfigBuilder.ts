import type { MatchParticipant, MatchPlan, MatchTeam } from "../matchmaking/types.js";
import { GET5_MATCH_STATS_PATH_FORMAT } from "./get5MatchResult.js";

export interface Get5BuildInput {
  matchPlan: MatchPlan;
  mapPool: string[];
}

export interface Get5TeamConfig {
  name: string;
  tag: string;
  logo?: string;
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
      mp_match_can_clinch: "1",
      mp_maxrounds: "24",
      mp_overtime_enable: "1",
      mp_overtime_maxrounds: "6",
      tv_enable: "1",
      get5_stats_path_format: GET5_MATCH_STATS_PATH_FORMAT,
      ...buildTeamDisplayCvars(input.matchPlan),
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
    ...(team.logo ? { logo: team.logo } : {}),
    players,
  };
}

function buildMapSides(team1: MatchTeam): string[] {
  return [team1.gameSide === "t" ? "team1_t" : "team1_ct"];
}

function buildTeamDisplayCvars(matchPlan: MatchPlan): Record<string, string> {
  const ctTeam = [matchPlan.teamA, matchPlan.teamB].find((team) => team.gameSide === "ct");
  const tTeam = [matchPlan.teamA, matchPlan.teamB].find((team) => team.gameSide === "t");
  return {
    mp_teamname_1: ctTeam?.name ?? "",
    mp_teamname_2: tTeam?.name ?? "",
    mp_teamlogo_1: ctTeam?.logo ?? "",
    mp_teamlogo_2: tTeam?.logo ?? "",
  };
}

function resolveHumanSteam64(participant: MatchParticipant): string | undefined {
  if (participant.kind !== "human") return undefined;

  const steam64 = participant.steam64?.trim();
  return steam64 || undefined;
}
