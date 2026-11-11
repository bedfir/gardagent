import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, verifyChain, type AppendLedgerOptions, type LedgerEntry, type LedgerInput } from "@gardagent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { LedgerGuard, ledgerGuardFor, type SpoolMeta } from "../src/ledger-guard.js";
import { config, createAgent, jsonResponse } from "./helpers.js";

const quiet = { error() {}, warn() {}, info() {} };

/** MemoryStore with a switchable outage, and a mode where the server commits but the client never gets the answer. */
class TestStore extends MemoryStore {
  down = false;
  commitThenHang = false;
  private check() {
    if (this.down) throw new Error("connection refused");
  }
  override async ping() {
    this.check();
  }
  override appendLedger(input: LedgerInput, options?: AppendLedgerOptions): Promise<LedgerEntry> {
    if (this.down) return Promise.reject(new Error("connection refused"));
    const committed = super.appendLedger(input, options);
    return this.commitThenHang ? committed.then(() => new Promise<never>(() => undefined)) : committed;
  }
  override async findAgentByKeyHash(hash: string) {
    this.check();
    return super.findAgentByKeyHash(hash);
  }
  override async getSpent(agentId: string, day: string) {
    this.check();
    return super.getSpent(agentId, day);
  }
  override async reserve(...args: Parameters<MemoryStore["reserve"]>) {
    this.check();
    return super.reserve(...args);
  }
  override async settleReservation(...args: Parameters<MemoryStore["settleReservation"]>) {
    this.check();
    return super.settleReservation(...args);
  }
  override async addSpend(...args: Parameters<MemoryStore["addSpend"]>) {
    this.check();
    return super.addSpend(...args);
  }
}

const dirs: string[] = [];
function spoolPath() {
  const dir = mkdtempSync(join(tmpdir(), "ga-replay-"));
  dirs.push(dir);
  return join(dir, "spool", "ledger.jsonl");
}

