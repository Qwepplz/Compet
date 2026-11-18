import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { MatchFailureCause } from "../matchmaking/types.js";
import { assertPlainPath } from "../shared/managedFiles.js";
import { competMatchStatsPath } from "./competMatchStats.js";
import type { GameServerExitInfo } from "./gameServerLauncher.js";

const LOG_DIRECTORIES = ["csgo/addons/sourcemod/logs", "csgo/logs"] as const;
const LOG_FILE = /^L[A-Za-z0-9_.-]{0,160}\.log$/;
const ROTATED_LOG_FILE = /^L[A-Za-z0-9_.-]{0,160}\.log(?:\.[0-9]+|-[0-9]{8}(?:[0-9]{2})?)$/;
const LOG_LIKE_FILE = /^L.*\.log/i;
const HISTORY_READ_LIMIT = 32 * 1024 * 1024;
const HISTORY_INDEX_VERSION = 3;
const historyIndexVersionSchema = z.union([z.literal(2), z.literal(HISTORY_INDEX_VERSION)]);
const GET5_LINE = /^L (?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/\d{4} - (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d: \[get5\.smx\] Shutting down server after 600 continuous seconds with only ([0-9]) active clients\.$/;
const BOUNDARY_BYTES = 4096;
const MAX_LINE_BYTES = 4096;
const UNSAFE_LOG_BOUNDARY = "shutdown_log_boundary_invalid";

const matchIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,127}$/);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.string().regex(/^(?:0|[1-9]\d*)$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const logPath = z.string().refine(value => isLogPath(value, LOG_FILE));
const historicalLogPath = z.string().refine(value => isLogPath(value, LOG_FILE) || isLogPath(value, ROTATED_LOG_FILE));

function isLogPath(value: string, filename: RegExp): boolean {
  return LOG_DIRECTORIES.some(directory => value.startsWith(directory + "/") && filename.test(value.slice(directory.length + 1)));
}
const directorySchema = z.discriminatedUnion("existed", [
  z.strictObject({ relativePath: z.enum(LOG_DIRECTORIES), existed: z.literal(false) }),
  z.strictObject({ relativePath: z.enum(LOG_DIRECTORIES), existed: z.literal(true), dev: identity, ino: identity }),
]);
const logFileSchema = z.strictObject({
  relativePath: historicalLogPath, dev: identity, ino: identity, size: nonnegative, endsWithNewline: z.boolean(),
  changedAt: z.string().regex(/^-?[0-9]+:-?[0-9]+$/).optional(),
  headSha256: sha256, tailSha256: sha256,
});
export const shutdownLogBaselineSchema = z.strictObject({
  version: z.literal(1),
  matchId: matchIdSchema,
  serverRoot: z.string().refine(value => path.isAbsolute(value) && path.resolve(value) === value),
  serverRootIdentity: z.strictObject({ dev: identity, ino: identity }),
  directories: z.array(directorySchema).length(LOG_DIRECTORIES.length),
  files: z.array(logFileSchema),
  historicalGet5LineSha256: z.array(sha256).optional(),
  historyIndexVersion: historyIndexVersionSchema.optional(),
}).refine(baseline => {
  const directories = new Set(baseline.directories.filter(dir => dir.existed).map(dir => dir.relativePath));
  return new Set(baseline.directories.map(dir => dir.relativePath)).size === LOG_DIRECTORIES.length &&
    new Set(baseline.files.map(file => file.relativePath)).size === baseline.files.length &&
    new Set(baseline.files.map(identityKey)).size === baseline.files.length &&
    baseline.files.every(file => LOG_DIRECTORIES.some(dir => directories.has(dir) && file.relativePath.startsWith(dir + "/")));
});
const quitObservationSchema = z.strictObject({
  version: z.literal(1), matchId: matchIdSchema,
  kind: z.enum(["compet_empty_server", "controlled", "external"]),
  atUnix: nonnegative.min(1),
});
const get5EvidenceSchema = z.strictObject({
  relativePath: logPath, byteOffset: nonnegative, line: z.string().regex(GET5_LINE),
  activeClients: nonnegative.max(9),
  verifiedAgainstHistory: z.literal(true).optional(), // Legacy index covered active logs only.
  historyIndexVersion: historyIndexVersionSchema.optional(),
}).refine(evidence => Number(GET5_LINE.exec(evidence.line)?.[1]) === evidence.activeClients);
export const shutdownEvidenceSchema = z.strictObject({
  version: z.literal(1), matchId: matchIdSchema,
  quit: quitObservationSchema.optional(), get5: get5EvidenceSchema.optional(),
}).refine(evidence => (!evidence.quit || evidence.quit.matchId === evidence.matchId) &&
  (!evidence.get5 || evidence.quit?.kind === "external"));

export type QuitObservation = z.infer<typeof quitObservationSchema>;
export type ShutdownLogBaseline = z.infer<typeof shutdownLogBaselineSchema>;
export type ShutdownEvidence = z.infer<typeof shutdownEvidenceSchema>;
type FileIdentity = { dev: string; ino: string };
type LogDirectory = z.infer<typeof directorySchema>;
type LogFile = FileIdentity & { relativePath: string; size: number; changedAt: string };
type HistoricalLogFile = { file: ShutdownLogBaseline["files"][number]; lines: string[] };
export type ShutdownLogHistoryCache = Map<string, HistoricalLogFile>;
type Get5Evidence = z.infer<typeof get5EvidenceSchema>;
type Get5LogLine = Omit<Get5Evidence, "verifiedAgainstHistory" | "historyIndexVersion">;

function identityKey(value: FileIdentity): string { return value.dev + ":" + value.ino; }

function statChangeTime(info: BigIntStats): string { return info.mtimeNs + ":" + info.ctimeNs; }

function sameLogFile(saved: Omit<LogFile, "changedAt"> & { changedAt?: string }, current: LogFile): boolean {
  return saved.relativePath === current.relativePath && identityKey(saved) === identityKey(current) &&
    saved.size === current.size && saved.changedAt === current.changedAt;
}

function unsafe(): never {
  throw Object.assign(new Error(UNSAFE_LOG_BOUNDARY), { code: UNSAFE_LOG_BOUNDARY });
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function diagnostic(matchId: string, reason: string): void {
  process.stderr.write("[Compet] Shutdown evidence for " + matchId + ": " + reason + "\n");
}

async function readRootIdentity(serverRoot: string): Promise<FileIdentity> {
  await assertPlainPath(serverRoot);
  const info = await lstat(serverRoot, { bigint: true });
  if (!info.isDirectory()) unsafe();
  return { dev: String(info.dev), ino: String(info.ino) };
}

async function listLogs(serverRoot: string, signal?: AbortSignal): Promise<{
  directories: LogDirectory[]; files: LogFile[]; unsupportedArchive: boolean;
}> {
  const directories: LogDirectory[] = [];
  const files: LogFile[] = [];
  let unsupportedArchive = false;
  for (const relativePath of LOG_DIRECTORIES) {
    signal?.throwIfAborted();
    const directory = path.join(serverRoot, relativePath);
    await assertPlainPath(directory);
    const info = await lstat(directory, { bigint: true }).catch(error => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!info) {
      directories.push({ relativePath, existed: false });
      continue;
    }
    if (!info.isDirectory()) unsafe();
    directories.push({ relativePath, existed: true, dev: String(info.dev), ino: String(info.ino) });
    for (const name of (await readdir(directory)).sort()) {
      signal?.throwIfAborted();
      if (!LOG_LIKE_FILE.test(name)) continue;
      const firstExtension = name.toLowerCase().indexOf(".log");
      const repeatedExtension = firstExtension !== name.toLowerCase().lastIndexOf(".log");
      if (repeatedExtension || (!LOG_FILE.test(name) && !ROTATED_LOG_FILE.test(name))) {
        if (!repeatedExtension && name.startsWith("L") && name.endsWith(".log")) unsafe();
        unsupportedArchive = true;
        continue;
      }
      const file = await lstat(path.join(directory, name), { bigint: true });
      const size = Number(file.size);
      if (!file.isFile() || file.nlink !== 1n || !Number.isSafeInteger(size)) unsafe();
      files.push({ relativePath: relativePath + "/" + name, dev: String(file.dev), ino: String(file.ino), size, changedAt: statChangeTime(file) });
    }
    const after = await lstat(directory, { bigint: true });
    if (!after.isDirectory() || after.ino !== info.ino || after.dev !== info.dev) unsafe();
  }
  if (new Set(files.map(identityKey)).size !== files.length) unsafe();
  return { directories, files, unsupportedArchive };
}

async function readRegular<T>(absolute: string, action: (handle: FileHandle, size: number) => Promise<T>, expected?: LogFile): Promise<T> {
  await assertPlainPath(absolute);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || !Number.isSafeInteger(Number(before.size))) unsafe();
  const handle = await open(absolute, constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
  try {
    const check = async () => {
      const opened = await handle.stat({ bigint: true });
      const linked = await lstat(absolute, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !linked.isFile() || linked.nlink !== 1n ||
          opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
          linked.dev !== opened.dev || linked.ino !== opened.ino || linked.size !== opened.size ||
          opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs ||
          (expected && (expected.dev !== String(opened.dev) || expected.ino !== String(opened.ino) ||
            expected.size !== Number(opened.size) || expected.changedAt !== statChangeTime(opened)))) unsafe();
    };
    await check();
    const value = await action(handle, Number(before.size));
    await check();
    return value;
  } finally {
    await handle.close();
  }
}

async function readBytes(handle: FileHandle, start: number, size: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(buffer, position, size - position, start + position);
    if (!bytesRead) unsafe();
    position += bytesRead;
  }
  return buffer;
}

function digest(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }

export async function captureShutdownLogBaseline(
  serverRoot: string, matchId: string,
  { signal, historyCache }: { signal?: AbortSignal; historyCache?: ShutdownLogHistoryCache } = {},
): Promise<ShutdownLogBaseline> {
  signal?.throwIfAborted();
  serverRoot = path.resolve(serverRoot);
  const serverRootIdentity = await readRootIdentity(serverRoot);
  const snapshot = await listLogs(serverRoot, signal);
  const files: ShutdownLogBaseline["files"] = [];
  const historicalGet5Lines = new Set<string>();
  let remainingBytes = HISTORY_READ_LIMIT;
  let historyComplete = !snapshot.unsupportedArchive;

  if (historyCache) {
    const existing = new Set(snapshot.files.map(file => path.join(serverRoot, file.relativePath)));
    for (const file of historyCache.keys()) if (!existing.has(file)) historyCache.delete(file);
  }
  for (const file of snapshot.files) {
    signal?.throwIfAborted();
    const absolute = path.join(serverRoot, file.relativePath);
    let history = historyCache?.get(absolute);
    if (!history || !sameLogFile(history.file, file)) {
      historyCache?.delete(absolute);
      const length = Math.min(file.size, BOUNDARY_BYTES);
      const bytes = file.size + (file.size === length ? length : 2 * length);
      if (bytes > remainingBytes) {
        historyComplete = false;
        continue;
      }
      remainingBytes -= bytes;
      history = await readRegular(absolute, async (handle, size) => {
        const head = await readBytes(handle, 0, length);
        signal?.throwIfAborted();
        const tail = size === length ? head : await readBytes(handle, size - length, length);
        const lines = new Set<string>();
        for await (const entry of scanGet5Lines(handle, file.relativePath, 0, size, { includeUnterminated: true, signal })) {
          lines.add(digest(entry.line));
        }
        return {
          file: { ...file, endsWithNewline: size === 0 || tail.at(-1) === 10, headSha256: digest(head), tailSha256: digest(tail) },
          lines: [...lines],
        };
      }, file);
      historyCache?.set(absolute, history);
    }
    files.push(history.file);
    for (const line of history.lines) historicalGet5Lines.add(line);
  }
  signal?.throwIfAborted();
  const after = await listLogs(serverRoot, signal);
  if (identityKey(await readRootIdentity(serverRoot)) !== identityKey(serverRootIdentity) ||
      JSON.stringify(after.directories) !== JSON.stringify(snapshot.directories) ||
      after.unsupportedArchive !== snapshot.unsupportedArchive || after.files.length !== snapshot.files.length ||
      after.files.some((file, index) => !sameLogFile(snapshot.files[index]!, file))) unsafe();
  signal?.throwIfAborted();
  if (!historyComplete) diagnostic(matchId, "historical log coverage is incomplete (archive format or read budget)");
  return shutdownLogBaselineSchema.parse({
    version: 1, matchId, serverRoot, serverRootIdentity, directories: snapshot.directories, files,
    ...(historyComplete ? {
      historyIndexVersion: HISTORY_INDEX_VERSION, historicalGet5LineSha256: [...historicalGet5Lines].sort(),
    } : {}),
  });
}

function parseGet5Line(bytes: Buffer, relativePath: string, byteOffset: number): Get5LogLine | undefined {
  const line = bytes.toString("utf8", 0, bytes.at(-1) === 13 ? bytes.length - 1 : bytes.length);
  const activeClients = GET5_LINE.exec(line)?.[1];
  if (activeClients !== undefined) return { relativePath, byteOffset, line, activeClients: Number(activeClients) };
}

async function* scanGet5Lines(
  handle: FileHandle, relativePath: string, start: number, end: number,
  options: { skipFirstLine?: boolean; includeUnterminated?: boolean; signal?: AbortSignal },
): AsyncGenerator<Get5LogLine> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let lineOffset = start;
  let line: Buffer = Buffer.alloc(0);
  let skip = options.skipFirstLine ?? false;
  for (let offset = start; offset < end;) {
    options.signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
    options.signal?.throwIfAborted();
    if (!bytesRead) unsafe();
    const chunk = buffer.subarray(0, bytesRead);
    for (let cursor = 0; cursor < bytesRead;) {
      const newline = chunk.indexOf(10, cursor);
      const next = newline < 0 ? bytesRead : newline;
      if (!skip) {
        const part = chunk.subarray(cursor, next);
        if (line.length + part.length > MAX_LINE_BYTES) skip = true;
        else if (line.length) line = Buffer.concat([line, part]);
        else line = newline < 0 ? Buffer.from(part) : part;
      }
      if (newline < 0) break;
      if (!skip) {
        const found = parseGet5Line(line, relativePath, lineOffset);
        if (found) yield found;
      }
      skip = false;
      line = Buffer.alloc(0);
      cursor = newline + 1;
      lineOffset = offset + cursor;
    }
    offset += bytesRead;
  }
  if (options.includeUnterminated && !skip && line.length) {
    const found = parseGet5Line(line, relativePath, lineOffset);
    if (found) yield found;
  }
}

