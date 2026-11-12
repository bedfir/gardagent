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
  | { valid: false; count: number; brokenAtSeq: number; problem: "hash_mismatch" | "link_mismatch" | "seq_gap" | "unsupported_format" | "invalid_format" };

/**
 * Verifies the integrity of a sequence of consecutive rows.
 * `startPrevHash` and `startVersion` carry the preceding verified page state.
 * Independent ranges default to version 1; empty ranges preserve the start state.
 */
export function verifyChain(
  entries: LedgerEntry[],
  startPrevHash: string = GENESIS_HASH,
  startVersion: 1 | 2 = 1,
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
    lastVersion = v2 ? 2 : 1;
    prev = hash;
    expectedSeq += 1;
  }
  return { valid: true, count: entries.length, lastHash: prev, lastVersion };
}
