export type ParticipantKind = "human" | "bot";
export type TeamSide = "teamA" | "teamB";
export type GameSide = "t" | "ct";
export type MatchPhase = "queue" | "ready" | "match_room" | "map_randomizing" | "server_prepare" | "connect" | "live" | "completed" | "failed";

export interface MatchParticipant {
  id: string;
  kind: ParticipantKind;
  displayName: string;
  steam64?: string;
  steamPersonaName?: string;
  steamAvatarUrl?: string;
  botProfileName?: string;
  botCategory?: "pro";
  isCaptain?: boolean;
  accountId?: string;
  identityMasked?: boolean;
}

export interface MatchTeam {
  id: TeamSide;
  gameSide: GameSide;
  name: string;
  logo?: string;
  participants: MatchParticipant[];
}

export interface MatchSeriesResult {
  winner: TeamSide;
  team1SeriesScore: number;
  team2SeriesScore: number;
  completedAt: string;
}
export interface MatchPlan {
  id: string;
  phase: MatchPhase;
  map: string;
  teamA: MatchTeam;
  teamB: MatchTeam;
  connectPassword: string;
  createdAt: string;
}
