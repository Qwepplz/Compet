import { access, constants } from "node:fs/promises";
import path from "node:path";
import type { DiagnosticResult } from "../shared/types.js";

export interface LocalDiagnosticInput {
  serverRoot?: string;
  recordsDir?: string;
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function writable(dir: string): Promise<boolean> {
  try { await access(dir, constants.W_OK); return true; } catch { return false; }
}

function result(id: string, label: string, status: DiagnosticResult["status"], summary: string, detail?: string): DiagnosticResult {
  return { id, label, status, summary, detail };
}

function pathResult(id: string, label: string, filePath: string, missingStatus: DiagnosticResult["status"] = "fail"): Promise<DiagnosticResult> {
  return exists(filePath).then((ok) => result(id, label, ok ? "pass" : missingStatus, filePath));
}
export async function runLocalDiagnostics(input: LocalDiagnosticInput): Promise<DiagnosticResult[]> {
  const root = input.serverRoot;
  const checks: DiagnosticResult[] = [];
  if (!root) {
    checks.push(result("server-root", "CSGO server 根目录", "unavailable", "未配置本机路径"));
    checks.push(result("srcds", "srcds.exe", "unavailable", "未配置本机路径"));
    checks.push(result("csgo-dir", "csgo 目录", "unavailable", "未配置本机路径"));
    checks.push(result("map-bats", "地图启动 bat", "unavailable", "未配置本机路径"));
  } else {
    checks.push(await pathResult("server-root", "CSGO server 根目录", root));
    checks.push(await pathResult("srcds", "srcds.exe", path.join(root, "srcds.exe")));
    checks.push(await pathResult("csgo-dir", "csgo 目录", path.join(root, "csgo")));
    checks.push(await pathResult("map-bats", "地图启动 bat", path.join(root, "de_mirage.bat"), "warn"));
  }

  if (input.recordsDir) {
    checks.push(result("records-writable", "records 目录可写", await writable(input.recordsDir) ? "pass" : "warn", input.recordsDir));
  } else {
    checks.push(result("records-writable", "records 目录可写", "unavailable", "未配置 records 目录"));
  }
  return checks;
}
