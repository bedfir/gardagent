import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashAgentKey, KeyHashCollisionError, MemoryStore, type LedgerInput, type Store } from "@gardagent/core";
import { agentCacheFor } from "../src/agent-cache.js";
import { buildApp } from "../src/app.js";
import { PgStore } from "../src/pg-store.js";
import { adminHeaders, config, createAgent, fakeFetch, jsonResponse } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL;
// Dedicated schema: other PostgreSQL test files reset their own schemas in parallel.
const SCHEMA = "ga_rotate_key";

interface Backend {
  name: string;
  skip: boolean;
  make: () => Promise<{ store: Store; close: () => Promise<void>; breakAudit: () => Promise<void> }>;
}

const backends: Backend[] = [
  { name: "memory", skip: false, make: async () => {
      const store = new MemoryStore();
      // Makes the append of a rotate-key audit row fail (other rows go through), like the PostgreSQL trigger below.
      const breakAudit = async () => {
        type Inner = { appendNow: (input: LedgerInput, options: object) => Promise<unknown> };
        const inner = store as unknown as Inner;
        const real = inner.appendNow.bind(store);
        vi.spyOn(inner, "appendNow").mockImplementation(async (input, options) => {
          if (input.action === "admin.agent.rotate-key") throw new Error("audit failed");
          return real(input, options);
        });
      };
      return { store, close: async () => undefined, breakAudit };
    },
  },
  {
    name: "PostgreSQL",
    skip: !url,
    make: async () => {
      const admin = new pg.Pool({ connectionString: url, max: 1 });
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
      await admin.end();
      const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
      const store = new PgStore(pool);
      await store.migrate();
      // Makes the insert of a rotate-key audit row fail inside PostgreSQL.
      const breakAudit = async () => {
        await pool.query(`CREATE FUNCTION ${SCHEMA}.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failed'; END $$`);
        await pool.query(
          `CREATE TRIGGER fail_audit BEFORE INSERT ON ${SCHEMA}.ledger FOR EACH ROW WHEN (NEW.action = 'admin.agent.rotate-key') EXECUTE FUNCTION ${SCHEMA}.fail_audit()`,
        );
      };
      return { store, close: () => pool.end(), breakAudit };
    },
  },
];

