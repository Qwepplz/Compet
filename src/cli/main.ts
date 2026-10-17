import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { assertServerConfigPaths } from "../config/config.js";
import { resolveServerLayout } from "../shared/serverPackageLayout.js";
import { requestJson } from "../shared/httpJsonClient.js";
import { isSemver } from "../shared/version.js";
import { loadHeadlessConfig } from "./config.js";
import { inspectServerEnvironment } from "./doctor.js";
import { CliAdminClient, CliError } from "./adminClient.js";
import { executeCliCommand, serverBaseUrl, type CliServices } from "./commands.js";
import { runServer } from "../server/runServer.js";
import { matchHistoryMatchIdSchema } from "../records/matchHistory.js";
import { executeServerUpdate, readServerUpdateStatus } from "../update/serverUpdate.js";
import { SystemdLifecycle } from "../update/systemdLifecycle.js";
import { WindowsManagerLifecycle } from "../update/windowsLifecycle.js";

export interface CliIo {
  stdin: Readable;
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
  isInteractive: boolean;
  readPassword(): Promise<string>;
}

const commands = ["run", "status", "config check", "doctor", "game status", "matches list", "matches show",
  "queue status", "maintenance status", "maintenance enter", "maintenance leave",
  "update check", "update apply", "update repair", "update recover", "update status"] as const;
const help = "compet <command> [--config <absolute-path>] [--json] [--username <name>] [--password-stdin]";

function defaultServices(): CliServices {
  const entry = process.argv[1];
  if (!entry || !path.isAbsolute(entry) || path.basename(entry) !== "cli.cjs") throw new CliError("cli_package_required");
  const platform = process.platform + "-" + process.arch;
  if (platform !== "linux-x64" && platform !== "win32-x64") throw new CliError("server_platform_unsupported");
  const appRoot = path.dirname(path.dirname(entry));
  const layout = resolveServerLayout({ platform, installRoot: platform === "win32-x64" ? path.resolve(appRoot, "../../../..") : appRoot });
  return {
    layout, env: process.env,
    loadConfig: (configPath, env) => loadHeadlessConfig({ configPath, env }),
    inspectEnvironment: inspectServerEnvironment,
    runServer,
    health: url => requestJson({ baseUrl: url, route: "/health", method: "GET", timeoutMs: 3_000 }),
    readVersion: async () => {
      const identity = JSON.parse((await fs.readFile(path.join(layout.appRoot, "package.json"), "utf8")).replace(/^\uFEFF/, "")) as { name?: unknown; version?: unknown };
      if (identity.name !== "compet-server-manager" || typeof identity.version !== "string" || !isSemver(identity.version)) throw new CliError("package_identity_invalid");
      return identity.version;
    },
    createAdminClient: url => new CliAdminClient(url),
    executeUpdate: input => executeServerUpdate({ ...input, lifecycle: input.layout.platform === "linux-x64"
      ? new SystemdLifecycle(input) : new WindowsManagerLifecycle(input) }),
    readUpdateStatus: readServerUpdateStatus,
  };
}

export async function readPasswordFromStdin(input: Readable): Promise<string> {
  let text = "";
  for await (const chunk of input) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 4096) throw new CliError("password_input_invalid", 401);
    if (text.includes("\n")) break;
  }
  const password = text.split("\n")[0]!.replace(/\r$/, "");
  if (!password || password.includes("\0")) throw new CliError("password_input_invalid", 401);
  return password;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code)) return code;
  if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"].includes(String(code))) return "connection_failed";
  return "operation_failed";
}

function exitCode(code: string, error: unknown): number {
  const status = (error as { statusCode?: number } | undefined)?.statusCode;
  if (["update_recovery_required", "update_transaction_pending", "update_recovery_pending"].includes(code)) return 5;
  if (status === 401 || status === 403 || /^(authentication_|password_input_|password_change_)/.test(code)) return 4;
  if (status === 409 || ["maintenance_in_progress", "maintenance_matchmaking_busy", "maintenance_update_in_progress", "update_busy"].includes(code)) return 3;
  if (code === "argument_invalid" || /^(config_|server_path_|server_roots_|server_platform_)/.test(code)) return 2;
  return 1;
}

