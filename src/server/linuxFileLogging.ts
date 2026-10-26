import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { FileLogStore } from "../manager/main/logStore.js";
import { XzLogArchiver, SevenZipXzCodec } from "./xzLogArchiver.js";
import { SevenZipTarXzCodec } from "../archive/tarXzCodec.js";
import { assertPlainPath } from "../desktop/main/serverManagedFiles.js";
import { redactSensitiveText } from "../shared/redactSensitiveText.js";
import { isActivityLogInput, SERVER_ACTIVITY_PREFIX, type ActivityLogInput } from "../shared/activityLog.js";

export type LinuxLogStream = "stdout" | "stderr";
export interface LinuxFileLoggingInput { dataDir: string; installRoot: string }
export interface LinuxFileLogging { flush(): Promise<void>; close(): Promise<void> }

export function parseLinuxLogLine(line: string, stream: LinuxLogStream, now: Date): ActivityLogInput {
  const raw = (level: ActivityLogInput["level"]): ActivityLogInput => ({ source: "server", level, message: line, timestamp: now.toISOString() });
  if (stream !== "stdout" || !line.startsWith(SERVER_ACTIVITY_PREFIX)) return raw(stream === "stderr" ? "error" : "info");
  try {
    const value: unknown = JSON.parse(line.slice(SERVER_ACTIVITY_PREFIX.length));
    if (!isActivityLogInput(value)) return raw("warn");
    const candidate = typeof value.timestamp === "string" ? new Date(value.timestamp) : null;
    const iso = candidate && Number.isFinite(candidate.getTime()) ? candidate.toISOString() : "";
    const entry: ActivityLogInput = { source: value.source, level: value.level, message: value.message,
      timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{3}Z$/.test(iso) ? iso : now.toISOString() };
    const actor = value.actor;
    if (actor && typeof actor === "object" && typeof actor.username === "string") {
      entry.actor = { username: actor.username,
        ...(actor.role === "admin" || actor.role === "player" ? { role: actor.role } : {}),
        ...(typeof actor.accountId === "string" ? { accountId: actor.accountId } : {}),
        ...(typeof actor.steam64 === "string" ? { steam64: actor.steam64 } : {}) };
    }
    if (value.context && Object.getPrototypeOf(value.context) === Object.prototype) {
      entry.context = Object.fromEntries(Object.entries(value.context).filter(([, v]) =>
        v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)));
    }
    return entry;
  } catch { return raw("warn"); }
}

