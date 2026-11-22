import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertPlainPath } from "../shared/managedFiles.js";
import { competMatchStatsPath } from "./competMatchStats.js";

const matchIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,127}$/);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const quitObservationSchema = z.strictObject({
  version: z.literal(1), matchId: matchIdSchema,
  kind: z.enum(["compet_empty_server", "controlled", "external"]),
  atUnix: nonnegative.min(1),
});

// Read old checkpoints without relying on their Get5 evidence for settlement.
const legacyGet5Line = /^L (?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/\d{4} - (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d: \[get5\.smx\] Shutting down server after 600 continuous seconds with only ([0-9]) active clients\.$/;
const legacyGet5EvidenceSchema = z.strictObject({
  relativePath: z.string().regex(/^(?:csgo\/addons\/sourcemod\/logs|csgo\/logs)\/L[A-Za-z0-9_.-]{0,160}\.log$/),
  byteOffset: nonnegative,
  line: z.string().regex(legacyGet5Line),
  activeClients: nonnegative.max(9),
  verifiedAgainstHistory: z.literal(true).optional(),
  historyIndexVersion: z.union([z.literal(2), z.literal(3)]).optional(),
}).refine(evidence => Number(legacyGet5Line.exec(evidence.line)?.[1]) === evidence.activeClients);
const observationFileSchema = z.enum(["shutdown-observation.json", "get5-flow-entered.json", "get5-flow-at-exit.json"]);
export const shutdownEvidenceSchema = z.strictObject({
  version: z.literal(1), matchId: matchIdSchema,
  quit: quitObservationSchema.optional(),
  get5: legacyGet5EvidenceSchema.optional(),
  get5FlowAtExit: z.enum(["before_get5", "entered", "missing", "unknown"]).optional(),
  get5LogPending: z.literal(true).optional(),
  unverifiedObservationFiles: z.array(observationFileSchema).min(1).max(observationFileSchema.options.length).optional(),
}).refine(evidence => (!evidence.quit || evidence.quit.matchId === evidence.matchId) &&
  (!evidence.get5 || evidence.quit?.kind === "external") &&
  (!evidence.get5LogPending || (evidence.quit?.kind === "external" && !evidence.get5)) &&
  (!evidence.unverifiedObservationFiles || (!evidence.get5FlowAtExit && !evidence.get5)));

type QuitObservation = z.infer<typeof quitObservationSchema>;
export type ShutdownEvidence = z.infer<typeof shutdownEvidenceSchema>;

const INVALID_OBSERVATION = "shutdown_observation_invalid";

function invalidObservation(): never {
  throw Object.assign(new Error(INVALID_OBSERVATION), { code: INVALID_OBSERVATION });
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function readQuitObservation(file: string, gameKey: string): Promise<QuitObservation | undefined> {
  await assertPlainPath(path.dirname(file));
  const before = await lstat(file, { bigint: true }).catch(error => {
    if (errorCode(error) === "ENOTDIR") invalidObservation();
    throw error;
  });
  if (!before.isFile() || before.nlink !== 1n || before.size > 4096n) invalidObservation();
  try {
    const handle = await open(file, constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
    try {
      const check = async () => {
        const opened = await handle.stat({ bigint: true });
        const linked = await lstat(file, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || !linked.isFile() || linked.nlink !== 1n ||
            opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
            linked.dev !== opened.dev || linked.ino !== opened.ino || linked.size !== opened.size ||
            opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) invalidObservation();
      };
      await check();
      const raw = await handle.readFile("utf8");
      await check();
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch (error) {
        if (error instanceof SyntaxError) invalidObservation();
        throw error;
      }
      const quit = quitObservationSchema.safeParse(parsed);
      if (!quit.success || quit.data.matchId !== gameKey) invalidObservation();
      return quit.data;
    } finally {
      await handle.close();
    }
  } catch (error) {
    // A file disappearing after its initial stat cannot supply evidence.
    if (errorCode(error) === "ENOENT") invalidObservation();
    throw error;
  }
}

export async function collectShutdownEvidence(serverRoot: string, gameKey: string): Promise<ShutdownEvidence> {
  matchIdSchema.parse(gameKey);
  const directory = path.dirname(competMatchStatsPath(path.resolve(serverRoot), gameKey));
  const quit = await readQuitObservation(path.join(directory, "shutdown-observation.json"), gameKey).catch(error => {
    const code = errorCode(error);
    if (code === "ENOENT") return undefined;
    if (code !== INVALID_OBSERVATION && code !== "managed_path_linked" && code !== "managed_path_type_conflict" && code !== "ELOOP") throw error;
    process.stderr.write("[Compet] Shutdown evidence for " + gameKey + ": unusable shutdown-observation.json (" + code + ")\n");
    return undefined;
  });
  return { version: 1, matchId: gameKey, ...(quit ? { quit } : {}) };
}
