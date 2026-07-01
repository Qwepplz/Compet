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
  logoImage?: string;
  participants: MatchParticipant[];
}

export interface MatchHalfScore {
  team1Score: number;
  team2Score: number;
}

export interface MatchSeriesResult {
  winner: TeamSide;
  team1SeriesScore: number;
  team2SeriesScore: number;
  mapName: string;
  team1Name: string;
  team1LogoImage?: string;
  team2Name: string;
  team2LogoImage?: string;
  team1Score: number;
  team2Score: number;
  firstHalfScore?: MatchHalfScore;
  secondHalfScore?: MatchHalfScore;
  players: MatchPlayerResult[];
  completedAt: string;
}

export interface MatchPlayerResult {
  steam64: string;
  name: string;
  kind?: ParticipantKind;
  botCategory?: "pro";
  avatarUrl?: string;
  team: TeamSide;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  headshots: number;
  rating2?: number;
  rankmeScoreDelta?: number;
}
export interface MatchPlan {
  id: string;
  phase: MatchPhase;
  map: string;
  teamA: MatchTeam;
  teamB: MatchTeam;
  connectPassword: string;
  createdAt: string;
  rankmeScoresBefore?: Record<string, number>;
}