const lineLimit = 1024 * 1024;
// Long lines cannot be retained whole. Carry recognition and suppression across
// fragments, including arbitrarily long whitespace and quoted/unquoted values.
function fragmentRedactor() {
  // Match the shared redactor's replacement order. In particular, quoted
  // secrets must be hidden before a preceding bare value can consume their key.
  const stages = (["quoted", "unquoted", "bearer"] as const).map(mode => {
    let state: "text" | "separator" | "value" | "quoted" | "secret" | "bearer" | "bearerGap" = "text";
    let tail = "", word = "", closingQuote = false, marked = false;
    return (input: string): string => {
      const output: string[] = [];
      let start = 0;
      for (let i = 0; i < input.length; i++) {
        const char = input[i]!, lower = char.toLowerCase();
        let hide = false;
        if (state === "quoted") {
          if (/["']/.test(char)) { state = "text"; tail = ""; }
          else hide = true;
        } else if (state === "secret") {
          if ((mode === "bearer" ? /\s/ : /[\s,;"'}]/).test(char)) { state = "text"; tail = ""; }
          else hide = true;
        } else if (state === "separator") {
          if (char === '"' && closingQuote) closingQuote = false;
          else if (/\s/.test(char)) closingQuote = false;
          else if (char === ":" || char === "=") state = "value";
          else state = "text";
        } else if (state === "value") {
          if (!/\s/.test(char)) {
            marked = false;
            if (mode === "quoted") state = /["']/.test(char) ? "quoted" : "text";
            else if (mode === "bearer" || !/[,;"'}]/.test(char)) { state = "secret"; hide = true; }
            else state = "text";
          }
        } else if (state === "bearer") {
          if (!word && /\s/.test(char)) { /* Header whitespace. */ }
          else if (lower === "bearer"[word.length]) {
            word += lower;
            if (word === "bearer") state = "bearerGap";
          } else state = "text";
        } else if (state === "bearerGap") {
          state = /\s/.test(char) ? "value" : "text";
        }
        if (hide) {
          if (!marked) { output.push(input.slice(start, i), "[redacted]"); marked = true; }
          start = i + 1; tail = "";
        } else {
          tail = (tail + lower).slice(-14);
          if (state === "text") {
            if (mode !== "bearer" && (tail.endsWith("password") || tail.endsWith("token"))) {
              state = "separator"; closingQuote = true;
            } else if (mode === "bearer" && tail.endsWith("authorization:")) { state = "bearer"; word = ""; }
          }
        }
      }
      output.push(input.slice(start));
      return output.join("");
    };
  });
  return (input: string): string => stages.reduce((text, stage) => stage(text), input);
}
function lineCollector(consume: (line: string, partial: boolean) => void) {
  const decoder = new StringDecoder("utf8");
  let buffer = "", partial = false;
  let redactFragment = fragmentRedactor();
  const emit = (line: string, isPartial: boolean): void => {
    let text = stripVTControlCharacters(line);
    if (isPartial) text = redactFragment(text);
    while (Buffer.byteLength(text) > lineLimit) {
      let length = prefixLength(text);
      const marker = text.lastIndexOf("[redacted]", length);
      if (marker >= 0 && marker < length && marker + "[redacted]".length > length) length = marker;
      consume(text.slice(0, length), true); text = text.slice(length);
    }
    consume(text, isPartial);
  };
  function prefixLength(text: string): number {
    let low = 0, high = Math.min(text.length, lineLimit);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(text.slice(0, mid)) > lineLimit) high = mid - 1; else low = mid;
    }
    if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
    return low;
  }
  function drain(end = false): void {
    while (buffer.length) {
      const delimiter = buffer.search(/[\r\n]/);
      if (delimiter >= 0 && delimiter < lineLimit) {
        if (!end && delimiter === buffer.length - 1 && buffer[delimiter] === "\r") return;
        const width = buffer[delimiter] === "\r" && buffer[delimiter + 1] === "\n" ? 2 : 1;
        const line = buffer.slice(0, delimiter);
        if (Buffer.byteLength(line) <= lineLimit) {
          emit(line, partial); buffer = buffer.slice(delimiter + width); partial = false; redactFragment = fragmentRedactor(); continue;
        }
      }
      if (Buffer.byteLength(buffer) > lineLimit) {
        const low = prefixLength(buffer);
        emit(buffer.slice(0, low), true); partial = true; buffer = buffer.slice(low); continue;
      }
      if (end) { emit(buffer, partial); buffer = ""; }
      return;
    }
  }
  return {
    consume(chunk: string | Uint8Array, encoding?: BufferEncoding): void {
      buffer += decoder.write(typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
      drain();
    },
    end(): void { buffer += decoder.end(); drain(true); },
  };
}

const applicationId = 1129074503;
function validateLock(db: DatabaseSync): void {
  const id = db.prepare("PRAGMA application_id").get() as { application_id: number };
  const schema = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema").get() as { count: number };
  if (id.application_id !== applicationId || schema.count !== 0) throw new Error("log_directory_lock_invalid");
}
function isBusy(error: unknown): boolean {
  const value = error as { errcode?: number; code?: string; message?: string };
  return typeof value?.errcode === "number" && (value.errcode & 255) === 5 ||
    value?.code === "SQLITE_BUSY" || /database is (?:locked|busy)/i.test(value?.message ?? "");
}
async function acquireLogDirectory(dataDir: string): Promise<{ directory: string; release(): void }> {
  if (!path.isAbsolute(dataDir)) throw new Error("log_data_directory_invalid");
  const directory = path.join(dataDir, "logs"), lock = path.join(directory, ".compet-log-owner.sqlite3");
  await assertPlainPath(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPlainPath(lock); await assertPlainPath(lock + "-journal");
  // A pathname alone cannot establish ownership of an existing rollback journal.
  if (await fs.lstat(lock + "-journal").catch(error => { if (error.code === "ENOENT") return null; throw error; })) {
    throw new Error("log_directory_journal_unowned");
  }
  let fresh = false, db: DatabaseSync | undefined;
  try {
    try {
      const handle = await fs.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.close(); fresh = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const identity = await fs.lstat(lock);
    if (!identity.isFile() || identity.nlink !== 1) throw new Error("log_directory_lock_invalid");
    if (!fresh) {
      const reader = new DatabaseSync(lock, { readOnly: true });
      try { validateLock(reader); } finally { reader.close(); }
    }
    await assertPlainPath(lock);
    const before = await fs.lstat(lock);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== identity.dev || before.ino !== identity.ino) throw new Error("log_directory_lock_invalid");
    db = new DatabaseSync(lock);
    db.exec("PRAGMA busy_timeout=0");
    if (fresh) {
      db.exec("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE");
      db.exec("PRAGMA application_id=1129074503; COMMIT");
    }
    db.exec("BEGIN IMMEDIATE");
    validateLock(db);
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    if (mode.journal_mode !== "delete") throw new Error("log_directory_lock_invalid");
    let released = false;
    const owned = db;
    return { directory, release(): void {
      if (released) return;
      released = true;
      try { owned.exec("ROLLBACK"); } finally { owned.close(); }
    } };
  } catch (error) {
    if (db) { try { db.close(); } catch { /* Preserve the original lock error. */ } }
    if (isBusy(error)) throw Object.assign(new Error("log_directory_busy"), { code: "log_directory_busy" });
    throw error;
  }
}

async function install(input: LinuxFileLoggingInput): Promise<LinuxFileLogging & { recordError(error: unknown): Promise<void> }> {
  const originalStderr = process.stderr.write;
  const reported = new Set<string>();
  const report = (error: unknown): void => {
    const value = error as NodeJS.ErrnoException;
    const key = value?.code ?? value?.message?.split(":")[0] ?? "log_failure";
    if (reported.has(key)) return;
    reported.add(key);
    try { Reflect.apply(originalStderr, process.stderr, ["Linux file logging: " + redactSensitiveText(String(error)) + "\n"]); }
    catch { /* Logging must preserve the service result. */ }
  };
  let lock: Awaited<ReturnType<typeof acquireLogDirectory>>;
  try { lock = await acquireLogDirectory(input.dataDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "log_directory_busy") throw error;
    report(error);
    return { flush: async () => undefined, close: async () => undefined, recordError: async () => undefined };
  }
  let archiver: XzLogArchiver | undefined;
  const restorers: Array<() => void> = [];
  try {
    const executable = path.join(input.installRoot, "runtime/7z/7zr");
    try {
      if (!path.isAbsolute(input.installRoot)) throw new Error("log_install_root_invalid");
      await assertPlainPath(executable);
      if (!(await fs.lstat(executable)).isFile()) throw new Error("log_compressor_type_invalid");
      await fs.access(executable, constants.X_OK);
      archiver = new XzLogArchiver(lock.directory, new SevenZipTarXzCodec(executable), { onError: report, legacyCodec: new SevenZipXzCodec(executable) });
    } catch (error) { report(new Error("log_archive_unavailable", { cause: error })); }
    const store = new FileLogStore(lock.directory, { strictFiles: true, ...(archiver ? { archiver } : {}) });
    let closing: Promise<void> | undefined, timer: NodeJS.Timeout | undefined, stopped = false, forwarding = 0;
    const collectors = (["stdout", "stderr"] as const).map(name => {
      const collector = lineCollector((line, partial) => {
        const entry = parseLinuxLogLine(line, name, new Date());
        if (partial) entry.context = { ...entry.context, partial: true };
        void store.append(entry, { preserveWhitespace: partial }).catch(report);
      });
      const stream = process[name], original = stream.write;
      const wrapped = ((...args: Parameters<typeof original>) => {
        const outermost = forwarding === 0;
        forwarding++;
        let result: boolean;
        try { result = Reflect.apply(original, stream, args) as boolean; }
        finally { forwarding--; }
        if (outermost) {
          try { collector.consume(args[0], typeof args[1] === "string" ? args[1] : undefined); }
          catch (error) { report(error); }
        }
        return result;
      }) as typeof original;
      stream.write = wrapped;
      restorers.push(() => {
        if (stream.write === wrapped) stream.write = original;
        else report(new Error("log_stream_owner_changed"));
      });
      return collector;
    });
    const scan = (): Promise<void> => stopped ? Promise.resolve() : store.archiveExpiredLogs().catch(report);
    const schedule = (): void => {
      if (stopped) return;
      const now = new Date();
      const delay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
      timer = setTimeout(() => { void scan().finally(schedule); }, delay);
      timer.unref();
    };
    void scan(); schedule();
    return {
      flush: () => store.flush(),
      recordError: async error => {
        report(error);
        await store.append({ source: "server", level: "error", message: redactSensitiveText(String(error)) }).catch(report);
      },
      close: () => closing ??= (async () => {
        stopped = true; if (timer) clearTimeout(timer);
        for (const collector of collectors) { try { collector.end(); } catch (error) { report(error); } }
        for (const restore of restorers) restore();
        try { await store.flush(); } catch (error) { report(error); }
        try { await archiver?.close(); } catch (error) { report(error); }
        try { lock.release(); } catch (error) { report(error); }
      })(),
    };
  } catch (error) {
    for (const restore of restorers) restore();
    await archiver?.close().catch(report);
    try { lock.release(); } catch (cleanup) { report(cleanup); }
    report(error);
    return { flush: async () => undefined, close: async () => undefined, recordError: async () => undefined };
  }
}
export async function withLinuxFileLogging<T>(input: LinuxFileLoggingInput, run: () => Promise<T>): Promise<T> {
  if (process.platform !== "linux") return run();
  const logging = await install(input);
  try { return await run(); }
  catch (error) { await logging.recordError(error); throw error; }
  finally { await logging.close(); }
}
