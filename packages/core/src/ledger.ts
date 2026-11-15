import { canonicalJson, sha256 } from "./hash.js";
import type { LedgerEntry, LedgerInput } from "./types.js";

/** Starting fingerprint of the chain. */
export const GENESIS_HASH = "0".repeat(64);

export function hashEntry(seq: number, prevHash: string, input: LedgerInput): string {
  return sha256(canonicalJson({ seq, prevHash, ...input }));
}

export function chainEntry(seq: number, prevHash: string, input: LedgerInput): LedgerEntry {
  return { ...input, seq, prevHash, hash: hashEntry(seq, prevHash, input) };
}

export type ChainCheck =
  | { valid: true; count: number; lastHash: string; lastVersion: 1 | 2 }
  | { valid: false; count: number; brokenAtSeq: number; problem: "hash_mismatch" | "link_mismatch" | "seq_gap" | "unsupported_format" | "invalid_format" | "invalid_approval_decision" | "approval_mismatch" };

/**
 * Approval state retained across the pages of a single verification run: the decisions (only the fields the
 * correlation needs) and the ids of the format-2 approval requests seen so far.
 */
export interface ApprovalDecisionState {
  decisions: Map<string, { verdict: string; agentId: string | null; requestHash: string | null }>;
  requests: Set<string>;
}
export const newApprovalState = (): ApprovalDecisionState => ({ decisions: new Map(), requests: new Set() });

/**
 * Verifies the integrity of a sequence of consecutive rows.
 * `startPrevHash` and `startVersion` carry the preceding verified page state.
 * `approvals` must be shared across pages and fresh for each independent run.
 * Independent ranges default to version 1; empty ranges preserve the start state.
 */
export function verifyChain(
  entries: LedgerEntry[],
  startPrevHash: string = GENESIS_HASH,
  startVersion: 1 | 2 = 1,
  approvals: ApprovalDecisionState = newApprovalState(),
): ChainCheck {
  let prev = startPrevHash;
  let expectedSeq = entries[0]?.seq ?? 1;
  let lastVersion = startVersion;
  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, problem: "seq_gap" };
    }
    if (entry.prevHash !== prev) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, problem: "link_mismatch" };
    }
    if (entry.formatVersion !== undefined && entry.formatVersion !== 2) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, problem: "unsupported_format" };
    }
    const { seq, prevHash, hash, ...input } = entry;
    if (hashEntry(seq, prevHash, input) !== hash) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, problem: "hash_mismatch" };
    }
    const v2 = entry.formatVersion === 2;
    const fields = ["policyRev", "operatorId", "approvalRef"] as const;
    if ((!v2 && (lastVersion === 2 || fields.some((key) => entry[key] !== undefined))) ||
        (v2 && (fields.some((key) => entry[key] !== undefined &&
          (typeof entry[key] !== "string" || entry[key]!.length === 0)) ||
          (entry.policyRev !== undefined && !/^[0-9a-f]{64}$/.test(entry.policyRev)) ||
          (entry.degraded !== undefined && entry.degraded !== true)))) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, problem: "invalid_format" };
    }
    if (v2) {
      // Keep these rules aligned with the independent export verifier.
      const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
      const hex = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
      if (entry.action === "mcp.approval.requested" && nonempty(entry.approvalRef)) approvals.requests.add(entry.approvalRef);
      if (entry.action === "mcp.approval.decided") {
        // Legacy exception (see docs/ledger-format.md): an approval migrated from 0.3.0 has no format-2 request row
        // and no policy revision; its decision may omit `policyRev`. Nothing is invented or backfilled.
        const legacyRevision = !Object.hasOwn(entry, "policyRev") && !approvals.requests.has(entry.approvalRef!);
        if (!nonempty(entry.approvalRef) || (!hex(entry.policyRev) && !legacyRevision) || !hex(entry.requestHash) ||
            (entry.reason === "expired" ? entry.verdict !== "denied" || Object.hasOwn(entry, "operatorId") : !nonempty(entry.operatorId))) {
          return { valid: false, count: entries.length, brokenAtSeq: entry.seq, problem: "invalid_approval_decision" };
        }
        approvals.decisions.set(entry.approvalRef, { verdict: entry.verdict, agentId: entry.agentId, requestHash: entry.requestHash });
      }
      if (entry.action === "mcp.tools/call" && Object.hasOwn(entry, "approvalRef")) {
        const decision = approvals.decisions.get(entry.approvalRef!);
        if (!decision || decision.verdict !== "allowed" || decision.agentId !== entry.agentId || decision.requestHash !== entry.requestHash) {
          return { valid: false, count: entries.length, brokenAtSeq: entry.seq, problem: "approval_mismatch" };
        }
      }
    }
    lastVersion = v2 ? 2 : 1;
    prev = hash;
    expectedSeq += 1;
  }
  return { valid: true, count: entries.length, lastHash: prev, lastVersion };
}
