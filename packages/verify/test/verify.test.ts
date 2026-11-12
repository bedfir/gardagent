import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chainEntry, GENESIS_HASH, type LedgerEntry, type LedgerInput } from "../../core/src/index.js";
import { verifyExport } from "../src/index.js";
import { run } from "../src/command.js";

const golden = JSON.parse(readFileSync(new URL("../../../test/fixtures/contracts/ledger-v1.json", import.meta.url), "utf8")) as { entries: LedgerEntry[] };
const cp = (entries: LedgerEntry[]) => ({ format: "gardagent-checkpoint-v1", sequence: entries.at(-1)?.seq ?? 0,
  head_hash: entries.at(-1)?.hash ?? GENESIS_HASH, created_at: "2026-11-12T00:00:00.000Z" });
const page = (entries: LedgerEntry[], captured = cp(entries), cursor: number | null = null) =>
  [JSON.stringify({ type: "metadata", checkpoint: captured, nextAfterSeq: cursor }), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n";
function chain(versions: (1 | 2)[]) {
  let prev = GENESIS_HASH;
  return versions.map((v, i) => {
    const { seq: _seq, prevHash: _prev, hash: _hash, ...input } = golden.entries[0]!;
    const e = chainEntry(i + 1, prev, { ...input, ...(v === 2 ? { formatVersion: 2 as const } : {}) });
    prev = e.hash;
    return e;
  });
}
function rehash(entries: LedgerEntry[]) {
  let prev = GENESIS_HASH;
  return entries.map(({ seq, prevHash: _prev, hash: _hash, ...input }) => {
    const e = chainEntry(seq, prev, input); prev = e.hash; return e;
  });
}

describe("independent export verifier", () => {
  it("verifies the unmodified M02 golden fixture and an empty export", () => {
    expect(verifyExport(page(golden.entries), [cp(golden.entries)]).valid).toBe(true);
    expect(verifyExport(page([]), [cp([])]).valid).toBe(true);
  });
  it("verifies version 1, version 2 and mixed chains", () => {
    for (const versions of [[1, 1, 1], [2, 2, 2], [1, 2, 2]] as (1 | 2)[][]) {
      expect(verifyExport(page(chain(versions))).valid).toBe(true);
    }
  });
  it("preserves absent fields and ECMAScript string escaping", () => {
    const entries = chain([1, 2]);
    const special = rehash(entries.map((e) => ({ ...e, action: 'event.é.😀.\\.\".\n.\ud800', degraded: true as const })));
    expect(verifyExport(page(special)).valid).toBe(true);
    const defaulted = entries.map((e) => ({ ...e, degraded: false }));
    expect(verifyExport(page(defaulted as LedgerEntry[])).firstInvalid?.reason).toBe("hash_mismatch");
    expect(verifyExport(page(rehash(defaulted as LedgerEntry[]))).firstInvalid?.reason).toBe("invalid_format");
  });
  it("checks an altered entry and a missing middle entry at the first failure", () => {
    const entries = chain([1, 2, 2]);
    const altered = entries.map((e) => ({ ...e }));
    altered[1]!.cost++;
    expect(verifyExport(page(altered)).firstInvalid).toEqual({ sequence: 2, reason: "hash_mismatch" });
    expect(verifyExport(page([entries[0]!, entries[2]!])).firstInvalid).toEqual({ sequence: 3, reason: "seq_gap" });
    const linked = entries.map((e) => ({ ...e })); linked[1]!.prevHash = GENESIS_HASH;
    expect(verifyExport(page(linked)).firstInvalid?.reason).toBe("link_mismatch");
  });
  it("distinguishes incomplete downloads from self-consistent suffix removal", () => {
    const entries = chain([1, 2, 2]);
    const prefix = entries.slice(0, 2);
    expect(verifyExport(page(prefix, cp(entries))).valid).toBe(false);
    const unanchored = verifyExport(page(prefix));
    expect(unanchored.valid).toBe(true);
    expect(unanchored.limitation).toContain("suffix truncation");
    const anchored = verifyExport(page(prefix), [cp(entries), cp(prefix)]);
    expect(anchored.valid).toBe(false);
    expect(anchored.checkpoints.map((c) => c.contained)).toEqual([false, true]);
    const rewritten = rehash(entries.map((e) => ({ ...e, cost: 42 })));
    expect(verifyExport(page(rewritten), [cp(entries)]).valid).toBe(false);
  });
  it("requires complete consistent concatenated pages and retains version state", () => {
    const entries = chain([1, 2, 2]);
    const captured = cp(entries);
    const first = page(entries.slice(0, 2), captured, 2);
    expect(verifyExport(first + page(entries.slice(2), captured)).valid).toBe(true);
    expect(verifyExport(first).valid).toBe(false);
    expect(verifyExport(page(entries.slice(2), captured)).firstInvalid?.reason).toBe("seq_gap");
    expect(verifyExport(first + page(entries.slice(2), { ...captured, head_hash: GENESIS_HASH })).firstInvalid?.reason).toBe("inconsistent_captured_head");
    const regression = chain([2, 1]);
    expect(verifyExport(page(regression.slice(0, 1), cp(regression), 1) + page(regression.slice(1), cp(regression))).firstInvalid?.reason).toBe("invalid_format");
  });
  it("fails closed for unknown versions, fields, malformed content and checkpoints", () => {
    const entries = chain([2]);
    const change = (extra: Record<string, unknown>) => rehash([{ ...entries[0]!, ...extra } as LedgerEntry]);
    expect(verifyExport(page(change({ formatVersion: 3 }))).firstInvalid?.reason).toBe("unsupported_format");
    for (const extra of [{ degraded: false }, { unexpected: true }, { policyRev: "bad" }, { cost: 0.5 }, { operatorId: null }]) {
      expect(verifyExport(page(change(extra))).firstInvalid?.reason).toBe("invalid_format");
    }
    expect(verifyExport("{bad").valid).toBe(false);
    expect(verifyExport("null").valid).toBe(false);
    expect(verifyExport(page(entries), [null]).checkpoints[0]?.reason).toBe("invalid_checkpoint");
    expect(verifyExport(page(entries, cp(entries), 9)).firstInvalid?.reason).toBe("invalid_page_cursor");
  });
  it("checks approval binding and automatic expiry", () => {
    const base: LedgerInput = { ...golden.entries[0]!, formatVersion: 2, approvalRef: "approval-1", policyRev: "a".repeat(64), operatorId: "bootstrap" };
    // Remove chain fields before using the producer to construct new entries.
    const { seq: _seq, prevHash: _prev, hash: _hash, ...input } = base as LedgerEntry;
    const decision = chainEntry(1, GENESIS_HASH, { ...input, action: "mcp.approval.decided" });
    const call = chainEntry(2, decision.hash, { ...input, action: "mcp.tools/call" });
    expect(verifyExport(page([decision, call])).valid).toBe(true);
    expect(verifyExport(page(rehash([decision, { ...call, requestHash: "b".repeat(64) }]))).firstInvalid?.reason).toBe("approval_mismatch");
    expect(verifyExport(page(rehash([{ ...decision, reason: "expired", verdict: "denied" }]))).firstInvalid?.reason).toBe("invalid_approval_decision");
    const { operatorId: _operator, ...expiry } = decision;
    expect(verifyExport(page(rehash([{ ...expiry, reason: "expired", verdict: "denied" }]))).valid).toBe(true);
  });
  it("renders JSON and text, with nonzero status for every invalid input", () => {
    const entries = chain([1, 2]);
    const files: Record<string, string> = { export: page(entries), checkpoint: JSON.stringify(cp(entries)) };
    const read = (name: string) => { if (!(name in files)) throw new Error("File unavailable"); return files[name]!; };
    expect(run(["--json", "export", "checkpoint"], read).code).toBe(0);
    expect(JSON.parse(run(["--json", "export"], read).output)).toMatchObject({ valid: true, count: 2 });
    expect(run(["export"], read).output).toContain("VALID\nEntries: 2");
    for (const args of [[], ["--bad"], ["missing"], ["export", "missing"]]) expect(run(args, read).code).toBe(1);
    files.checkpoint = "null";
    expect(run(["export", "checkpoint"], read).code).toBe(1);
    files.export = "broken";
    expect(run(["--json", "export"], read).code).toBe(1);
  });
});
