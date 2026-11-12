import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  MemoryStore,
  chainEntry,
  GENESIS_HASH,
  verifyChain,
  type LedgerEntry,
  type LedgerInput,
} from "@gardagent/core";

function input(n: number): LedgerInput {
  return {
    ts: `2026-01-01T00:00:0${n}.000Z`,
    agentId: "agent-1",
    action: "chat.completions",
    model: "gpt-4o-mini",
    verdict: "allowed",
    reason: null,
    upstreamStatus: 200,
    promptTokens: n,
    completionTokens: n * 2,
    cost: n * 10,
    requestHash: `req${n}`,
    responseHash: `res${n}`,
  };
}

function buildChain(length: number): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= length; i++) {
    const e = chainEntry(i, prev, input(i));
    entries.push(e);
    prev = e.hash;
  }
  return entries;
}

describe("ledger chain", () => {
  it("accepts a valid chain", () => {
    const entries = buildChain(5);
    const check = verifyChain(entries);
    expect(check).toEqual({ valid: true, count: 5, lastHash: entries[4]!.hash });
  });

  it("accepts an empty chain", () => {
    expect(verifyChain([])).toEqual({ valid: true, count: 0, lastHash: GENESIS_HASH });
  });

  it("detects tampering (hash_mismatch)", () => {
    const entries = buildChain(5);
    entries[2] = { ...entries[2]!, cost: 999_999 };
    expect(verifyChain(entries)).toMatchObject({ valid: false, brokenAtSeq: 3, problem: "hash_mismatch" });
  });

  it("detects a broken link (link_mismatch)", () => {
    const entries = buildChain(5);
    entries[3] = { ...entries[3]!, prevHash: "f".repeat(64) };
    expect(verifyChain(entries)).toMatchObject({ valid: false, brokenAtSeq: 4, problem: "link_mismatch" });
  });

  it("detects a sequence gap (seq_gap)", () => {
    const entries = buildChain(5);
    entries.splice(2, 1);
    expect(verifyChain(entries)).toMatchObject({ valid: false, brokenAtSeq: 4, problem: "seq_gap" });
  });

  it("verifies a portion from a known prevHash", () => {
    const entries = buildChain(6);
    const portion = entries.slice(3);
    expect(verifyChain(portion, entries[2]!.hash)).toEqual({ valid: true, count: 3, lastHash: entries[5]!.hash });
    expect(verifyChain(portion)).toMatchObject({ valid: false, brokenAtSeq: 4, problem: "link_mismatch" });
    expect(verifyChain(portion, "a".repeat(64))).toMatchObject({ valid: false, problem: "link_mismatch" });
  });
});

describe("canonicalJson", () => {
  it("is stable regardless of key order", () => {
    const a = { b: 1, a: { y: [1, { d: 4, c: 3 }], x: null }, c: "t" };
    const b = { c: "t", a: { x: null, y: [1, { c: 3, d: 4 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":null,"y":[1,{"c":3,"d":4}]},"b":1,"c":"t"}');
  });

  it("keeps array order and ignores undefined keys", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});


describe("ledger format 2", () => {
  it("verifies a historical prefix followed by a new writer entry", async () => {
    const store = new MemoryStore();
    const historical = chainEntry(1, GENESIS_HASH, input(1));
    // Seed historical persisted state to exercise the upgrade boundary in the same store.
    (store as unknown as { ledger: LedgerEntry[] }).ledger.push(historical);
    const next = await store.appendLedger({ ...input(2), policyRev: "a".repeat(64), operatorId: "operator", approvalRef: "reference" });
    expect(next.formatVersion).toBe(2);
    const entries = await store.listLedger();
    expect(entries[0]).toEqual(historical);
    expect(entries[0]).not.toHaveProperty("formatVersion");
    expect(verifyChain(entries).valid).toBe(true);
    for (const key of ["policyRev", "operatorId", "approvalRef"] as const) {
      expect(verifyChain([historical, { ...next, [key]: "tampered" }])).toMatchObject({ brokenAtSeq: 2, problem: "hash_mismatch" });
    }
    expect(verifyChain([historical, { ...next, formatVersion: 99 }])).toMatchObject({ brokenAtSeq: 2, problem: "unsupported_format" });
    const { formatVersion: _version, ...withoutVersion } = next;
    expect(verifyChain([historical, withoutVersion])).toMatchObject({ brokenAtSeq: 2, problem: "hash_mismatch" });
  });

  it("rejects rehashed invalid format content and version regression", () => {
    const first = chainEntry(1, GENESIS_HASH, { ...input(1), formatVersion: 2 });
    const old = chainEntry(2, first.hash, input(2));
    expect(verifyChain([first, old])).toMatchObject({ brokenAtSeq: 2, problem: "invalid_format" });
    for (const extra of [{ policyRev: "a".repeat(64) }, { operatorId: "operator" }, { approvalRef: "ref" }]) {
      expect(verifyChain([chainEntry(1, GENESIS_HASH, { ...input(1), ...extra })])).toMatchObject({ problem: "invalid_format" });
    }
    for (const extra of [{ policyRev: "bad" }, { operatorId: "" }, { approvalRef: "" }, { degraded: false }]) {
      expect(verifyChain([chainEntry(1, GENESIS_HASH, { ...input(1), formatVersion: 2, ...extra })])).toMatchObject({ problem: "invalid_format" });
    }
    expect(verifyChain([chainEntry(1, GENESIS_HASH, { ...input(1), formatVersion: 1 })])).toMatchObject({ problem: "unsupported_format" });
  });
});
