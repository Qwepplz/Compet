export interface BotRosterTeam {
  name: string;
  players: string[];
  logo?: string;
}

type Token = string | "{" | "}";

function tokenizeKeyValues(content: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\"([^\"]*)\"|[{}]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    tokens.push(match[0] === "{" || match[0] === "}" ? match[0] : match[1]);
  }

  return tokens;
}

function readTeam(tokens: Token[], start: number, name: string): { next: number; team: BotRosterTeam } {
  let index = start;
  const team: BotRosterTeam = { name, players: [] };

  while (index < tokens.length) {
    const token = tokens[index++];
    if (token === "}") {
      break;
    }

    const value = tokens[index++];
    if (typeof token !== "string" || typeof value !== "string") {
      continue;
    }

    if (token === "players") {
      team.players = value.split(",").map((player) => player.trim()).filter(Boolean);
    } else if (token === "logo" && value) {
      team.logo = value;
    }
  }

  return { next: index, team };
}

export function parseBotRosters(content: string): BotRosterTeam[] {
  const tokens = tokenizeKeyValues(content);
  const teams: BotRosterTeam[] = [];
  let index = 0;

  if (tokens[index] === "Teams") {
    index += 1;
  }
  if (tokens[index] === "{") {
    index += 1;
  }

  while (index < tokens.length) {
    const name = tokens[index++];
    if (name === "}") {
      break;
    }
    if (typeof name !== "string" || tokens[index] !== "{") {
      continue;
    }

    const parsed = readTeam(tokens, index + 1, name);
    teams.push(parsed.team);
    index = parsed.next;
  }

  return teams;
}