export async function main(argv: string[], io: CliIo, providedServices?: CliServices): Promise<number> {
  let command = "unknown";
  let json = argv.includes("--json");
  const output = (envelope: { ok: boolean; command: string; data?: unknown; error?: { code: string; message: string } }) => {
    io.stdout.write(json ? JSON.stringify(envelope) + "\n" :
      envelope.error ? envelope.error.code + "\n" : JSON.stringify(envelope.data, null, 2) + "\n");
  };
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
        config: { type: "string" }, json: { type: "boolean" }, username: { type: "string" },
        "password-stdin": { type: "boolean" }, help: { type: "boolean", short: "h" },
      } });
    } catch { throw new CliError("argument_invalid"); }
    json = parsed.values.json ?? false;
    if (parsed.values.help) {
      output({ ok: true, command: "help", data: { usage: help, commands,
        configDefault: process.platform === "linux" ? "/etc/compet/server.json" : "Explicit --config required" } });
      return 0;
    }
    const positional = parsed.positionals;
    const candidate = positional[0] === "run" || positional[0] === "status" || positional[0] === "doctor"
      ? positional[0] : positional.slice(0, 2).join(" ");
    if (!(commands as readonly string[]).includes(candidate ?? "")) throw new CliError("argument_invalid");
    const expectedLength = candidate === "matches show" ? 3 : candidate!.includes(" ") ? 2 : 1;
    if (positional.length !== expectedLength) throw new CliError("argument_invalid");
    const id = candidate === "matches show" ? matchHistoryMatchIdSchema.safeParse(positional[2]) : undefined;
    if (id && !id.success) throw new CliError("argument_invalid");
    command = candidate!;
    const configPath = parsed.values.config ?? (process.platform === "linux" ? "/etc/compet/server.json" : undefined);
    if (!configPath) throw new CliError("config_path_required");
    if (!path.isAbsolute(configPath)) throw new CliError("config_path_invalid");
    const services = providedServices ?? defaultServices();
    const config = await services.loadConfig(configPath, services.env);
    assertServerConfigPaths(config, services.layout);
    let password: string | undefined;
    const withAdmin = async <T>(operation: (api: CliAdminClient) => Promise<T>): Promise<T> => {
      const username = parsed.values.username;
      if (!username) throw new CliError("authentication_required", 401);
      if (password === undefined) {
        if (parsed.values["password-stdin"]) password = await readPasswordFromStdin(io.stdin);
        else if (io.isInteractive) password = await io.readPassword();
        else throw new CliError("password_input_required", 401);
        if (!password) throw new CliError("password_input_invalid", 401);
      }
      return services.createAdminClient(serverBaseUrl(config)).withSession(username, password, operation);
    };
    const result = await executeCliCommand({ command, ...(id?.success ? { id: id.data } : {}), configPath, config, services, withAdmin,
      run: async () => {
        const originalWrite = process.stdout.write;
        if (json) process.stdout.write = io.stderr.write.bind(io.stderr) as typeof process.stdout.write;
        try { await services.runServer(config, services.layout); }
        finally { process.stdout.write = originalWrite; }
      } });
    password = undefined;
    output({ ...result, command });
    return result.ok ? 0 : 1;
  } catch (error) {
    const code = errorCode(error);
    output({ ok: false, command, error: { code, message: code } });
    return exitCode(code, error);
  }
}

async function readTerminalPassword(): Promise<string> {
  if (!process.stdin.isTTY) throw new CliError("password_input_required", 401);
  const input = process.stdin;
  const previousRaw = input.isRaw;
  process.stderr.write("Password: ");
  input.setRawMode(true); input.resume(); input.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let password = "";
    const finish = (error?: Error) => {
      input.off("data", onData); input.setRawMode(previousRaw); input.pause();
      process.stderr.write("\n");
      if (error) reject(error); else resolve(password);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u0003" || character === "\u0004") { finish(new CliError("password_input_cancelled", 401)); return; }
        if (character === "\u007f" || character === "\b") password = [...password].slice(0, -1).join("");
        else password += character;
        if (Buffer.byteLength(password) > 4096) { finish(new CliError("password_input_invalid", 401)); return; }
      }
    };
    input.on("data", onData);
  });
}

const entry = process.argv[1]?.replace(/\\/g, "/");
if (entry?.endsWith("/dist/cli.cjs") || entry?.endsWith("/src/cli/main.ts")) {
  const io: CliIo = { stdin: process.stdin, stdout: { write: process.stdout.write.bind(process.stdout) },
    stderr: { write: process.stderr.write.bind(process.stderr) }, isInteractive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    readPassword: readTerminalPassword };
  void main(process.argv.slice(2), io).then(code => { process.exitCode = code; });
}
