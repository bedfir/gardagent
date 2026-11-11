import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore, type AppendLedgerOptions, type LedgerEntry, type LedgerInput } from "@gardagent/core";
import { LedgerGuard } from "../src/ledger-guard.js";

const quiet = { error() {}, warn() {}, info() {} };

class FlakyStore extends MemoryStore {
  failAppend = true;
  override appendLedger(input: LedgerInput, options?: AppendLedgerOptions): Promise<LedgerEntry> {
    if (this.failAppend) return Promise.reject(new Error("connection reset"));
    return super.appendLedger(input, options);
  }
}

const row: LedgerInput = {
  ts: "2026-11-01T10:00:00.000Z", agentId: null, action: "chat.completions", model: "m", verdict: "allowed", reason: null,
  upstreamStatus: 200, promptTokens: 1, completionTokens: 1, cost: 1, requestHash: "r", responseHash: "s",
};

describe("ledger spool permissions (E9)", () => {
  it("creates the spool file with mode 0600 and the directory it creates with mode 0700", async () => {
    const base = mkdtempSync(join(tmpdir(), "ga-spool-mode-"));
    const spoolPath = join(base, "spool", "ledger.jsonl");
    const guard = new LedgerGuard(new FlakyStore(), quiet, { spoolPath, retryDelaysMs: [1, 1], callTimeoutMs: 200, probeTimeoutMs: 200 });
    await guard.append(row);
    expect(guard.spoolBacklog()).toBe(1);
    expect(statSync(spoolPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(base, "spool")).mode & 0o777).toBe(0o700);
  });
});
