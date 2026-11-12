import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyChain, type Agent, type LedgerInput } from "@gardagent/core";
import { PgStore } from "../src/pg-store.js";

const url = process.env.TEST_DATABASE_URL;

const entryInput = (n: number): LedgerInput => ({
  ts: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  agentId: null,
  action: "chat.completions",
  model: "gpt-4o-mini",
  verdict: "allowed",
  reason: null,
  upstreamStatus: 200,
  promptTokens: n,
  completionTokens: n,
  cost: n * 3,
  requestHash: `r${n}`,
  responseHash: `s${n}`,
});

describe.skipIf(!url)("PgStore (PostgreSQL integration)", () => {
  let pool: pg.Pool;
  let store: PgStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query("DROP TABLE IF EXISTS schema_migrations, operators, policy_revisions, approvals, agent_reservations, ledger_idempotency, spend_settlements, agent_spend, ledger, agents CASCADE");
    store = new PgStore(pool);
    await store.migrate();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("migrate() est idempotente", async () => {
    await store.migrate();
    await store.migrate();
  });

  it("creates the expected indexes on ledger", async () => {
    const { rows } = await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'ledger'");
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("ledger_ts_idx");
    expect(names).toContain("ledger_agent_ts_idx");
  });

  it("creates and re-reads an agent", async () => {
    const agent: Agent = {
      id: randomUUID(),
      name: "pg-bot",
      keyHash: "hash-" + randomUUID(),
      allowedModels: ["gpt-4o-mini", "*"],
      allowedTools: ["srv/outil"],
      approvalTools: ["srv/danger"],
      dailyBudget: 123_456,
      active: true,
    };
    await store.createAgent(agent);
    expect(await store.findAgentByKeyHash(agent.keyHash)).toEqual(agent);
    expect(await store.findAgentByKeyHash("absent")).toBeNull();
    expect((await store.listAgents()).map((a) => a.id)).toContain(agent.id);
  });

  it("addSpend est cumulatif", async () => {
    const [agent] = await store.listAgents();
    const id = agent!.id;
    expect(await store.getSpent(id, "2026-01-01")).toBe(0);
    await store.addSpend(id, "2026-01-01", 100);
    await store.addSpend(id, "2026-01-01", 250);
    await store.addSpend(id, "2026-01-02", 7);
    expect(await store.getSpent(id, "2026-01-01")).toBe(350);
    expect(await store.getSpent(id, "2026-01-02")).toBe(7);
  });

  it("20 parallel appendLedger yield seq 1..20 and a valid chain", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.appendLedger(entryInput(i + 1))));
    expect(results.map((r) => r.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const rows = await store.listLedger();
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const check = verifyChain(rows);
    expect(check.valid).toBe(true);
    expect(check).toMatchObject({ count: 20 });
  });

  it("appendLedger does not commit a row whose caller already gave up (aborted signal)", async () => {
    const before = (await store.listLedger()).length;
    const abort = new AbortController();
    abort.abort();
    await expect(store.appendLedger(entryInput(900), { signal: abort.signal })).rejects.toThrow(/abandoned/);
    expect((await store.listLedger()).length).toBe(before);
    expect(verifyChain(await store.listLedger()).valid).toBe(true);
  });

  it("listLedger: order, beforeSeq, afterSeq et limit", async () => {
    const seqs = async (o: Parameters<PgStore["listLedger"]>[0]) => (await store.listLedger(o)).map((r) => r.seq);
    expect(await seqs({ order: "desc", limit: 3 })).toEqual([20, 19, 18]);
    expect(await seqs({ order: "desc", beforeSeq: 18, limit: 2 })).toEqual([17, 16]);
    expect(await seqs({ beforeSeq: 4 })).toEqual([1, 2, 3]);
    expect(await seqs({ afterSeq: 5, beforeSeq: 9, order: "desc" })).toEqual([8, 7, 6]);
    expect(await seqs({ afterSeq: 5, beforeSeq: 9, limit: 2 })).toEqual([6, 7]);
    expect(await seqs({ order: "desc", beforeSeq: 1 })).toEqual([]);
    expect(await seqs({ afterSeq: 18 })).toEqual([19, 20]);
  });

  it("getAgent and updateAgent: changed fields, parameters, unknown agent", async () => {
    const agent: Agent = {
      id: randomUUID(),
      name: "avant",
      keyHash: "hash-" + randomUUID(),
      allowedModels: ["a"],
      allowedTools: [],
      approvalTools: [],
      dailyBudget: 1,
      active: true,
    };
    await store.createAgent(agent);
    expect(await store.getAgent(agent.id)).toEqual(agent);
    expect(await store.getAgent("absent")).toBeNull();

    // A hostile value remains plain data: all values are passed as parameters.
    const hostile = "x'; DROP TABLE agents; --";
    const updated = await store.updateAgent(agent.id, { name: hostile, allowedModels: ["m1", "m2"], allowedTools: ["s/*"], dailyBudget: 99, active: false });
    expect(updated).toEqual({ ...agent, name: hostile, allowedModels: ["m1", "m2"], allowedTools: ["s/*"], dailyBudget: 99, active: false });
    expect(await store.getAgent(agent.id)).toEqual(updated);

    const partial = await store.updateAgent(agent.id, { active: true });
    expect(partial).toEqual({ ...updated, active: true });
    expect(await store.updateAgent(agent.id, {})).toEqual(partial);
    expect(await store.updateAgent("absent", { active: false })).toBeNull();
  });

  it("listLedger: fromTs and beforeTs bounds", async () => {
    // Rows have timestamp 1_700_000_000_000 + n * 1000 ms, but their seq depends on arrival order.
    const ts = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
    const stamps = async (o: Parameters<PgStore["listLedger"]>[0]) => (await store.listLedger(o)).map((r) => r.ts).sort();
    expect(await stamps({ fromTs: ts(18) })).toEqual([ts(18), ts(19), ts(20)]);
    expect(await stamps({ beforeTs: ts(3) })).toEqual([ts(1), ts(2)]);
    expect(await stamps({ fromTs: ts(5), beforeTs: ts(8) })).toEqual([ts(5), ts(6), ts(7)]);

    const desc = await store.listLedger({ fromTs: ts(5), beforeTs: ts(8), order: "desc", limit: 2 });
    expect(desc).toHaveLength(2);
    expect(desc[0]!.seq).toBeGreaterThan(desc[1]!.seq);
    expect(desc.every((r) => r.ts >= ts(5) && r.ts < ts(8))).toBe(true);
  });

  it("aggregateLedger: groups by day, agent, verdict and reason, excluding admin.* actions", async () => {
    await store.appendLedger({ ...entryInput(21), action: "admin.agent.create", cost: 0 });
    await store.appendLedger({ ...entryInput(22), verdict: "denied", reason: "model_not_allowed", cost: 0 });
    const rows = await store.aggregateLedger("2023-11-14");
    const allowed = rows.find((r) => r.verdict === "allowed")!;
    expect(allowed).toMatchObject({ day: "2023-11-14", agentId: null, reason: null, count: 20 });
    expect(allowed.promptTokens).toBe(210);
    expect(allowed.completionTokens).toBe(210);
    expect(allowed.cost).toBe(630);
    expect(rows.find((r) => r.verdict === "denied")).toMatchObject({ reason: "model_not_allowed", count: 1 });
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(21);
    expect(await store.aggregateLedger("2023-11-15")).toEqual([]);
  });

  it("rejects direct UPDATE and DELETE on the ledger", async () => {
    await expect(pool.query("UPDATE ledger SET cost = 0 WHERE seq = 1")).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM ledger WHERE seq = 1")).rejects.toThrow(/append-only/);
    expect(verifyChain(await store.listLedger()).valid).toBe(true);
  });

  it("approvals: versioned restart, atomic decision, excluded from aggregate", async () => {
    await store.migrate();
    await store.migrate();
    const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'approval_tools'");
    expect(cols.rowCount).toBe(1);
    expect((await pool.query("SELECT to_regclass('public.approvals') AS t")).rows[0].t).toBe("approvals");

    const base = { createdAt: "2026-10-20T10:00:00.000Z", agentId: "a", server: "gh", tool: "delete", argsHash: "h", argsSummary: 'path="/x"', status: "pending" as const, decidedAt: null, reason: null, accessClass: "write" as const };
    await store.createApproval({ ...base, id: "p1" });
    await store.createApproval({ ...base, id: "p2", createdAt: "2026-10-20T10:00:05.000Z" });
    expect((await store.listApprovals({ status: "pending" })).map((a) => a.id)).toEqual(["p2", "p1"]);
    const first = await store.decideApproval("p1", "rejected", "non", "2026-10-20T10:01:00.000Z");
    expect(first).toMatchObject({ id: "p1", status: "rejected", reason: "non", decidedAt: "2026-10-20T10:01:00.000Z" });
    expect(await store.decideApproval("p1", "approved", null, "2026-10-20T10:02:00.000Z")).toBeNull();
    expect((await store.getApproval("p1"))!.status).toBe("rejected");
    expect(await store.getApproval("absent")).toBeNull();
    expect((await store.listApprovals({ status: "pending" })).map((a) => a.id)).toEqual(["p2"]);

    const before = (await store.aggregateLedger("2023-11-14")).reduce((n, r) => n + r.count, 0);
    await store.appendLedger({ ...entryInput(40), action: "mcp.approval.requested" });
    expect((await store.aggregateLedger("2023-11-14")).reduce((n, r) => n + r.count, 0)).toBe(before);
  });
});
