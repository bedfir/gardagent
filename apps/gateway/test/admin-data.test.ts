import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, chainEntry, MemoryStore, sha256, type LedgerInput, type Store } from "@gardagent/core";
import { buildApp } from "../src/app.js";
import { PgStore } from "../src/pg-store.js";
import { adminHeaders, config, createAgent, fakeFetch, jsonResponse } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL;
// Dedicated schema: pg-store.test.ts resets the public schema tables in parallel.
const SCHEMA = "ga_admin_data";

interface Backend {
  name: string;
  skip: boolean;
  make: () => Promise<{ store: Store; close: () => Promise<void> }>;
}

const backends: Backend[] = [
  { name: "memory", skip: false, make: async () => ({ store: new MemoryStore(), close: async () => undefined }) },
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
      return { store, close: () => pool.end() };
    },
  },
];

const entry = (over: Partial<LedgerInput>): LedgerInput => ({
  ts: new Date().toISOString(),
  agentId: null,
  action: "chat.completions",
  model: "gpt-4o-mini",
  verdict: "allowed",
  reason: null,
  upstreamStatus: 200,
  promptTokens: 0,
  completionTokens: 0,
  cost: 0,
  requestHash: "r",
  responseHash: "s",
  ...over,
});

const midnight = (() => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
})();
/** Instant of the UTC day `n` days ago, at `ms` milliseconds after midnight. */
const at = (n: number, ms = 12 * 3_600_000) => new Date(midnight - n * 86_400_000 + ms).toISOString();
const dayOf = (n: number) => at(n, 0).slice(0, 10);