async function collectGet5(
  serverRoot: string, baseline: ShutdownLogBaseline, historicalLines: ReadonlySet<string>,
): Promise<Get5Evidence | undefined> {
  const expectedRoot = identityKey(baseline.serverRootIdentity);
  if (identityKey(await readRootIdentity(serverRoot)) !== expectedRoot) unsafe();
  const snapshot = await listLogs(serverRoot);
  if (snapshot.unsupportedArchive) unsafe();
  for (const previous of baseline.directories) {
    const directory = snapshot.directories.find(dir => dir.relativePath === previous.relativePath);
    if (previous.existed && (!directory?.existed || identityKey(previous) !== identityKey(directory))) unsafe();
  }
  const previousByPath = new Map(baseline.files.map(file => [file.relativePath, file]));
  const currentByPath = new Map(snapshot.files.map(file => [file.relativePath, file]));
  for (const previous of baseline.files) {
    const current = currentByPath.get(previous.relativePath);
    if (!current || identityKey(previous) !== identityKey(current) || current.size < previous.size) unsafe();
    if (isLogPath(previous.relativePath, ROTATED_LOG_FILE) && !sameLogFile(previous, current)) unsafe();
  }
  const samples = new Map<number, Set<string>>();
  for (const previous of baseline.files) {
    const length = Math.min(BOUNDARY_BYTES, previous.size);
    if (!length) continue;
    const digests = samples.get(length) ?? new Set();
    digests.add(previous.headSha256);
    samples.set(length, digests);
  }
  let evidence: Get5Evidence | undefined;
  for (const current of snapshot.files) {
    if (!isLogPath(current.relativePath, LOG_FILE)) {
      if (!previousByPath.has(current.relativePath)) unsafe();
      continue;
    }
    const previous = previousByPath.get(current.relativePath);
    const found = await readRegular<Get5Evidence | undefined>(path.join(serverRoot, current.relativePath), async (handle, size) => {
      if (previous) {
        const length = Math.min(previous.size, BOUNDARY_BYTES);
        if (digest(await readBytes(handle, previous.size - length, length)) !== previous.tailSha256) unsafe();
      } else {
        const head = await readBytes(handle, 0, Math.min(size, BOUNDARY_BYTES));
        for (const [length, hashes] of samples) {
          if (head.length >= length && hashes.has(digest(head.subarray(0, length)))) unsafe();
        }
      }
      const lines = scanGet5Lines(handle, current.relativePath, previous?.size ?? 0, size, {
        skipFirstLine: previous?.endsWithNewline === false,
      });
      for await (const entry of lines) {
        if (!historicalLines.has(digest(entry.line))) return { ...entry, historyIndexVersion: HISTORY_INDEX_VERSION };
      }
      return undefined;
    }, current);
    evidence ??= found;
  }
  if (identityKey(await readRootIdentity(serverRoot)) !== expectedRoot) unsafe();
  return evidence;
}