const today = new Date().toISOString().slice(0, 10);
const chatCall = (app: ReturnType<typeof buildApp>, key: string) =>
  app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${key}` },
    payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
  });

for (const backend of backends) {
  describe.skipIf(backend.skip)(`agent key rotation and spend check (${backend.name})`, () => {
    let store: Store;
    let close: () => Promise<void>;
    let breakAudit: () => Promise<void>;
    let app: ReturnType<typeof buildApp>;

    beforeEach(async () => {
      ({ store, close, breakAudit } = await backend.make());
      const f = fakeFetch(() => jsonResponse({ usage: { prompt_tokens: 100, completion_tokens: 50 }, choices: [] }));
      app = buildApp({ config, store, fetch: f.fetch });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await app.close();
      await close();
    });

    const get = (path: string) => app.inject({ method: "GET", url: path, headers: adminHeaders });
    const rotate = (id: string) => app.inject({ method: "POST", url: `/admin/agents/${id}/rotate-key`, headers: adminHeaders });
    const ledger = async () => (await get("/admin/ledger?limit=1000")).json().entries as Array<Record<string, any>>;

    describe("POST /admin/agents/:id/rotate-key", () => {
      it("requires the admin token", async () => {
        const { agent } = await createAgent(app);
        expect((await app.inject({ method: "POST", url: `/admin/agents/${agent.id}/rotate-key` })).statusCode).toBe(401);
        expect(
          (await app.inject({ method: "POST", url: `/admin/agents/${agent.id}/rotate-key`, headers: { authorization: "Bearer nope" } })).statusCode,
        ).toBe(401);
      });

      it("returns the new key once, no-store, with the same agent; old key refused and new key accepted at once", async () => {
        const { agent, key: oldKey } = await createAgent(app, { name: "bot", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 3 });
        expect((await chatCall(app, oldKey)).statusCode).toBe(200);

        const res = await rotate(agent.id);
        expect(res.statusCode).toBe(200);
        expect(res.headers["cache-control"]).toBe("no-store");
        const body = res.json();
        expect(body.key.startsWith("ga_")).toBe(true);
        expect(body.key).not.toBe(oldKey);
        expect(body.agent).toMatchObject({ id: agent.id, name: "bot", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 3, active: true });
        expect(body.agent).not.toHaveProperty("keyHash");

        expect((await chatCall(app, oldKey)).statusCode).toBe(401);
        expect((await chatCall(app, body.key)).statusCode).toBe(200);

        // The key is shown only in the rotation response, never by the list.
        const list = await get("/admin/agents");
        expect(list.body).not.toContain(body.key);
        expect(list.body).not.toContain(oldKey);
      });

      it("accepts an empty body sent with Content-Type: application/json, like no body at all", async () => {
        const { agent, key: oldKey } = await createAgent(app);
        const res = await app.inject({
          method: "POST",
          url: `/admin/agents/${agent.id}/rotate-key`,
          headers: { ...adminHeaders, "content-type": "application/json" },
          payload: "",
        });
        expect(res.statusCode).toBe(200);
        expect((await chatCall(app, oldKey)).statusCode).toBe(401);
        expect((await chatCall(app, res.json().key)).statusCode).toBe(200);
      });

      it("still rejects a malformed JSON body with 400", async () => {
        const { agent } = await createAgent(app);
        const res = await app.inject({
          method: "POST",
          url: `/admin/agents/${agent.id}/rotate-key`,
          headers: { ...adminHeaders, "content-type": "application/json" },
          payload: "{oops",
        });
        expect(res.statusCode).toBe(400);
      });

      it("keeps the history under the same agent id", async () => {
        const { agent, key: oldKey } = await createAgent(app);
        await chatCall(app, oldKey);
        const { key: newKey } = (await rotate(agent.id)).json();
        await chatCall(app, newKey);
        const calls = (await ledger()).filter((r) => r.action === "chat.completions");
        expect(calls).toHaveLength(2);
        expect(new Set(calls.map((r) => r.agentId))).toEqual(new Set([agent.id]));
        expect((await get("/admin/agents")).json().agents).toHaveLength(1);
        expect((await get("/admin/ledger/verify")).json()).toMatchObject({ valid: true });
      });

      it("writes an admin.agent.rotate-key audit row free of secrets", async () => {
        const { agent, key: oldKey } = await createAgent(app);
        const { key: newKey } = (await rotate(agent.id)).json();
        const rows = await ledger();
        expect(rows.map((r) => r.action)).toEqual(["admin.agent.create", "admin.agent.rotate-key"]);
        expect(rows[1]).toMatchObject({ agentId: agent.id, verdict: "allowed", cost: 0, model: null });
        const dump = JSON.stringify(rows);
        for (const secret of [oldKey, newKey, hashAgentKey(oldKey), hashAgentKey(newKey)]) expect(dump).not.toContain(secret);
      });

      it("drops the agent cache entry before answering", async () => {
        const { agent, key } = await createAgent(app);
        const cache = agentCacheFor(store);
        cache.remember(hashAgentKey(key), await store.getAgent(agent.id), cache.begin());
        expect(cache.size).toBe(1);
        expect((await rotate(agent.id)).statusCode).toBe(200);
        expect(cache.size).toBe(0);
      });

      it("drops the cache entry even if the write throws, and logs nothing", async () => {
        const { agent, key } = await createAgent(app);
        const cache = agentCacheFor(store);
        cache.remember(hashAgentKey(key), await store.getAgent(agent.id), cache.begin());
        vi.spyOn(store, "rotateAgentKey").mockRejectedValue(new Error("boom"));
        expect((await rotate(agent.id)).statusCode).toBe(500);
        expect(cache.size).toBe(0);
        expect((await ledger()).map((r) => r.action)).toEqual(["admin.agent.create"]);
      });

      it("is atomic with its audit row: if the audit fails, the old key stays valid and the new one is unknown", async () => {
        const { agent, key: oldKey } = await createAgent(app);
        await breakAudit();
        const hashes: string[] = [];
        const real = store.rotateAgentKey.bind(store);
        vi.spyOn(store, "rotateAgentKey").mockImplementation(async (id, hash, audit) => {
          hashes.push(hash);
          return real(id, hash, audit);
        });
        const res = await rotate(agent.id);
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain("ga_");
        expect(hashes).toHaveLength(1);
        // Old key still works, stored hash unchanged, the attempted hash was never stored.
        expect((await chatCall(app, oldKey)).statusCode).toBe(200);
        expect((await store.getAgent(agent.id))?.keyHash).toBe(hashAgentKey(oldKey));
        expect(await store.findAgentByKeyHash(hashes[0]!)).toBeNull();
        expect((await ledger()).map((r) => r.action)).not.toContain("admin.agent.rotate-key");
      });

      it("retries key generation on a hash collision", async () => {
        const { agent } = await createAgent(app);
        const real = store.rotateAgentKey.bind(store);
        const spy = vi.spyOn(store, "rotateAgentKey").mockImplementation(async (id, hash) => {
          if (spy.mock.calls.length === 1) throw new KeyHashCollisionError();
          return real(id, hash);
        });
        const res = await rotate(agent.id);
        expect(res.statusCode).toBe(200);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy.mock.calls[0]![1]).not.toBe(spy.mock.calls[1]![1]);
      });

      it("store: a hash already used by another agent is a KeyHashCollisionError and changes nothing", async () => {
        const a = await createAgent(app, { name: "a", allowedModels: ["x"], dailyBudgetUsd: 0, unlimited: true });
        const b = await createAgent(app, { name: "b", allowedModels: ["x"], dailyBudgetUsd: 0, unlimited: true });
        await expect(store.rotateAgentKey(b.agent.id, hashAgentKey(a.key))).rejects.toBeInstanceOf(KeyHashCollisionError);
        expect((await store.findAgentByKeyHash(hashAgentKey(b.key)))?.id).toBe(b.agent.id);
      });

      it("unknown agent -> 404, nothing logged", async () => {
        const res = await rotate("inconnu");
        expect(res.statusCode).toBe(404);
        expect(await ledger()).toHaveLength(0);
      });

      it("works on a disabled agent and leaves it disabled", async () => {
        const { agent, key: oldKey } = await createAgent(app);
        await app.inject({ method: "PATCH", url: `/admin/agents/${agent.id}`, headers: adminHeaders, payload: { active: false } });
        const res = await rotate(agent.id);
        expect(res.statusCode).toBe(200);
        expect(res.json().agent.active).toBe(false);
        expect((await store.getAgent(agent.id))?.active).toBe(false);
        expect((await chatCall(app, oldKey)).statusCode).toBe(401);
        const denied = await chatCall(app, res.json().key);
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error.code).toBe("agent_disabled");
      });
    });

    describe("GET /admin/spend-check", () => {
      it("requires the admin token", async () => {
        expect((await app.inject({ method: "GET", url: "/admin/spend-check" })).statusCode).toBe(401);
      });

      it("no divergence: empty list, also after real traffic", async () => {
        const { key } = await createAgent(app);
        await chatCall(app, key);
        await chatCall(app, key);
        const res = await get("/admin/spend-check");
        expect(res.statusCode).toBe(200);
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.json()).toEqual({ day: today, divergences: [] });
      });

      it("reports each divergent agent with both amounts, in both directions, and ignores other days", async () => {
        const a = await createAgent(app, { name: "alpha", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true });
        const b = await createAgent(app, { name: "beta", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true });
        const c = await createAgent(app, { name: "gamma", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true });
        const ok = await createAgent(app, { name: "fine", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true });
        const row = (agentId: string, cost: number, ts = new Date().toISOString()) =>
          store.appendLedger({
            ts, agentId, action: "chat.completions", model: "m", verdict: "allowed", reason: null, upstreamStatus: 200,
            promptTokens: 1, completionTokens: 1, cost, requestHash: "r", responseHash: "s",
          });
        // alpha: ledger 3_000_000, counter 1_000_000 (counter too low).
        await row(a.agent.id, 1_000_000);
        await row(a.agent.id, 2_000_000);
        await store.addSpend(a.agent.id, today, 1_000_000);
        // beta: counter without any ledger row.
        await store.addSpend(b.agent.id, today, 500_000);
        // gamma: ledger row without counter.
        await row(c.agent.id, 250_000);
        // fine: agree.
        await row(ok.agent.id, 400_000);
        await store.addSpend(ok.agent.id, today, 400_000);
        // Another day does not count (yesterday's ledger row, no counter).
        await row(ok.agent.id, 9_000_000, new Date(Date.now() - 2 * 86_400_000).toISOString());

        const { day, divergences } = (await get("/admin/spend-check")).json();
        expect(day).toBe(today);
        const byName = Object.fromEntries(divergences.map((d: any) => [d.name, d]));
        expect(Object.keys(byName).sort()).toEqual(["alpha", "beta", "gamma"]);
        expect(byName.alpha).toMatchObject({ agentId: a.agent.id, spentUsd: 1, ledgerUsd: 3 });
        expect(byName.beta).toMatchObject({ agentId: b.agent.id, spentUsd: 0.5, ledgerUsd: 0 });
        expect(byName.gamma).toMatchObject({ agentId: c.agent.id, spentUsd: 0, ledgerUsd: 0.25 });
      });
    });
  });
}
