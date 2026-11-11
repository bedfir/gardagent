import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryStore, verifyChain, type Agent, type ReservationMeta, type Store } from "@gardagent/core";
import { PgStore } from "../src/pg-store.js";

const url = process.env.TEST_DATABASE_URL;
const DAY = "2026-01-02";
const TTL = 150_000;
const meta: ReservationMeta = { action: "chat.completions", model: "gpt-4o-mini", requestHash: "req-hash-1" };

interface Harness {
  /** Stores that share one database (two gateway instances); one entry for the memory store. */
  stores: Store[];
  agent(): Promise<string>;
  /** Makes a reservation older than the TTL. */
  age(reservationId: string): Promise<void>;
  /** Ledger rows of the agent. */
  rows(agentId: string): Promise<Awaited<ReturnType<Store["listLedger"]>>>;
  chainValid(): Promise<boolean>;
}

function suite(name: string, make: () => Promise<Harness>, skip = false) {
  describe.skipIf(skip)(`interrupted calls: ${name}`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await make();
    });
    afterEach(() => vi.restoreAllMocks());

    it("an orphan reservation becomes exactly one interrupted_no_response row, its estimate counted once", async () => {
      const agentId = await h.agent();
      const store = h.stores[0]!;
      const rid = (await store.reserve(agentId, DAY, 1234, 10_000_000, TTL, meta))!;
      await h.age(rid);
      await store.housekeeping(TTL);
      const rows = await h.rows(agentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        agentId,
        action: "chat.completions",
        model: "gpt-4o-mini",
        requestHash: "req-hash-1",
        verdict: "allowed",
        reason: "interrupted_no_response",
        promptTokens: 0,
        completionTokens: 0,
        cost: 1234,
        responseHash: null,
      });
      expect(rows[0]).not.toHaveProperty("degraded");
      expect(await store.getSpent(agentId, DAY)).toBe(1234);
      expect(await store.getReserved(agentId, DAY, TTL)).toBe(0);
      expect(await h.chainValid()).toBe(true);
    });

    it("a live reservation is untouched", async () => {
      const agentId = await h.agent();
      const store = h.stores[0]!;
      await store.reserve(agentId, DAY, 700, 10_000_000, TTL, meta);
      await store.housekeeping(TTL);
      expect(await h.rows(agentId)).toHaveLength(0);
      expect(await store.getReserved(agentId, DAY, TTL)).toBe(700);
      expect(await store.getSpent(agentId, DAY)).toBe(0);
    });

    it("running housekeeping twice, then from two stores at once, still gives one row per orphan", async () => {
      const agentId = await h.agent();
      const store = h.stores[0]!;
      const rid = (await store.reserve(agentId, DAY, 900, 10_000_000, TTL, meta))!;
      await h.age(rid);
      await store.housekeeping(TTL);
      await store.housekeeping(TTL);
      expect(await h.rows(agentId)).toHaveLength(1);

      for (let i = 0; i < 4; i += 1) {
        const id = (await store.reserve(agentId, DAY, 100, 10_000_000, TTL, meta))!;
        await h.age(id);
      }
      const second = h.stores[1] ?? store;
      await Promise.all([store.housekeeping(TTL), second.housekeeping(TTL), store.housekeeping(TTL), second.housekeeping(TTL)]);
      expect(await h.rows(agentId)).toHaveLength(5);
      expect(await store.getSpent(agentId, DAY)).toBe(900 + 400);
      expect(await h.chainValid()).toBe(true);
    });

    it("a normally settled or released call produces no interrupted row", async () => {
      const agentId = await h.agent();
      const store = h.stores[0]!;
      const settled = (await store.reserve(agentId, DAY, 500, 10_000_000, TTL, meta))!;
      await store.settleReservation(settled, agentId, DAY, 120, randomUUID());
      const released = (await store.reserve(agentId, DAY, 500, 10_000_000, TTL, meta))!;
      await store.releaseReservation(released);
      await h.age(settled);
      await h.age(released);
      await store.housekeeping(TTL);
      expect(await h.rows(agentId)).toHaveLength(0);
      expect(await store.getSpent(agentId, DAY)).toBe(120);
    });

    it("a reservation without metadata still leaves a row", async () => {
      const agentId = await h.agent();
      const store = h.stores[0]!;
      const rid = (await store.reserve(agentId, DAY, 300, 10_000_000, TTL))!;
      await h.age(rid);
      await store.housekeeping(TTL);
      const rows = await h.rows(agentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ reason: "interrupted_no_response", model: null, requestHash: null, cost: 300 });
    });
  });
}