export async function collectShutdownEvidence(
  serverRoot: string,
  matchId: string,
  baseline?: ShutdownLogBaseline | (() => Promise<ShutdownLogBaseline | undefined>),
): Promise<ShutdownEvidence> {
  matchIdSchema.parse(matchId);
  serverRoot = path.resolve(serverRoot);
  const evidence: ShutdownEvidence = { version: 1, matchId };
  const observation = path.join(path.dirname(competMatchStatsPath(serverRoot, matchId)), "shutdown-observation.json");
  try {
    evidence.quit = await readRegular(observation, async (handle, size) => {
      try {
        const raw = size <= 4096 ? JSON.parse(await handle.readFile("utf8")) : undefined;
        const parsed = quitObservationSchema.safeParse(raw);
        if (parsed.success && parsed.data.matchId === matchId) return parsed.data;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      diagnostic(matchId, "invalid quit observation");
      return undefined;
    });
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== UNSAFE_LOG_BOUNDARY && code !== "managed_path_linked" && code !== "managed_path_type_conflict") throw error;
    diagnostic(matchId, "no usable quit observation (" + code + ")");
  }
  if (!evidence.quit) return { version: 1, matchId };
  if (evidence.quit.kind !== "external") return evidence;
  if (typeof baseline === "function") baseline = await baseline();
  if (!baseline) {
    diagnostic(matchId, "no pre-launch log baseline for external quit");
    return evidence;
  }
  if (!shutdownLogBaselineSchema.safeParse(baseline).success || baseline.matchId !== matchId || baseline.serverRoot !== serverRoot) {
    throw new Error("shutdown_log_baseline_invalid");
  }
  if (baseline.historyIndexVersion !== HISTORY_INDEX_VERSION || !baseline.historicalGet5LineSha256) {
    diagnostic(matchId, "pre-launch history does not establish rotation coverage");
    return evidence;
  }
  try {
    const get5 = await collectGet5(serverRoot, baseline, new Set(baseline.historicalGet5LineSha256));
    if (get5) evidence.get5 = get5;
    else diagnostic(matchId, "no matching get5 shutdown line");
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== UNSAFE_LOG_BOUNDARY && code !== "managed_path_linked" && code !== "managed_path_type_conflict" && code !== "ELOOP") throw error;
    diagnostic(matchId, "unusable log boundary (" + code + ")");
  }
  return evidence;
}

export function classifyFailureCause(matchId: string, evidence: ShutdownEvidence | undefined, exitInfo: GameServerExitInfo, normalResult: boolean): MatchFailureCause {
  if (normalResult || !evidence || evidence.matchId !== matchId || !shutdownEvidenceSchema.safeParse(evidence).success) return "other";
  const quit = evidence.quit;
  if (!quit || quit.kind === "controlled") return "other";
  if (exitInfo.signal || exitInfo.signalNumber !== undefined || (exitInfo.code !== null && exitInfo.code !== 0)) {
    if (quit.kind === "compet_empty_server" || evidence.get5) diagnostic(matchId, "quit evidence conflicts with the exit status");
    return "other";
  }
  if (exitInfo.wrapperExitUnconfirmed) {
    diagnostic(matchId, "PTY exit status remained unconfirmed");
    return "other";
  }
  if (quit.kind === "compet_empty_server") return "compet_empty_server";
  return evidence.get5?.historyIndexVersion === HISTORY_INDEX_VERSION ? "get5_insufficient_players" : "other";
}
