import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { verifyChain } from "@gardagent/core";
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
    expect((await pool.query("SELECT version FROM schema_migrations")).rows).toEqual([{ version: 1 }]);
    expect((await pool.query("SELECT count(*) FROM ledger")).rows[0].count).toBe("0");
    await expect(pool.query("DELETE FROM ledger")).resolves.toBeDefined();
    expect((await pool.query("SELECT 1 FROM pg_trigger WHERE tgrelid = 'ledger'::regclass AND tgname = 'ledger_no_update'")).rowCount).toBe(1);
  }));

  it("adopts populated 0.3.0 without changing rows, relation identities or trigger", async () => fixture(async (pool, store) => {
    await pool.query(legacy);
    await store.createAgent({ id: "old", name: "old", keyHash: "fake-key", allowedModels: ["*"], allowedTools: [], approvalTools: [], dailyBudget: 1000, active: true });
    await store.addSpend("old", "2026-11-12", 123);
    await store.appendLedger({ ts: "2026-11-12T00:00:00.000Z", agentId: "old", action: "test", model: null, verdict: "allowed", reason: null, upstreamStatus: null, promptTokens: 0, completionTokens: 0, cost: 123, requestHash: null, responseHash: null });
    const ledger = await store.listLedger();
    const before = await snapshot(pool);
    const trigger = (await pool.query("SELECT oid FROM pg_trigger WHERE tgrelid = 'ledger'::regclass AND tgname = 'ledger_no_update'")).rows;
    await store.migrate();
    expect((await snapshot(pool)).filter((row) => !row.relname.startsWith("schema_migrations"))).toEqual(before);
    expect((await pool.query("SELECT oid FROM pg_trigger WHERE tgrelid = 'ledger'::regclass AND tgname = 'ledger_no_update'")).rows).toEqual(trigger);
    expect(await store.listLedger()).toEqual(ledger);
    expect(verifyChain(await store.listLedger()).valid).toBe(true);
    expect(await store.getSpent("old", "2026-11-12")).toBe(123);
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
    await expect(migrateDatabase(pool, [...MIGRATIONS, { version: 2, name: "deliberate failure", up: async (client) => {
      await client.query("CREATE TABLE rollback_probe (id INTEGER)");
      await client.query("INSERT INTO spend_settlements (key) VALUES ('rollback-probe')");
      await client.query("SELECT deliberately_missing_function()");
    } }])).rejects.toThrow(/migration 2.*failed/);
    expect((await pool.query("SELECT to_regclass('rollback_probe') AS relation")).rows[0].relation).toBeNull();
    expect((await pool.query("SELECT * FROM spend_settlements")).rows).toEqual([]);
    expect((await pool.query("SELECT version FROM schema_migrations")).rows).toEqual([{ version: 1 }]);
    await store.migrate(); // failure released the advisory lock
  }));

  it("refuses a database newer than the executable", async () => fixture(async (pool, store) => {
    await store.migrate();
    await pool.query("INSERT INTO schema_migrations (version, name) VALUES (2, 'future')");
    await expect(store.migrate()).rejects.toThrow(/version 2 is newer than supported version 1/);
    expect((await pool.query("SELECT count(*) FROM schema_migrations")).rows[0].count).toBe("2");
  }));

  it("refuses incomplete unversioned schemas without repairing them", async () => fixture(async (pool, store) => {
    await pool.query(legacy);
    await pool.query("ALTER TABLE agents DROP COLUMN allowed_tools");
    await expect(store.migrate()).rejects.toThrow(/missing agents.allowed_tools/);
    expect((await pool.query("SELECT * FROM schema_migrations")).rows).toEqual([]);
  }));
});
