import fs from "node:fs/promises";
import path from "node:path";

export interface GameProcessIdentity {
  pid: number;
  startTimeTicks: string;
  executable: string;
  serverRoot: string;
  processGroupId: number;
}

function parseStat(text: string) {
  const fields = text.slice(text.lastIndexOf(") ") + 2).trim().split(/\s+/);
  if (!/^[0-9]+$/.test(fields[19] ?? "") || !Number.isSafeInteger(Number(fields[2]))) {
    throw new Error("linux_process_stat_invalid");
  }
  return { command: text.slice(text.indexOf("(") + 1, text.lastIndexOf(") ")), state: fields[0], parentPid: Number(fields[1]), processGroupId: Number(fields[2]), startTimeTicks: fields[19]! };
}

export { parseStat as parseLinuxProcessStat };

export async function readLinuxProcessIdentity(pid: number, serverRoot: string): Promise<GameProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("linux_process_pid_invalid");
  const directory = "/proc/" + pid;
  const before = parseStat(await fs.readFile(directory + "/stat", "utf8"));
  const executable = await fs.readlink(directory + "/exe");
  const after = parseStat(await fs.readFile(directory + "/stat", "utf8"));
  if (before.startTimeTicks !== after.startTimeTicks) throw new Error("linux_process_changed");
  return { pid, executable, startTimeTicks: after.startTimeTicks, processGroupId: after.processGroupId,
    serverRoot: await fs.realpath(serverRoot) };
}

export async function probeLinuxGameProcess(identity: GameProcessIdentity): Promise<"alive" | "gone" | "unknown"> {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || typeof identity.startTimeTicks !== "string" || !/^[0-9]+$/.test(identity.startTimeTicks) ||
      typeof identity.executable !== "string" || typeof identity.serverRoot !== "string" ||
      !path.posix.isAbsolute(identity.executable) || !path.posix.isAbsolute(identity.serverRoot)) return "unknown";
  try {
    const stat = parseStat(await fs.readFile("/proc/" + identity.pid + "/stat", "utf8"));
    if (stat.startTimeTicks !== identity.startTimeTicks || stat.state === "Z" || stat.state === "X") return "gone";
    const executable = await fs.readlink("/proc/" + identity.pid + "/exe");
    const cwd = await fs.readlink("/proc/" + identity.pid + "/cwd");
    if (executable !== identity.executable || cwd !== identity.serverRoot || stat.processGroupId !== identity.processGroupId) return "unknown";
    const checked = parseStat(await fs.readFile("/proc/" + identity.pid + "/stat", "utf8"));
    return checked.startTimeTicks === identity.startTimeTicks ? "alive" : "gone";
  } catch (error) {
    return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "") ? "gone" : "unknown";
  }
}

export async function inspectLinuxUdpPort(port: number): Promise<"bound" | "free" | "unknown"> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "unknown";
  try {
    for (const table of ["udp", "udp6"]) {
      const text = await fs.readFile("/proc/net/" + table, "utf8");
      for (const line of text.trim().split("\n").slice(1)) {
        const address = line.trim().split(/\s+/)[1];
        if (!address || !address.includes(":")) return "unknown";
        if (Number.parseInt(address.split(":")[1]!, 16) === port) return "bound";
      }
    }
    return "free";
  } catch { return "unknown"; }
}

export async function inspectLinuxProcessUdpPort(identity: GameProcessIdentity, port: number): Promise<"owned" | "not_owned" | "unknown"> {
  if (await probeLinuxGameProcess(identity) !== "alive") return "unknown";
  try {
    const inodes = new Set<string>();
    for (const table of ["udp", "udp6"]) {
      for (const line of (await fs.readFile("/proc/net/" + table, "utf8")).trim().split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (Number.parseInt(fields[1]?.split(":")[1] ?? "", 16) === port && fields[9]) inodes.add(fields[9]);
      }
    }
    for (const fd of await fs.readdir("/proc/" + identity.pid + "/fd")) {
      let value;
      try { value = await fs.readlink("/proc/" + identity.pid + "/fd/" + fd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const inode = /^socket:\[(\d+)\]$/.exec(value)?.[1];
      if (inode && inodes.has(inode)) return await probeLinuxGameProcess(identity) === "alive" ? "owned" : "unknown";
    }
    return "not_owned";
  } catch { return "unknown"; }
}

export async function findLinuxGameProcess(wrapperPid: number, serverRoot: string): Promise<GameProcessIdentity | undefined> {
  const root = await fs.realpath(serverRoot);
  const processes: { pid: number; parentPid: number }[] = [];
  for (const name of await fs.readdir("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const stat = parseStat(await fs.readFile("/proc/" + name + "/stat", "utf8"));
      if (stat.state !== "Z" && stat.state !== "X") processes.push({ pid: Number(name), parentPid: stat.parentPid });
    } catch { /* A disappearing process cannot establish ownership. */ }
  }
  const descendants = new Set([wrapperPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) if (descendants.has(entry.parentPid) && !descendants.has(entry.pid)) {
      descendants.add(entry.pid); changed = true;
    }
  }
  const candidates: GameProcessIdentity[] = [];
  for (const pid of descendants) {
    try {
      const identity = await readLinuxProcessIdentity(pid, root);
      if (identity.executable === path.join(root, "srcds_linux") && await probeLinuxGameProcess(identity) === "alive") candidates.push(identity);
    } catch { /* Only a complete identity can be adopted. */ }
  }
  if (candidates.length > 1) throw new Error("game_process_ambiguous");
  return candidates[0];
}

export async function inspectLinuxGameRoot(serverRoot: string): Promise<"alive" | "gone" | "unknown"> {
  let unknown = false;
  try {
    const root = await fs.realpath(serverRoot);
    for (const name of await fs.readdir("/proc")) {
      if (!/^[0-9]+$/.test(name)) continue;
      const directory = "/proc/" + name;
      const [status, stat] = await Promise.allSettled([
        fs.readFile(directory + "/status", "utf8"),
        fs.readFile(directory + "/stat", "utf8").then(parseStat),
      ]);
      const uid = status.status === "fulfilled" ? /^Uid:\s+(\d+)/m.exec(status.value)?.[1] : undefined;
      if (uid !== undefined && process.getuid?.() !== 0 && Number(uid) !== process.getuid?.()) continue;
      if (stat.status === "fulfilled" && (stat.value.state === "Z" || stat.value.state === "X")) continue;
      const commands = [
        status.status === "fulfilled" ? /^Name:[ \t]*([^\r\n]*)$/m.exec(status.value)?.[1]?.trim() : undefined,
        stat.status === "fulfilled" ? stat.value.command : undefined,
      ].filter((value): value is string => value !== undefined && value.length > 0);
      let associated = commands.length === 0 || commands.includes("srcds_linux");
      try {
        // A readable executable establishes whether this is the target game, even if its name changed.
        if (await fs.readlink(directory + "/exe") === path.join(root, "srcds_linux")) return "alive";
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        // Independent metadata or cwd evidence can still identify an unreadable game candidate.
        try { if (await fs.readlink(directory + "/cwd") === root) associated = true; } catch { /* No cwd evidence. */ }
        if (associated) unknown = true;
      }
    }
  } catch { return "unknown"; }
  return unknown ? "unknown" : "gone";
}
