import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const GUIDELINES_KEY = "FollowCSGOServerGuidelines";

type Token =
  | { kind: "string"; value: string; valueStart: number; valueEnd: number }
  | { kind: "open" | "close" };

export async function prepareSourceModForServerStartup(serverRoot: string): Promise<void> {
  if (!serverRoot.trim()) throw new Error("SourceMod serverRoot must not be blank");

  const sourceMod = path.join(serverRoot, "csgo", "addons", "sourcemod");
  const corePath = path.join(sourceMod, "configs", "core.cfg");
  const pluginDir = path.join(sourceMod, "plugins");
  await prepareCoreConfig(corePath);
  await disableNextmap(pluginDir);
}

async function prepareCoreConfig(corePath: string): Promise<void> {
  let original: Buffer;
  try {
    original = await fs.readFile(corePath);
  } catch (error) {
    throw operationError("read SourceMod core.cfg", corePath, error);
  }

  let updated: Buffer | undefined;
  try {
    updated = updatedCoreConfig(original);
  } catch (error) {
    throw operationError("inspect SourceMod core.cfg", corePath, error);
  }
  if (!updated) return;

  const temporary = corePath + "." + randomUUID() + ".tmp";
  let handle: FileHandle | undefined;
  let writeError: unknown;
  try {
    handle = await fs.open(temporary, "wx");
    await handle.writeFile(updated);
  } catch (error) {
    writeError = error;
  }
  try {
    await handle?.close();
  } catch (error) {
    writeError ??= error;
  }
  if (writeError) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw operationError("write temporary SourceMod core.cfg", temporary, writeError);
  }

  try {
    await fs.rename(temporary, corePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw operationError("replace SourceMod core.cfg", corePath, error);
  }
}

function updatedCoreConfig(original: Buffer): Buffer | undefined {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original);
  const tokens = scanKeyValues(text);
  let index = 0;
  let coreBlocks = 0;
  const guidelines: Extract<Token, { kind: "string" }>[] = [];

  function parseScope(depth: number, directCore: boolean): void {
    while (index < tokens.length) {
      const key = tokens[index++]!;
      if (key.kind === "close") {
        if (depth === 0) throw new Error("Unexpected closing brace");
        return;
      }
      if (key.kind !== "string") throw new Error("Expected a configuration key");
      const value = tokens[index++];
      if (!value || value.kind === "close") throw new Error("Missing value for " + key.value);

      if (depth === 0 && key.value === "Core") {
        if (value.kind !== "open") throw new Error("Core must be a block");
        coreBlocks++;
      }
      if (depth === 1 && directCore && key.value === GUIDELINES_KEY) {
        if (value.kind !== "string") throw new Error(GUIDELINES_KEY + " must be a string");
        guidelines.push(value);
      }
      if (value.kind === "open") {
        parseScope(depth + 1, depth === 0 && key.value === "Core");
      }
    }
    if (depth !== 0) throw new Error("Unclosed configuration block");
  }

  parseScope(0, false);
  if (coreBlocks !== 1) throw new Error("Expected exactly one Core block");
  if (guidelines.length !== 1) throw new Error("Expected exactly one direct " + GUIDELINES_KEY + " key");
  const token = guidelines[0]!;
  const rawValue = text.slice(token.valueStart, token.valueEnd);
  if (rawValue === "no") return undefined;
  if (rawValue !== "yes") throw new Error(GUIDELINES_KEY + " must be yes or no");

  const start = Buffer.byteLength(text.slice(0, token.valueStart), "utf8");
  const end = Buffer.byteLength(text.slice(0, token.valueEnd), "utf8");
  return Buffer.concat([original.subarray(0, start), Buffer.from("no"), original.subarray(end)]);
}

function scanKeyValues(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unclosed block comment");
      index = end + 2;
      continue;
    }
    if (char === "{" || char === "}") {
      tokens.push({ kind: char === "{" ? "open" : "close" });
      index++;
      continue;
    }
    if (char === '"') {
      const start = index++;
      let value = "";
      let closed = false;
      while (index < text.length) {
        const next = text[index++]!;
        if (next === '"') {
          closed = true;
          break;
        }
        if (next === "\\") {
          if (index >= text.length) throw new Error("Unclosed quoted string");
          value += text[index++]!;
        } else {
          value += next;
        }
      }
      if (!closed) throw new Error("Unclosed quoted string");
      tokens.push({ kind: "string", value, valueStart: start + 1, valueEnd: index - 1 });
      continue;
    }

    const start = index;
    while (index < text.length && !/\s|[{}"]/.test(text[index]!)
      && !(text[index] === "/" && (text[index + 1] === "/" || text[index + 1] === "*"))) {
      index++;
    }
    if (index === start) throw new Error("Unexpected configuration character");
    tokens.push({ kind: "string", value: text.slice(start, index), valueStart: start, valueEnd: index });
  }
  return tokens;
}

async function disableNextmap(pluginDir: string): Promise<void> {
  const source = path.join(pluginDir, "nextmap.smx");
  const disabled = path.join(pluginDir, "disabled");
  const target = path.join(disabled, "nextmap.smx");
  let sourceInfo;
  try {
    sourceInfo = await fs.lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw operationError("inspect SourceMod plugin", source, error);
  }
  if (!sourceInfo.isFile()) throw operationError("inspect SourceMod plugin", source, "Not a regular file");

  try {
    await fs.mkdir(disabled, { recursive: true });
  } catch (error) {
    throw operationError("create SourceMod disabled directory", disabled, error);
  }
  try {
    const targetInfo = await fs.lstat(target);
    if (!targetInfo.isFile()) throw new Error("Not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw operationError("inspect SourceMod disabled plugin", target, error);
    }
  }

  try {
    await fs.copyFile(source, target);
  } catch (error) {
    throw operationError("copy SourceMod plugin", target, error);
  }
  try {
    await fs.unlink(source);
  } catch (error) {
    throw operationError("remove active SourceMod plugin", source, error);
  }
}

function operationError(operation: string, target: string, cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return new Error("Failed to " + operation + " at " + target + ": " + (code ? code + ": " : "") + reason, { cause });
}
