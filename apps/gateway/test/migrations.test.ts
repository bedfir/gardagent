import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { verifyChain, policyRevision, type Agent, type LedgerEntry } from "@gardagent/core";
import { PgStore } from "../src/pg-store.js";
import { MIGRATIONS, migrateDatabase } from "../src/migrations.js";

const url = process.env.TEST_DATABASE_URL;
const legacy = readFileSync(new URL("./fixtures/schema-0.3.0.sql", import.meta.url), "utf8");

async function fixture(run: (pool: pg.Pool, store: PgStore) => Promise<void>) {
  const schema = `migration_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await run(pool, new PgStore(pool));
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

async function snapshot(pool: pg.Pool) {
  return (await pool.query(`SELECT c.relname, c.oid::text, c.relfilenode::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() ORDER BY c.relname`)).rows;
}

describe.skipIf(!url)("versioned PostgreSQL migrations", () => {
  it("installs fresh and serializes overlapping callers", async () => fixture(async (pool, store) => {
    await Promise.all([store.migrate(), store.migrate()]);
    expect((await pool.query("SELECT version FROM schema_migrations ORDER BY version")).rows).toEqual(MIGRATIONS.map(({ version }) => ({ version })));
    expect((await pool.query("SELECT count(*) FROM ledger")).rows[0].count).toBe("0");
    await expect(pool.query("DELETE FROM ledger")).resolves.toBeDefined();
    expect((await pool.query("SELECT 1 FROM pg_trigger WHERE tgrelid = 'ledger'::regclass AND tgname = 'ledger_no_update'")).rowCount).toBe(1);
  }));

  it("adopts populated 0.3.0 without changing rows, relation identities or trigger", async () => fixture(async (pool, store) => {
    await pool.query(legacy);
    await pool.query("INSERT INTO agents (id,name,key_hash,allowed_models,daily_budget) VALUES ('old','old','fake-key',ARRAY['*'],1000)");
    await store.addSpend("old", "2026-11-12", 123);
    const golden = JSON.parse(readFileSync(new URL("../../../test/fixtures/contracts/ledger-v1.json", import.meta.url), "utf8")) as { entries: LedgerEntry[] };
    const old = golden.entries[0]!;
    await pool.query(`INSERT INTO ledger (seq, ts, agent_id, action, model, verdict, reason, upstream_status,
      prompt_tokens, completion_tokens, cost, request_hash, response_hash, prev_hash, hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [old.seq, old.ts, old.agentId, old.action, old.model, old.verdict, old.reason, old.upstreamStatus,
       old.promptTokens, old.completionTokens, old.cost, old.requestHash, old.responseHash, old.prevHash, old.hash]);
    const ledger = [old];
    const before = await snapshot(pool);
    const trigger = (await pool.query("SELECT oid FROM pg_trigger WHERE tgrelid = 'ledger'::regclass AND tgname = 'ledger_no_update'")).rows;
    await store.migrate();
    expect((await snapshot(pool)).filter((row) => before.some((original) => original.relname === row.relname))).toEqual(before);
    expect((await pool.query("SELECT oid FROM pg_trigger WHERE tgrelid = 'ledger'::regclass AND tgname = 'ledger_no_update'")).rows).toEqual(trigger);
    expect(await store.listLedger()).toEqual(ledger);
    expect(verifyChain(await store.listLedger()).valid).toBe(true);
    expect(await store.getSpent("old", "2026-11-12")).toBe(123);
    const rev = (await pool.query("SELECT policy_rev FROM agents WHERE id = 'old'")).rows[0].policy_rev;
    expect(await store.getPolicyRevision(rev)).toContain('"dailyBudget":1000');
    await expect(pool.query("UPDATE policy_revisions SET canonical = 'changed' WHERE id = $1", [rev])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM policy_revisions WHERE id = $1", [rev])).rejects.toThrow(/append-only/);
    const metadata = { policyRev: "a".repeat(64), operatorId: "test-operator", approvalRef: "test-reference" };
    const { seq: _seq, hash: _hash, prevHash: _prev, ...input } = old;
    const next = await store.appendLedger({ ...input, ...metadata });
    expect(next.formatVersion).toBe(2);
    const mixed = await store.listLedger();
    expect(mixed[1]).toEqual(next);
    expect(verifyChain(mixed).valid).toBe(true);
    for (const key of ["policyRev", "operatorId", "approvalRef"] as const) {
      expect(verifyChain([old, { ...next, [key]: "changed" }])).toMatchObject({ brokenAtSeq: 2, problem: "hash_mismatch" });
    }
    expect(verifyChain([old, { ...next, formatVersion: 99 }])).toMatchObject({ brokenAtSeq: 2, problem: "unsupported_format" });
    const columns = (await pool.query("SELECT column_default, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ledger' AND column_name IN ('format_version','policy_rev','operator_id','approval_ref')")).rows;
    expect(columns).toHaveLength(4);
    for (const column of columns) expect(column).toEqual({ column_default: null, is_nullable: "YES" });
    await expect(pool.query("UPDATE ledger SET cost = 0")).rejects.toThrow(/append-only/);
  }));

  it("a second run leaves all relation identities and migration timestamps unchanged", async () => fixture(async (pool, store) => {
    await store.migrate();
    const before = await snapshot(pool);
    const versions = (await pool.query("SELECT * FROM schema_migrations")).rows;
    await store.migrate();
    expect(await snapshot(pool)).toEqual(before);
    expect((await pool.query("SELECT * FROM schema_migrations")).rows).toEqual(versions);
  }));

  it("rolls back failing DDL and data while retaining the previous version", async () => fixture(async (pool, store) => {
    await store.migrate();
    await expect(migrateDatabase(pool, [...MIGRATIONS, { version: 5, name: "deliberate failure", up: async (client) => {
      await client.query("CREATE TABLE rollback_probe (id INTEGER)");
      await client.query("INSERT INTO spend_settlements (key) VALUES ('rollback-probe')");
      await client.query("SELECT deliberately_missing_function()");
    } }])).rejects.toThrow(/migration 5.*failed/);
    expect((await pool.query("SELECT to_regclass('rollback_probe') AS relation")).rows[0].relation).toBeNull();
    expect((await pool.query("SELECT * FROM spend_settlements")).rows).toEqual([]);
    expect((await pool.query("SELECT version FROM schema_migrations ORDER BY version")).rows).toEqual(MIGRATIONS.map(({ version }) => ({ version })));
    await store.migrate(); // failure released the advisory lock
  }));

  it("refuses a database newer than the executable", async () => fixture(async (pool, store) => {
    await store.migrate();
    await pool.query("INSERT INTO schema_migrations (version, name) VALUES (5, 'future')");
    await expect(store.migrate()).rejects.toThrow(/version 5 is newer than supported version 4/);
    expect((await pool.query("SELECT count(*) FROM schema_migrations")).rows[0].count).toBe(String(MIGRATIONS.length + 1));
  }));

  it("refuses incomplete unversioned schemas without repairing them", async () => fixture(async (pool, store) => {
    await pool.query(legacy);
    await pool.query("ALTER TABLE agents DROP COLUMN allowed_tools");
    await expect(store.migrate()).rejects.toThrow(/missing agents.allowed_tools/);
    expect((await pool.query("SELECT * FROM schema_migrations")).rows).toEqual([]);
  }));
});


describe.skipIf(!url)("persisted agent rate policy", () => {
  it("round trips limits, revisions and resetting to unlimited", async () => fixture(async (_pool, store) => {
    await store.migrate();
    const agent: Agent = { id: "limited", name: "limited", keyHash: "fake-fingerprint", allowedModels: ["*"], allowedTools: [], approvalTools: [], dailyBudget: 0, active: true, requestsPerMinute: 12, maxConcurrentRequests: 2 };
    await store.createAgent(agent);
    expect(await store.getAgent(agent.id)).toEqual(agent);
    expect(await store.getPolicyRevision(policyRevision(agent).id)).toBe(policyRevision(agent).canonical);
    const changed = await store.updateAgent(agent.id, { requestsPerMinute: 0, maxConcurrentRequests: 0 });
    expect(changed?.requestsPerMinute ?? 0).toBe(0);
    expect(changed?.maxConcurrentRequests ?? 0).toBe(0);
    expect(policyRevision(changed!).id).toBe(policyRevision({ ...agent, requestsPerMinute: 0, maxConcurrentRequests: 0 }).id);
    await store.migrate();
    expect(await store.getAgent(agent.id)).toEqual(changed);
  }));
});