suite("MemoryStore", async () => {
  const store = new MemoryStore();
  return {
    stores: [store],
    agent: async () => {
      const id = randomUUID();
      const agent: Agent = { id, name: "a", keyHash: id, allowedModels: ["*"], allowedTools: [], approvalTools: [], dailyBudget: 0, active: true };
      await store.createAgent(agent);
      return id;
    },
    age: async (id) => {
      // The timestamp is private: reach it through the map to make the reservation older than the TTL.
      const map = (store as unknown as { reservations: Map<string, { at: number }> }).reservations;
      const r = map.get(id);
      if (r) r.at = Date.now() - TTL - 1000;
    },
    rows: async (agentId) => store.listLedger({ agentId }),
    chainValid: async () => verifyChain(await store.listLedger()).valid,
  };
});

let pool: pg.Pool;
let pool2: pg.Pool;
suite(
  "PgStore (PostgreSQL)",
  async () => {
    const boot = new pg.Pool({ connectionString: url });
    await boot.query("DROP SCHEMA IF EXISTS interrupted_test CASCADE");
    await boot.query("CREATE SCHEMA interrupted_test");
    await boot.end();
    pool = new pg.Pool({ connectionString: url, options: "-c search_path=interrupted_test" });
    pool2 = new pg.Pool({ connectionString: url, options: "-c search_path=interrupted_test" });
    const a = new PgStore(pool);
    const b = new PgStore(pool2);
    await a.migrate();
    await a.migrate(); // idempotent
    return {
      stores: [a, b],
      agent: async () => {
        const id = randomUUID();
        await a.createAgent({ id, name: "a", keyHash: "h-" + id, allowedModels: ["*"], allowedTools: [], approvalTools: [], dailyBudget: 10_000_000, active: true });
        return id;
      },
      age: async (id) => {
        await pool.query("UPDATE agent_reservations SET created_at = now() - interval '10 minutes' WHERE id = $1", [id]);
      },
      rows: async (agentId) => a.listLedger({ agentId, limit: 10_000 }),
      chainValid: async () => verifyChain(await a.listLedger({ limit: 100_000 })).valid,
    };
  },
  !url,
);

afterAll(async () => {
  await pool?.end();
  await pool2?.end();
});

async function freshSchema(name: string): Promise<pg.Pool> {
  const boot = new pg.Pool({ connectionString: url });
  await boot.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await boot.query(`CREATE SCHEMA ${name}`);
  await boot.end();
  return new pg.Pool({ connectionString: url, options: `-c search_path=${name}` });
}

describe.skipIf(!url)("interrupted calls: PostgreSQL specifics", () => {
  it("rolls back entirely when the row cannot be written: the reservation stays for the next tick", async () => {
    const p = await freshSchema("interrupted_test2");
    const store = new PgStore(p);
    await store.migrate();
    const id = randomUUID();
    await store.createAgent({ id, name: "a", keyHash: "h-" + id, allowedModels: ["*"], allowedTools: [], approvalTools: [], dailyBudget: 10_000_000, active: true });
    const rid = (await store.reserve(id, DAY, 400, 10_000_000, TTL, meta))!;
    await p.query("UPDATE agent_reservations SET created_at = now() - interval '10 minutes' WHERE id = $1", [rid]);
    // Make the spend step fail (inside the same transaction as the ledger row): everything must roll back.
    await p.query("CREATE FUNCTION fail_spend() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'spend down'; END; $$ LANGUAGE plpgsql");
    await p.query("CREATE TRIGGER fail_spend BEFORE INSERT OR UPDATE ON agent_spend FOR EACH ROW EXECUTE FUNCTION fail_spend()");
    await expect(store.housekeeping(TTL)).rejects.toThrow(/spend down/);
    expect((await p.query("SELECT id FROM agent_reservations WHERE id = $1", [rid])).rows).toHaveLength(1);
    expect(await store.listLedger({ agentId: id })).toHaveLength(0);
    await p.query("DROP TRIGGER fail_spend ON agent_spend");
    await store.housekeeping(TTL); // next tick
    expect(await store.listLedger({ agentId: id })).toHaveLength(1);
    expect(await store.getSpent(id, DAY)).toBe(400);
    await p.end();
  });

  it("the migration adds the reservation metadata columns idempotently on an older table", async () => {
    const p = await freshSchema("interrupted_test3");
    const store = new PgStore(p);
    await store.migrate();
    await p.query("ALTER TABLE agent_reservations DROP COLUMN action, DROP COLUMN model, DROP COLUMN request_hash");
    await store.migrate();
    await store.migrate();
    const cols = await p.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'interrupted_test3' AND table_name = 'agent_reservations'",
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(expect.arrayContaining(["action", "model", "request_hash"]));
    await p.end();
  });
});
