import { afterEach, describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, MemoryStore, verifyChain, type LedgerInput } from "@gardagent/core";
import { verifyExport } from "../../../packages/verify/src/index.js";
import { buildApp } from "../src/app.js";
import { adminHeaders, config } from "./helpers.js";

const base: LedgerInput = {
  ts: "2026-11-12T00:00:00.000Z", agentId: "agent-1", action: "mcp.approval.decided",
  model: null, verdict: "allowed", reason: null, upstreamStatus: null,
  promptTokens: 0, completionTokens: 0, cost: 0, requestHash: "a".repeat(64), responseHash: null,
  formatVersion: 2, approvalRef: "approval-1", policyRev: "b".repeat(64), operatorId: "operator-1",
};
const call: LedgerInput = { ...base, action: "mcp.tools/call" };
const { operatorId: _operator, ...expiry } = base;
const { policyRev: _policy, ...legacyDecision } = base;
const cases: { name: string; inputs: LedgerInput[]; problem: string | null }[] = [
  { name: "missing prior decision", inputs: [call], problem: "approval_mismatch" },
  { name: "different arguments", inputs: [base, { ...call, requestHash: "c".repeat(64) }], problem: "approval_mismatch" },
  { name: "decision after call", inputs: [call, base], problem: "approval_mismatch" },
  { name: "valid correlation across pages", inputs: [base, call], problem: null },
  { name: "different agent", inputs: [base, { ...call, agentId: "agent-2" }], problem: "approval_mismatch" },
  { name: "different approval id", inputs: [base, { ...call, approvalRef: "approval-2" }], problem: "approval_mismatch" },
  { name: "denied decision", inputs: [{ ...base, verdict: "denied" }, call], problem: "approval_mismatch" },
  { name: "latest decision denied", inputs: [base, { ...base, verdict: "denied" }, call], problem: "approval_mismatch" },
  { name: "invalid expiry operator", inputs: [{ ...base, reason: "expired", verdict: "denied" }], problem: "invalid_approval_decision" },
  { name: "valid automatic expiry", inputs: [{ ...expiry, reason: "expired", verdict: "denied" }], problem: null },
  { name: "decision without policy revision", inputs: [legacyDecision], problem: "invalid_approval_decision" },
];

describe("approval correlation contract: core, standalone and gateway", () => {
  afterEach(() => vi.restoreAllMocks());
  for (const fixture of cases) it(fixture.name, async () => {
    const store = new MemoryStore();
    for (const input of fixture.inputs) await store.appendLedger(input);
    const entries = await store.listLedger();
    const checkpoint = {
      format: "gardagent-checkpoint-v1", sequence: entries.length,
      head_hash: entries.at(-1)?.hash ?? GENESIS_HASH, created_at: base.ts,
    };
    // One row per export page and per gateway verification read.
    const exported = entries.map((entry, i) => [
      JSON.stringify({ type: "metadata", checkpoint, nextAfterSeq: i + 1 < entries.length ? entry.seq : null }),
      JSON.stringify(entry),
    ].join("\n")).join("\n") + "\n";
    const standalone = verifyExport(exported);
    expect(standalone.valid).toBe(fixture.problem === null);
    expect(standalone.firstInvalid?.reason ?? null).toBe(fixture.problem);
    const core = verifyChain(entries);
    expect(core.valid).toBe(standalone.valid);
    expect(core.valid ? null : core.problem).toBe(fixture.problem);
    const read = store.listLedger.bind(store);
    const reads = vi.spyOn(store, "listLedger").mockImplementation((query) => read({ ...query, limit: 1 }));
    const app = buildApp({ config, store });
    try {
      for (const method of ["GET", "POST"] as const) {
        reads.mockClear();
        const response = await app.inject({ method, url: "/admin/ledger/verify", headers: adminHeaders,
          ...(method === "POST" ? { payload: checkpoint } : {}) });
        expect(response.statusCode).toBe(200);
        const result = response.json();
        expect(result.valid).toBe(standalone.valid);
        expect(result.problem ?? null).toBe(fixture.problem);
        if (!standalone.valid) expect(result.brokenAtSeq).toBe(standalone.firstInvalid?.sequence);
        if (fixture.name === "valid correlation across pages") expect(reads.mock.calls.length).toBeGreaterThan(1);
      }
    } finally { await app.close(); }
  });
});
