import type { ServerPlatform } from "../shared/serverPackageLayout.js";
import type { FileFingerprint } from "../desktop/main/serverManagedFiles.js";
import type { LifecycleSnapshot } from "./serverLifecycle.js";

export type ServerUpdateAction = "check" | "apply" | "repair" | "recover";
export interface ServerUpdateResult {
  status: "no_changes" | "handed_off" | "completed" | "blocked" | "failed";
  transactionId?: string;
  code?: string;
  receiptPath?: string;
  currentVersion?: string;
  targetVersion?: string;
  updateAvailable?: boolean;
  changedFiles?: number;
  changedBytes?: number;
}
export interface ServerPackageFile extends FileFingerprint { path: string; mode?: number }
export interface ServerPackageInventory {
  schemaVersion: 1;
  appId: "compet-server-manager";
  version: string;
  platform: ServerPlatform;
  files: ServerPackageFile[];
}
export interface ServerBeforeImage extends FileFingerprint { mode?: number; uid?: number; gid?: number }
export interface ServerBaselineFile extends ServerBeforeImage { path: string }
export type ServerOperation =
  | ({ kind: "replace"; path: string; beforeExists: boolean; before?: ServerBeforeImage; source: string; mode?: number } & FileFingerprint)
  | { kind: "delete"; path: string; beforeExists: true; before: ServerBeforeImage };
export interface ServerPlanV5 {
  protocol: 5;
  transactionId: string;
  platform: ServerPlatform;
  root: string;
  exe: string;
  targetVersion: string;
  configurationFingerprint: FileFingerprint & { path: string; effectiveSha256: string; kind?: "windows-manager"; requiredClientVersion?: string };
  protectedPaths: string[];
  expectedFiles: ServerPackageFile[];
  baselineFiles: ServerBaselineFile[];
  operations: ServerOperation[];
  runner: { directory: string; node: string; entry: string; files: ServerPackageFile[] };
  lifecycle: LifecycleSnapshot;
}
export interface ServerJournalEntry {
  index: number;
  target: string;
  beforeExists: boolean;
  before?: ServerBeforeImage;
  after?: FileFingerprint & { mode?: number };
  backup?: string;
  temporary: string;
}
export interface ServerJournalV5 { protocol: 5; transactionId: string; count: number; entries: ServerJournalEntry[] }
export type ServerTransactionState = "prepared" | "applying" | "applied" | "verified" | "rolled_back" | "recovery_failed";
export interface ServerResultV5 {
  protocol: 5;
  transactionId: string;
  platform: ServerPlatform;
  root: string;
  exe: string;
  targetVersion: string;
  state: ServerTransactionState;
  code?: string;
  recoveryPhase?: "prepared" | "applying" | "applied";
}

export function updateFailure(code: string): never { throw Object.assign(new Error(code), { code }); }
export function strictObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) updateFailure("update_schema_invalid");
  return value as Record<string, unknown>;
}
export function assertFingerprint(value: Record<string, unknown>): void {
  if (!Number.isSafeInteger(value.size) || Number(value.size) < 0 || typeof value.sha256 !== "string" ||
      !/^[A-Fa-f0-9]{64}$/.test(value.sha256)) updateFailure("update_fingerprint_invalid");
}
