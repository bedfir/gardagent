import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MemoryStore, type AppendLedgerOptions, type LedgerEntry, type LedgerInput, type Store } from "@gardagent/core";
import { LedgerGuard } from "../src/ledger-guard.js";
import { PgStore } from "../src/pg-store.js";

const url = process.env.TEST_DATABASE_URL;
const quiet = { error() {}, warn() {}, info() {} };
const DAY = "2026-01-02";
const TTL = 150_000;

/** Adds a switch that makes every ledger append fail while the ping still answers (replay fails, probe passes). */
function failing<T extends new (...args: any[]) => Store>(Base: T) {
  return class extends Base {
    failAppend = false;
    override appendLedger(input: LedgerInput, options?: AppendLedgerOptions): Promise<LedgerEntry> {
      if (this.failAppend) return Promise.reject(new Error("connection reset"));
      return super.appendLedger(input, options);
    }
  };
}

const row = (agentId: string): LedgerInput => ({
  ts: new Date(Date.UTC(2026, 0, 2, 23, 59, 50)).toISOString(),
  agentId,
  action: "chat.completions",
  model: "gpt-4o-mini",
  verdict: "allowed",
  reason: null,
  upstreamStatus: 200,
  promptTokens: 10,
  completionTokens: 5,
  cost: 500,
  requestHash: "r1",
  responseHash: "s1",
});

async function scenario(store: Store & { failAppend: boolean }, agentId: string, age: (reservationId: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ga-spool-hk-"));
  const guard = new LedgerGuard(store, quiet, {
    spoolPath: join(dir, "spool", "ledger.jsonl"),
    retryDelaysMs: [1, 1],
    callTimeoutMs: 200,
    probeTimeoutMs: 200,
    reservationTtlMs: TTL,
  });
  const rid = (await store.reserve(agentId, DAY, 2000, 10_000_000, TTL))!;
  // The call finished during the outage: its row goes to the spool, carrying the reservation id.
  store.failAppend = true;
  await guard.append(row(agentId), { budgetSettlement: "pending", budgetDay: DAY, reservationId: rid });
  expect(guard.spoolBacklog()).toBe(1);
  await age(rid); // the outage lasted longer than the reservation TTL
  const hk = vi.spyOn(store, "housekeeping");
  const tick = () => (guard as unknown as { tick(): Promise<void> }).tick();

  await tick(); // probe passes, replay fails again
  expect(guard.spoolBacklog()).toBe(1);
  expect(hk).not.toHaveBeenCalled(); // never purge while lines wait
  expect(await store.listLedger({ agentId })).toHaveLength(0);
  expect(await store.getSpent(agentId, DAY)).toBe(0);

  store.failAppend = false;
  await tick(); // replay succeeds, then housekeeping may run
  expect(guard.spoolBacklog()).toBe(0);
  const rows = await store.listLedger({ agentId });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ reason: null, cost: 500, degraded: true });
  expect(await store.getReserved(agentId, DAY, TTL)).toBe(0);
  expect(await store.getSpent(agentId, DAY)).toBe(rows.reduce((sum, r) => sum + r.cost, 0));
  guard.stop();
}

describe("housekeeping waits for the spool replay", () => {
  it("MemoryStore: a call finished during the outage is counted once", async () => {
    const store = new (failing(MemoryStore))();
    await store.createAgent({ id: "a1", name: "a", keyHash: "h", allowedModels: ["*"], allowedTools: [], approvalTools: [], dailyBudget: 0, active: true });
    await scenario(store, "a1", async (id) => {
      const map = (store as unknown as { reservations: Map<string, { at: number }> }).reservations;
      map.get(id)!.at = Date.now() - TTL - 1000;
    });
  });
});

let pool: pg.Pool | undefined;
afterAll(async () => {
  await pool?.end();
});

describe.skipIf(!url)("housekeeping waits for the spool replay (PostgreSQL)", () => {
  it("PgStore: a call finished during the outage is counted once", async () => {
    const boot = new pg.Pool({ connectionString: url });
    await boot.query("DROP SCHEMA IF EXISTS spool_hk_test CASCADE");
    await boot.query("CREATE SCHEMA spool_hk_test");
    await boot.end();
    pool = new pg.Pool({ connectionString: url, options: "-c search_path=spool_hk_test" });
    const store = new (failing(PgStore))(pool);
    await store.migrate();
    const id = randomUUID();
    await store.createAgent({ id, name: "a", keyHash: "h-" + id, allowedModels: ["*"], allowedTools: [], approvalTools: [], dailyBudget: 10_000_000, active: true });
    await scenario(store, id, async (rid) => {
      await pool!.query("UPDATE agent_reservations SET created_at = now() - interval '10 minutes' WHERE id = $1", [rid]);
    });
  });
});
