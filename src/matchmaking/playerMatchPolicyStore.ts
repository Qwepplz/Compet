import type { DatabaseSync } from "node:sqlite";
import { withDatabaseTransaction } from "../storage/competDatabase.js";
import type { MatchPlayerPolicyContext } from "./types.js";

export interface PlayerMatchPolicyState {
  accountId: string;
  abnormalStreak: number;
  marked: boolean;
  markedAt: string | null;
  updatedAt: string | null;
}

export interface PlayerMatchPolicyOutcome {
  matchId: string;
  outcome: "completed" | "failed";
  occurredAt: string;
  dev: boolean;
  humanAccountIds: string[];
  context?: MatchPlayerPolicyContext;
}

export type PolicyOutcomeResult = "applied" | "duplicate" | "ignored";
export type PlayerMatchPolicyPort = Pick<PlayerMatchPolicyStore, "get" | "hasReceipt" | "setMarked" | "applyOutcome">;

export class PlayerMatchPolicyStore {
  constructor(private readonly database: DatabaseSync) {}

  get(accountId: string): PlayerMatchPolicyState {
    const row = this.database.prepare("SELECT * FROM player_match_policies WHERE account_id = ?").get(accountId);
    if (!row) return { accountId, abnormalStreak: 0, marked: false, markedAt: null, updatedAt: null };
    if (typeof row.abnormal_streak !== "number" || !Number.isInteger(row.abnormal_streak)
      || row.abnormal_streak < 0 || row.abnormal_streak > 2
      || (row.marked !== 0 && row.marked !== 1) || typeof row.updated_at !== "string"
      || (row.marked === 0 ? row.marked_at !== null : typeof row.marked_at !== "string")) {
      throw new Error("Invalid player match policy state");
    }
    return { accountId, abnormalStreak: row.abnormal_streak, marked: row.marked === 1,
      markedAt: row.marked_at as string | null, updatedAt: row.updated_at };
  }

  hasReceipt(matchId: string): boolean {
    return !!this.database.prepare("SELECT match_id FROM player_match_policy_receipts WHERE match_id = ?").get(matchId);
  }

  setMarked(accountId: string, marked: boolean, now: string): PlayerMatchPolicyState {
    return withDatabaseTransaction(this.database, () => {
      const account = this.database.prepare("SELECT role FROM accounts WHERE id = ?").get(accountId);
      if (account?.role !== "player") throw new Error("Player account not found");
      const state = this.get(accountId);
      if (state.marked === marked) return state;
      const next = { accountId, abnormalStreak: 0, marked, markedAt: marked ? now : null, updatedAt: now };
      this.save(next);
      return next;
    });
  }

  applyOutcome(input: PlayerMatchPolicyOutcome, now: string): PolicyOutcomeResult {
    if (input.dev || !input.context) return "ignored";
    const payload = normalizeOutcome(input);
    const payloadJson = JSON.stringify(payload);
    return withDatabaseTransaction(this.database, () => {
      const receipt = this.database.prepare(
        "SELECT payload_json FROM player_match_policy_receipts WHERE match_id = ?",
      ).get(input.matchId);
      if (receipt) {
        if (receipt.payload_json !== payloadJson) throw new Error("Conflicting player match policy receipt");
        return "duplicate";
      }
      const manual = new Set(payload.manualReadyAccountIds);
      for (const accountId of payload.humanAccountIds) {
        const account = this.database.prepare("SELECT role FROM accounts WHERE id = ?").get(accountId);
        if (account?.role !== "player") continue;
        const state = this.get(accountId);
        if (payload.outcome === "failed") {
          if (!manual.has(accountId)) continue;
          const abnormalStreak = Math.min(state.abnormalStreak + 1, 2);
          this.save({ accountId, abnormalStreak, marked: state.marked || abnormalStreak === 2,
            markedAt: state.markedAt ?? (abnormalStreak === 2 ? payload.occurredAt : null), updatedAt: now });
        } else if (manual.has(accountId) || (payload.forcedBalance && state.marked)) {
          this.save({ accountId, abnormalStreak: 0, marked: payload.forcedBalance ? false : state.marked,
            markedAt: payload.forcedBalance ? null : state.markedAt, updatedAt: now });
        }
      }
      this.database.prepare(
        "INSERT INTO player_match_policy_receipts (match_id, outcome, payload_json, applied_at) VALUES (?, ?, ?, ?)",
      ).run(payload.matchId, payload.outcome, payloadJson, now);
      return "applied";
    });
  }

  private save(state: PlayerMatchPolicyState): void {
    this.database.prepare(`
      INSERT INTO player_match_policies (account_id, abnormal_streak, marked, marked_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET abnormal_streak = excluded.abnormal_streak,
        marked = excluded.marked, marked_at = excluded.marked_at, updated_at = excluded.updated_at
    `).run(state.accountId, state.abnormalStreak, state.marked ? 1 : 0, state.markedAt, state.updatedAt);
  }
}

function normalizeOutcome(input: PlayerMatchPolicyOutcome) {
  const context = input.context!;
  const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  if (!nonEmpty(input.matchId) || !nonEmpty(input.occurredAt)
    || !["completed", "failed"].includes(input.outcome) || typeof context.forcedBalance !== "boolean"
    || !Array.isArray(input.humanAccountIds) || !input.humanAccountIds.every(nonEmpty)
    || !Array.isArray(context.manualReadyAccountIds) || !context.manualReadyAccountIds.every(nonEmpty)) {
    throw new Error("Invalid player match policy outcome");
  }
  const humanAccountIds = [...new Set(input.humanAccountIds)].sort();
  const manualReadyAccountIds = [...new Set(context.manualReadyAccountIds)].sort();
  if (manualReadyAccountIds.some((id) => !humanAccountIds.includes(id))) {
    throw new Error("Manual ready account is not a match participant");
  }
  return { matchId: input.matchId, outcome: input.outcome, occurredAt: input.occurredAt,
    dev: input.dev, forcedBalance: context.forcedBalance, humanAccountIds, manualReadyAccountIds };
}
