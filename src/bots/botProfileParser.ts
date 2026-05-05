export interface BotProfileEntry {
  name: string;
  templates: string[];
}

export function parseBotProfiles(content: string): BotProfileEntry[] {
  const entries: BotProfileEntry[] = [];

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("Template ") || line === "Default" || line === "End") {
      continue;
    }
    if (line.includes("=")) {
      continue;
    }

    const match = line.match(/^([^\"]+)\s+\"([^\"]+)\"$/);
    if (!match) {
      continue;
    }

    entries.push({
      templates: match[1].split("+").map((part) => part.trim()).filter(Boolean),
      name: match[2],
    });
  }

  return entries;
}