for (const backend of backends) {
  describe.skipIf(backend.skip)(`agent administration, statistics and export (${backend.name})`, () => {
    let store: Store;
    let close: () => Promise<void>;
    let app: ReturnType<typeof buildApp>;
    let upstreamCalls: number;

    beforeEach(async () => {
      ({ store, close } = await backend.make());
      upstreamCalls = 0;
      const f = fakeFetch(() => {
        upstreamCalls++;
        return jsonResponse({ usage: { prompt_tokens: 100, completion_tokens: 50 }, choices: [] });
      });
      app = buildApp({ config, store, fetch: f.fetch });
    });

    afterEach(async () => {
      await app.close();
      await close();
    });

    const get = (path: string) => app.inject({ method: "GET", url: path, headers: adminHeaders });
    const patch = (id: string, payload: unknown) =>
      app.inject({ method: "PATCH", url: `/admin/agents/${id}`, headers: adminHeaders, payload: payload as object });
    const ledger = async () => (await get("/admin/ledger?limit=1000")).json().entries as Array<Record<string, any>>;

    describe("authentification", () => {
      it.each([
        ["PATCH", "/admin/agents/x"],
        ["GET", "/admin/stats"],
        ["GET", "/admin/ledger/export.csv"],
      ] as const)("%s %s sans jeton -> 401", async (method, u) => {
        expect((await app.inject({ method, url: u })).statusCode).toBe(401);
      });
    });

    describe("paged ledger verification", () => {
      it.each(["valid v2", "v1 regression", "v1 with v2 fields"] as const)(
        "checks version ordering across one-row pages: %s",
        async (mode) => {
          await store.appendLedger(entry({}));
          await store.appendLedger(entry({}));
          const list = store.listLedger.bind(store);
          // Force a small effective page size without changing the production limit.
          // Rehash the second row to isolate content validation from hash validation.
          const read = vi.spyOn(store, "listLedger").mockImplementation(async (options) => {
            const rows = await list({ ...options, limit: 1 });
            return rows.map((row) => {
              if (row.seq !== 2 || mode === "valid v2") return row;
              const { seq, prevHash, hash: _hash, formatVersion: _version, ...input } = row;
              return chainEntry(seq, prevHash, {
                ...input,
                ...(mode === "v1 with v2 fields" ? { operatorId: "test-operator" } : {}),
              });
            });
          });
          try {
            const res = await get("/admin/ledger/verify");
            expect(res.statusCode).toBe(200);
            if (mode === "valid v2") {
              expect(res.json()).toMatchObject({ valid: true, checked: 2 });
              expect(read).toHaveBeenCalledTimes(3);
            } else {
              expect(res.json()).toMatchObject({
                valid: false, checked: 1, brokenAtSeq: 2, problem: "invalid_format",
              });
              expect(read).toHaveBeenCalledTimes(2);
            }
          } finally {
            read.mockRestore();
          }
        },
      );
    });

    describe("PATCH /admin/agents/:id", () => {
      it("updates fields, logs \"admin.agent.update\" and keeps a valid chain", async () => {
        const { agent } = await createAgent(app, { name: "bot", allowedModels: ["a"], dailyBudgetUsd: 1 });
        const res = await patch(agent.id, { active: false, dailyBudgetUsd: 5 });
        expect(res.statusCode).toBe(200);
        expect(res.json().agent).toMatchObject({ id: agent.id, active: false, dailyBudgetUsd: 5, name: "bot", allowedModels: ["a"] });

        const rows = await ledger();
        expect(rows.map((r) => r.action)).toEqual(["admin.agent.create", "admin.agent.update"]);
        expect(rows[1]).toMatchObject({
          agentId: agent.id,
          verdict: "allowed",
          reason: "active,dailyBudget",
          promptTokens: 0,
          completionTokens: 0,
          cost: 0,
          model: null,
        });
        expect(rows[1]!.requestHash).toBe(sha256(canonicalJson({ active: false, dailyBudget: 5_000_000 })));
        expect((await get("/admin/ledger/verify")).json()).toMatchObject({ valid: true, checked: 2 });
      });

      it("updates the name and allowed models", async () => {
        const { agent } = await createAgent(app);
        const res = await patch(agent.id, { name: "  nouveau  ", allowedModels: [" m1 ", "m2"] });
        expect(res.json().agent).toMatchObject({ name: "nouveau", allowedModels: ["m1", "m2"] });
        expect((await ledger()).at(-1)).toMatchObject({ reason: "name,allowedModels" });
      });

      it("agent creation is logged", async () => {
        const { agent } = await createAgent(app);
        const [row] = await ledger();
        expect(row).toMatchObject({ action: "admin.agent.create", agentId: agent.id, verdict: "allowed", cost: 0 });
      });

      it("a patch with no actual change logs nothing", async () => {
        const { agent } = await createAgent(app, { name: "bot", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 2 });
        const res = await patch(agent.id, { name: "bot", active: true, dailyBudgetUsd: 2 });
        expect(res.statusCode).toBe(200);
        expect(await ledger()).toHaveLength(1);
      });

      it("unknown agent -> 404", async () => {
        const res = await patch("inconnu", { active: false });
        expect(res.statusCode).toBe(404);
        expect(await ledger()).toHaveLength(0);
      });

      it.each([
        ["empty body", {}],
        ["negative budget", { dailyBudgetUsd: -1 }],
        ["text budget", { dailyBudgetUsd: "2" }],
        ["empty models", { allowedModels: [] }],
        ["non-string models", { allowedModels: [1] }],
        ["whitespace models", { allowedModels: [" "] }],
        ["empty name", { name: "  " }],
        ["non-boolean active", { active: "oui" }],
      ])("validation: %s -> 400 without log", async (_n, payload) => {
        const { agent } = await createAgent(app);
        const res = await patch(agent.id, payload);
        expect(res.statusCode).toBe(400);
        expect(await ledger()).toHaveLength(1);
      });

      it("a disabled agent gets 403 agent_disabled and the provider is not called", async () => {
        const { agent, key } = await createAgent(app);
        await patch(agent.id, { active: false });
        const res = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: `Bearer ${key}` },
          payload: { model: "gpt-4o-mini", messages: [] },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("agent_disabled");
        expect(upstreamCalls).toBe(0);
        await patch(agent.id, { active: true });
        const again = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: `Bearer ${key}` },
          payload: { model: "gpt-4o-mini", messages: [] },
        });
        expect(again.statusCode).toBe(200);
      });
    });

    describe("GET /admin/agents", () => {
      it("returns today's spend in dollars", async () => {
        const { agent, key } = await createAgent(app);
        expect((await get("/admin/agents")).json().agents[0].spentTodayUsd).toBe(0);
        await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: `Bearer ${key}` },
          payload: { model: "gpt-4o-mini", messages: [] },
        });
        const cost = (await ledger()).find((r) => r.action === "chat.completions")!.cost as number;
        expect(cost).toBeGreaterThan(0);
        const listed = (await get("/admin/agents")).json().agents[0];
        expect(listed.id).toBe(agent.id);
        expect(listed.spentTodayUsd).toBeCloseTo(cost / 1_000_000, 9);
      });
    });

    describe("GET /admin/stats", () => {
      async function seed() {
        const a = await createAgent(app, { name: "alpha", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true });
        const b = await createAgent(app, { name: "beta", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true });
        const rows: Array<Partial<LedgerInput>> = [
          { ts: at(0), agentId: a.agent.id, promptTokens: 10, completionTokens: 1, cost: 100 },
          { ts: at(0, 13 * 3_600_000), agentId: a.agent.id, promptTokens: 20, completionTokens: 2, cost: 200 },
          { ts: at(0), agentId: b.agent.id, promptTokens: 5, completionTokens: 5, cost: 50 },
          { ts: at(0), agentId: a.agent.id, verdict: "denied", reason: "budget_exceeded" },
          { ts: at(0), agentId: null, verdict: "denied", reason: "invalid_key", model: null },
          { ts: at(0), agentId: null, verdict: "denied", reason: "invalid_key", model: null },
          { ts: at(1), agentId: a.agent.id, promptTokens: 7, completionTokens: 3, cost: 400 },
          { ts: at(10), agentId: a.agent.id, promptTokens: 1, completionTokens: 1, cost: 1000 },
        ];
        for (const r of rows) await store.appendLedger(entry(r));
        return { a: a.agent.id, b: b.agent.id };
      }

      it("aggregates by UTC day and by agent, denial reasons included", async () => {
        const { a, b } = await seed();
        const res = await get("/admin/stats?days=7");
        expect(res.statusCode).toBe(200);
        const s = res.json();
        expect(s).toMatchObject({ days: 7, from: dayOf(6), to: dayOf(0) });
        expect(s.byDay.map((d: { day: string }) => d.day)).toEqual([6, 5, 4, 3, 2, 1, 0].map(dayOf));

        expect(s.totals.spentUsd).toBeCloseTo(750 / 1e6, 9);
        expect(s.totals).toMatchObject({
          allowed: 4,
          denied: 3,
          promptTokens: 42,
          completionTokens: 11,
          deniedByReason: { budget_exceeded: 1, invalid_key: 2 },
        });

        const today = s.byDay[6];
        expect(today).toMatchObject({ allowed: 3, denied: 3, promptTokens: 35, completionTokens: 8 });
        expect(today.spentUsd).toBeCloseTo(350 / 1e6, 9);
        const alpha = today.agents.find((x: { agentId: string | null }) => x.agentId === a);
        expect(alpha).toMatchObject({ name: "alpha", allowed: 2, denied: 1, deniedByReason: { budget_exceeded: 1 } });
        expect(alpha.spentUsd).toBeCloseTo(300 / 1e6, 9);
        expect(today.agents.find((x: { agentId: string | null }) => x.agentId === b)).toMatchObject({ name: "beta", allowed: 1 });
        expect(today.agents.find((x: { agentId: string | null }) => x.agentId === null)).toMatchObject({
          name: null,
          denied: 2,
          deniedByReason: { invalid_key: 2 },
        });

        const yesterday = s.byDay[5];
        expect(yesterday).toMatchObject({ allowed: 1, denied: 0, promptTokens: 7, completionTokens: 3 });
        expect(yesterday.spentUsd).toBeCloseTo(400 / 1e6, 9);
        // Days without activity: zeros, and the row from 10 days ago is outside the period.
        expect(s.byDay[0]).toMatchObject({ allowed: 0, denied: 0, spentUsd: 0, agents: [] });
        // Totals per agent, from highest to lowest spender.
        expect(s.agents.map((x: { name: string | null }) => x.name)).toEqual(["alpha", "beta", null]);
      });

      it("excludes admin.* actions (agent creation and update)", async () => {
        const { agent } = await createAgent(app);
        await patch(agent.id, { active: false });
        const s = (await get("/admin/stats")).json();
        expect(s.totals).toMatchObject({ allowed: 0, denied: 0, promptTokens: 0, completionTokens: 0, spentUsd: 0 });
        expect(s.agents).toEqual([]);
        expect((await ledger()).filter((r) => r.action.startsWith("admin.")).length).toBe(2);
      });

      it("days=30 includes older rows, days=1 only today", async () => {
        await seed();
        const long = (await get("/admin/stats?days=30")).json();
        expect(long.byDay).toHaveLength(30);
        expect(long.totals.spentUsd).toBeCloseTo(1750 / 1e6, 9);
        expect(long.totals.allowed).toBe(5);
        const one = (await get("/admin/stats?days=1")).json();
        expect(one.byDay).toHaveLength(1);
        expect(one.totals.allowed).toBe(3);
      });

      it("days defaults to 7", async () => {
        expect((await get("/admin/stats")).json().byDay).toHaveLength(7);
      });

      it.each(["0", "91", "abc", "1.5", "-3"])("days=%s -> 400", async (days) => {
        expect((await get(`/admin/stats?days=${days}`)).statusCode).toBe(400);
      });
    });

    describe("GET /admin/ledger/export.csv", () => {
      const csv = async (path = "/admin/ledger/export.csv") => {
        const res = await get(path);
        return { res, text: res.rawPayload.toString("utf8"), bytes: res.rawPayload };
      };

      it("starts with the UTF-8 BOM, uses a comma and English columns", async () => {
        const { agent } = await createAgent(app, { name: "bot", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true });
        await store.appendLedger(
          entry({ agentId: agent.id, promptTokens: 12, completionTokens: 34, cost: 123, requestHash: "rq", responseHash: "rs" }),
        );
        const { res, text, bytes } = await csv();
        expect(res.statusCode).toBe(200);
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(res.headers["content-type"]).toContain("text/csv");
        expect(res.headers["content-type"]).toContain("utf-8");
        expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="gardagent-journal-\d{4}-\d{2}-\d{2}\.csv"$/);

        const lines = text.slice(1).split("\r\n");
        expect(lines[0]).toBe(
          "seq,timestamp,agent,action,model,verdict,reason,input_tokens,output_tokens,cost_usd,request_hash,response_hash,entry_hash",
        );
        const cells = lines[2]!.split(",");
        expect(cells).toHaveLength(13);
        expect(cells[0]).toBe("2");
        expect(cells.slice(2, 10)).toEqual(["bot", "chat.completions", "gpt-4o-mini", "allowed", "", "12", "34", "0.000123"]);
        expect(cells.slice(10, 12)).toEqual(["rq", "rs"]);
        expect(cells[12]).toMatch(/^[0-9a-f]{64}$/);
        // Row 1: agent creation, logged like the other actions.
        expect(lines[1]!.split(",")[3]).toBe("admin.agent.create");
        expect(lines.at(-1)).toBe("");
      });

      it("escapes commas, quotes and line breaks, and neutralises formulas", async () => {
        const tricky = await createAgent(app, { name: 'Bot, "x"', allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true });
        const formula = await createAgent(app, { name: "=SUM(A1)", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true });
        await store.appendLedger(entry({ agentId: tricky.agent.id, model: 'm,1"2', reason: "line1\nline2" }));
        await store.appendLedger(entry({ agentId: formula.agent.id }));
        const { text } = await csv();
        expect(text).toContain('"Bot, ""x""",chat.completions,"m,1""2",allowed,"line1\nline2",');
        expect(text).toContain(",'=SUM(A1),chat.completions,");
      });

      it("from and to bounds are inclusive, in UTC days", async () => {
        const d = 3;
        await store.appendLedger(entry({ ts: at(d + 1, 86_400_000 - 1), model: "before" }));
        await store.appendLedger(entry({ ts: at(d, 0), model: "start" }));
        await store.appendLedger(entry({ ts: at(d, 86_400_000 - 1), model: "end" }));
        await store.appendLedger(entry({ ts: at(d - 1, 0), model: "after" }));
        const models = (text: string) => text.split("\r\n").slice(1, -1).map((l) => l.split(",")[4]);

        expect(models((await csv(`/admin/ledger/export.csv?from=${dayOf(d)}&to=${dayOf(d)}`)).text)).toEqual(["start", "end"]);
        expect(models((await csv(`/admin/ledger/export.csv?from=${dayOf(d)}`)).text)).toEqual(["start", "end", "after"]);
        expect(models((await csv(`/admin/ledger/export.csv?to=${dayOf(d)}`)).text)).toEqual(["before", "start", "end"]);
        expect(models((await csv(`/admin/ledger/export.csv?from=${dayOf(d + 1)}&to=${dayOf(d - 1)}`)).text)).toEqual([
          "before",
          "start",
          "end",
          "after",
        ]);
        expect(models((await csv(`/admin/ledger/export.csv?from=${dayOf(0)}&to=${dayOf(0)}`)).text)).toEqual([]);
      });

      it.each(["from=2026-13-01", "to=abc", "from=2026-02-30", "from=2026-05-02&to=2026-05-01", "from=26-5-1"])(
        "invalid bounds (%s) -> 400",
        async (qs) => {
          expect((await get(`/admin/ledger/export.csv?${qs}`)).statusCode).toBe(400);
        },
      );

      it("exports more than 1000 rows, read by pages, without duplicate or gap", async () => {
        const total = 1003;
        for (let i = 0; i < total; i++) await store.appendLedger(entry({ promptTokens: i }));
        const { text } = await csv();
        const lines = text.slice(1).split("\r\n");
        expect(lines).toHaveLength(total + 2); // header + rows + empty trailing line
        expect(lines.slice(1, -1).map((l) => Number(l.split(",")[0]))).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      }, 120_000);
    });
  });
}
