import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyChain, type Agent, type LedgerInput } from "@gardagent/core";
import { LedgerGuard } from "../src/ledger-guard.js";
import { PgStore } from "../src/pg-store.js";

const url = process.env.TEST_DATABASE_URL;
const LEDGER_LOCK = 72_617_001;
const DAY = "2026-01-02";
const quiet = { error() {}, warn() {}, info() {} };

const input = (n: number, over: Partial<LedgerInput> = {}): LedgerInput => ({
  ts: new Date(Date.UTC(2026, 0, 2, 23, 59, 0) + n * 1000).toISOString(),
  agentId: null,
  action: "chat.completions",
  model: "gpt-4o-mini",
  verdict: "allowed",
  reason: null,
  upstreamStatus: 200,
  promptTokens: 10,
  completionTokens: 5,
  cost: 500,
  requestHash: `r${n}`,
  responseHash: `s${n}`,
  ...over,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!url)("idempotent ledger append and settlement (PostgreSQL)", () => {
  let pool: pg.Pool;
  let store: PgStore;
  let agentId: string;

  const newAgent = async (): Promise<string> => {
    const agent: Agent = {
      id: randomUUID(),
      name: "replay-bot",
      keyHash: "hash-" + randomUUID(),
      allowedModels: ["*"],
      allowedTools: [],
      approvalTools: [],
      dailyBudget: 10_000_000,
      active: true,
    };
    await store.createAgent(agent);
    return agent.id;
  };
  const rows = async () => (await store.listLedger({ limit: 10_000 })).filter((r) => r.agentId === agentId);
  const settlement = (key: string, amount = 500, reservationId: string | null = null) => ({ key, agentId, day: DAY, amount, reservationId });

  beforeAll(async () => {
    // Dedicated schema: does not collide with the other PostgreSQL test files running in parallel.
    const boot = new pg.Pool({ connectionString: url });
    await boot.query("DROP SCHEMA IF EXISTS replay_test CASCADE");
    await boot.query("CREATE SCHEMA replay_test");
    await boot.end();
    pool = new pg.Pool({ connectionString: url, options: "-c search_path=replay_test" });
    store = new PgStore(pool);
    await store.migrate();
    await store.migrate(); // idempotent
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("the same key commits one ledger row and one spend increment, and drops the reservation", async () => {
    agentId = await newAgent();
    const rid = (await store.reserve(agentId, DAY, 2000, 10_000_000, 60_000))!;
    const opts = { idempotencyKey: randomUUID(), settlement: settlement(randomUUID(), 500, rid) };
    const first = await store.appendLedger(input(1, { agentId, degraded: true }), opts);
    const second = await store.appendLedger(input(1, { agentId, degraded: true }), opts);
    const third = await store.appendLedger(input(1, { agentId, degraded: true }), opts);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(await rows()).toHaveLength(1);
    expect(await store.getSpent(agentId, DAY)).toBe(500);
    expect(await store.getReserved(agentId, DAY, 60_000)).toBe(0);
  });

  it("concurrent appends with the same key write exactly once", async () => {
    agentId = await newAgent();
    const opts = { idempotencyKey: randomUUID(), settlement: settlement(randomUUID()) };
    const results = await Promise.all(Array.from({ length: 6 }, () => store.appendLedger(input(2, { agentId }), opts)));
    expect(new Set(results.map((r) => r.seq)).size).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect(await store.getSpent(agentId, DAY)).toBe(500);
  });

  it("a settlement that timed out but was applied (same key) is not counted again by the ledger append", async () => {
    agentId = await newAgent();
    const key = randomUUID();
    const rid = (await store.reserve(agentId, DAY, 2000, 10_000_000, 60_000))!;
    await store.settleReservation(rid, agentId, DAY, 500, key); // applied; the gateway saw a timeout
    await store.settleReservation(rid, agentId, DAY, 500, key); // a retry changes nothing
    await store.addSpend(agentId, DAY, 500, key);
    await store.appendLedger(input(3, { agentId, degraded: true }), { idempotencyKey: randomUUID(), settlement: settlement(key) });
    expect(await store.getSpent(agentId, DAY)).toBe(500);
  });

  it("case (b): an attempt still waiting on the ledger lock when its caller times out never commits; the replay writes the row once", async () => {
    agentId = await newAgent();
    const path = join(mkdtempSync(join(tmpdir(), "ga-replay-pg-")), "spool", "ledger.jsonl");
    const guard = new LedgerGuard(store, quiet, { spoolPath: path, retryDelaysMs: [1], callTimeoutMs: 80, probeTimeoutMs: 500 });
    const holder = await pool.connect();
    await holder.query("SELECT pg_advisory_lock($1)", [LEDGER_LOCK]); // a slow writer: the append waits behind it
    try {
      await guard.append(input(4, { agentId }), { budgetSettlement: "pending", budgetDay: DAY });
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [LEDGER_LOCK]);
      holder.release();
    }
    expect(guard.spoolBacklog()).toBe(1);
    await sleep(200); // the abandoned attempt gets the lock, sees the aborted signal and rolls back
    expect(await rows()).toHaveLength(0);
    expect(await guard.probe()).toBe(true);
    expect(await guard.replay()).toBe(1);
    expect(await guard.replay()).toBe(0);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ degraded: true });
    expect(await store.getSpent(agentId, DAY)).toBe(500);
    expect(existsSync(path) ? readFileSync(path, "utf-8").trim() : "").toBe("");
  });

  it("case (a)/(c): a spool line replayed again after its commit (crash before removal, timeout during COMMIT) is a no-op", async () => {
    agentId = await newAgent();
    const path = join(mkdtempSync(join(tmpdir(), "ga-replay-pg-")), "spool", "ledger.jsonl");
    const guard = new LedgerGuard(store, quiet, { spoolPath: path, callTimeoutMs: 500 });
    // Spool two lines with the database "down" for the guard, keep a copy of the spool file.
    guard.markUnhealthy();
    await guard.append(input(5, { agentId, cost: 300 }), { budgetSettlement: "pending", budgetDay: DAY });
    await guard.append(input(6, { agentId, cost: 200 }), { budgetSettlement: "pending", budgetDay: DAY });
    const saved = readFileSync(path, "utf-8");
    expect(await guard.probe()).toBe(true);
    expect(await guard.replay()).toBe(2);

    for (let i = 0; i < 3; i++) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, saved); // the same spool, as if the removal of its lines never happened
      const again = new LedgerGuard(store, quiet, { spoolPath: path, callTimeoutMs: 500 });
      await again.start();
      again.stop();
      expect(again.spoolBacklog()).toBe(0);
    }
    expect(await rows()).toHaveLength(2);
    expect(await store.getSpent(agentId, DAY)).toBe(500);
    // agent_spend equals the ledger sum for the agent and the original day
    const sum = (await rows()).reduce((s, r) => s + r.cost, 0);
    expect(await store.getSpent(agentId, DAY)).toBe(sum);
  });

  it("late replayed rows keep the chain valid; rows without the marker keep their original hash", async () => {
    agentId = await newAgent();
    await store.appendLedger(input(7, { agentId }));
    await store.appendLedger(input(8, { agentId, degraded: true, ts: "2020-01-01T00:00:00.000Z" })); // replayed years late
    await store.appendLedger(input(9, { agentId }));
    const all = await store.listLedger({ limit: 10_000 });
    expect(verifyChain(all).valid).toBe(true);
    const mine = all.filter((r) => r.agentId === agentId);
    expect(mine.map((r) => r.degraded === true)).toEqual([false, true, false]);
    expect(mine[0]).not.toHaveProperty("degraded");
  });

  it("the ledger stays append-only (the idempotency table does not weaken the trigger)", async () => {
    await expect(pool.query("UPDATE ledger SET degraded = FALSE")).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM ledger")).rejects.toThrow(/append-only/);
  });

  it("housekeeping purges reservations older than the TTL and never a live one", async () => {
    agentId = await newAgent();
    const old = (await store.reserve(agentId, DAY, 1000, 10_000_000, 60_000))!;
    const live = (await store.reserve(agentId, DAY, 2000, 10_000_000, 60_000))!;
    await pool.query("UPDATE agent_reservations SET created_at = now() - interval '10 minutes' WHERE id = $1", [old]);
    await pool.query("UPDATE agent_reservations SET created_at = now() - interval '30 seconds' WHERE id = $1", [live]);
    const done = await store.housekeeping(150_000);
    expect(done.reservations).toBeGreaterThanOrEqual(1);
    const left = await pool.query<{ id: string }>("SELECT id FROM agent_reservations WHERE agent_id = $1", [agentId]);
    expect(left.rows.map((r) => r.id)).toEqual([live]);
  });
});