const row = (n: number, over: Partial<LedgerInput> = {}): LedgerInput => ({
  ts: new Date(Date.UTC(2026, 0, 2, 23, 59, 50) + n * 1000).toISOString(),
  agentId: "a1",
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
const pending = (over: SpoolMeta = {}): SpoolMeta => ({ budgetSettlement: "pending", budgetDay: "2026-01-02", ...over });
const DAY = "2026-01-02";

function makeGuard(store: TestStore, path: string, over: Record<string, unknown> = {}) {
  return new LedgerGuard(store, quiet, { spoolPath: path, retryDelaysMs: [1, 1], callTimeoutMs: 50, probeTimeoutMs: 50, ...over });
}

afterEach(() => vi.restoreAllMocks());

describe("idempotent spool replay", () => {
  it("replays the ledger row and the spend together, on the day of the original request, and drops the reservation", async () => {
    const store = new TestStore();
    const guard = makeGuard(store, spoolPath());
    const rid = (await store.reserve("a1", DAY, 2000, 10_000, 60_000))!;
    store.down = true;
    await guard.append(row(1), pending({ reservationId: rid }));
    expect(guard.spoolBacklog()).toBe(1);

    store.down = false;
    expect(await store.getSpent("a1", DAY)).toBe(0); // nothing settled before the replay
    expect(await store.getReserved("a1", DAY, 60_000)).toBe(2000);
    expect(await guard.probe()).toBe(true);
    expect(await guard.replay()).toBe(1);
    expect(await store.getSpent("a1", DAY)).toBe(500);
    expect(await store.getSpent("a1", new Date().toISOString().slice(0, 10))).toBe(0); // not booked on the day of the replay
    expect(await store.getReserved("a1", DAY, 60_000)).toBe(0);
    expect(await store.listLedger()).toHaveLength(1);
  });

  it("replaying the same spool any number of times yields one ledger row and one spend increment per line", async () => {
    const store = new TestStore();
    const path = spoolPath();
    const guard = makeGuard(store, path);
    store.down = true;
    for (let i = 1; i <= 3; i++) await guard.append(row(i), pending());
    const saved = `${path}.saved`;
    copyFileSync(path, saved);

    store.down = false;
    await guard.probe();
    expect(await guard.replay()).toBe(3);
    for (let round = 0; round < 3; round++) {
      copyFileSync(saved, path); // the same spool again, as if it was never emptied
      const again = makeGuard(store, path);
      await again.start();
      again.stop();
      expect(existsSync(path) ? readFileSync(path, "utf-8").trim() : "").toBe("");
    }
    expect(await store.listLedger()).toHaveLength(3);
    expect(await store.getSpent("a1", DAY)).toBe(1500);
  });

  it("case (a): crash between the insert and the removal of the line from the spool", async () => {
    const store = new TestStore();
    const path = spoolPath();
    const guard = makeGuard(store, path);
    store.down = true;
    await guard.append(row(1), pending());
    copyFileSync(path, `${path}.before`);
    store.down = false;
    await guard.probe();
    await guard.replay();
    copyFileSync(`${path}.before`, path); // the process died before the rewrite of the spool: the line is still there

    const restarted = makeGuard(store, path);
    await restarted.start();
    restarted.stop();
    expect(restarted.spoolBacklog()).toBe(0);
    expect(await store.listLedger()).toHaveLength(1);
    expect(await store.getSpent("a1", DAY)).toBe(500);
  });

  it("case (b): an insert that timed out client-side but was committed by the server is not duplicated", async () => {
    const store = new TestStore();
    const guard = makeGuard(store, spoolPath());
    store.commitThenHang = true;
    await guard.append(row(1), pending()); // committed (ledger + spend), but the answer never comes: timeout, spooled
    expect(guard.spoolBacklog()).toBe(1);
    expect(await store.listLedger()).toHaveLength(1);
    expect(await store.getSpent("a1", DAY)).toBe(500);

    store.commitThenHang = false;
    expect(await guard.probe()).toBe(true);
    expect(await guard.replay()).toBe(1);
    expect(guard.spoolBacklog()).toBe(0);
    expect(await store.listLedger()).toHaveLength(1);
    expect(await store.getSpent("a1", DAY)).toBe(500);
  });

  it("case (c): a settlement that timed out but was applied is not counted again when the row is replayed", async () => {
    const store = new TestStore();
    const guard = makeGuard(store, spoolPath());
    await store.addSpend("a1", DAY, 500, "settle-key-1"); // applied by the server, the gateway saw a timeout
    store.down = true;
    await guard.append(row(1), pending({ settlementKey: "settle-key-1" }));
    store.down = false;
    await guard.probe();
    await guard.replay();
    expect(await store.getSpent("a1", DAY)).toBe(500);
    expect(await store.listLedger()).toHaveLength(1);
  });

  it("marks rows written through the spool as degraded, keeps the chain valid after a late replay, and the marker is sealed in the hash", async () => {
    const store = new TestStore();
    const guard = makeGuard(store, spoolPath());
    await guard.append(row(1)); // direct
    store.down = true;
    await guard.append(row(2), pending()); // spooled: older than the next direct row
    store.down = false;
    await guard.probe();
    await guard.append(row(3, { ts: new Date().toISOString() })); // backlog > 0: goes to the spool behind row 2
    expect(await guard.replay()).toBe(2);
    await store.appendLedger(row(4, { ts: new Date().toISOString() })); // direct, after the late replay

    const rows = await store.listLedger();
    expect(rows.map((r) => r.requestHash)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(rows.map((r) => r.degraded === true)).toEqual([false, true, true, false]);
    expect(rows[0]).not.toHaveProperty("degraded");
    expect(verifyChain(rows).valid).toBe(true);

    store._tamper(2, { degraded: false }); // removing the marker afterwards breaks the chain
    expect(verifyChain(await store.listLedger()).valid).toBe(false);
  });

  it("purges orphan reservations after their TTL and never a live in-flight one", async () => {
    const store = new TestStore();
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    const TTL = 150_000;
    await store.reserve("a1", DAY, 1000, 10_000, TTL);
    now.mockReturnValue(t0 + 100_000);
    await store.reserve("a1", DAY, 2000, 10_000, TTL);
    now.mockReturnValue(t0 + TTL - 1000); // the first is not yet an orphan
    expect(await store.housekeeping(TTL)).toEqual({ reservations: 0, keys: 0 });
    expect(await store.getReserved("a1", DAY, TTL)).toBe(3000);
    now.mockReturnValue(t0 + TTL + 1000); // only the first one has expired
    expect(await store.housekeeping(TTL)).toEqual({ reservations: 1, keys: 0 });
    expect(await store.getReserved("a1", DAY, TTL)).toBe(2000);
  });

  it("the guard purges orphan reservations while the database is healthy (not during an outage)", async () => {
    const store = new TestStore();
    const spy = vi.spyOn(store, "housekeeping");
    const guard = makeGuard(store, spoolPath(), { reservationTtlMs: 150_000 });
    store.down = true;
    await guard.start();
    guard.stop();
    expect(spy).not.toHaveBeenCalled();
    store.down = false;
    const healthy = makeGuard(store, spoolPath(), { reservationTtlMs: 150_000 });
    await healthy.start();
    healthy.stop();
    expect(spy).toHaveBeenCalledWith(150_000);
  });
});

describe("gateway outage: agent_spend equals the ledger after replay", () => {
  it("settles calls finished during an outage, including a reservation orphaned mid-call", async () => {
    const store = new TestStore();
    const spool = spoolPath();
    let phase: "up" | "down" | "cut-mid-call" = "up";
    const fetchFn = (async () => {
      if (phase === "cut-mid-call") {
        store.down = true; // the database dies while the call is in flight, after the reservation was taken
        phase = "down";
      }
      return jsonResponse({ id: "c", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }) as unknown as typeof fetch;
    const app = buildApp({ config: { ...config, mode: "observe", dbOutage: "fail-open", ledgerSpoolPath: spool, dbCallTimeoutMs: 100 }, store, fetch: fetchFn });
    const guard = ledgerGuardFor(store, quiet, {});
    const { key, agent } = await createAgent(app, { name: "bot", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 1 });
    const post = () =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${key}` },
        payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] },
      });

    expect((await post()).statusCode).toBe(200); // database up: settled normally
    phase = "cut-mid-call";
    expect((await post()).statusCode).toBe(200); // the reservation of this call stays orphaned in the database
    store.down = true;
    expect((await post()).statusCode).toBe(200); // pure outage
    expect((await post()).statusCode).toBe(200);
    expect(guard.spoolBacklog()).toBeGreaterThanOrEqual(3);

    const day = new Date().toISOString().slice(0, 10);
    store.down = false;
    expect(await store.getReserved(agent.id, day, 150_000)).toBeGreaterThan(0); // orphan before the replay
    expect(await guard.probe()).toBe(true);
    await guard.replay();
    expect(await guard.replay()).toBe(0); // replay twice: nothing more

    const rows = (await store.listLedger()).filter((r) => r.agentId === agent.id && !r.action.startsWith("admin."));
    const ledgerCost = rows.reduce((sum, r) => sum + r.cost, 0);
    expect(rows).toHaveLength(4);
    expect(ledgerCost).toBeGreaterThan(0);
    expect(await store.getSpent(agent.id, day)).toBe(ledgerCost);
    expect(await store.getReserved(agent.id, day, 150_000)).toBe(0);
    expect(rows.filter((r) => r.degraded === true).length).toBeGreaterThanOrEqual(3);
    expect(verifyChain(await store.listLedger()).valid).toBe(true);
  });
});
