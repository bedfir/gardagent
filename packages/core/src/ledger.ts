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
  | { valid: true; count: number; lastHash: string }
  | { valid: false; count: number; brokenAtSeq: number; problem: "hash_mismatch" | "link_mismatch" | "seq_gap" };

/**
 * Verifies the integrity of a sequence of consecutive rows.
 * `startPrevHash` lets you verify a portion of the ledger from a known point.
 */
export function verifyChain(entries: LedgerEntry[], startPrevHash: string = GENESIS_HASH): ChainCheck {
  let prev = startPrevHash;
  let expectedSeq = entries[0]?.seq ?? 1;
  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, problem: "seq_gap" };
    }
    if (entry.prevHash !== prev) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, problem: "link_mismatch" };
    }
    const { seq, prevHash, hash, ...input } = entry;
    if (hashEntry(seq, prevHash, input) !== hash) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, problem: "hash_mismatch" };
    }
    prev = hash;
    expectedSeq += 1;
  }
  return { valid: true, count: entries.length, lastHash: prev };
}
