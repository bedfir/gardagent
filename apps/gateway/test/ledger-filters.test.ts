import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, type Agent, type LedgerEntry, type LedgerInput, type LedgerQuery, type Store } from "@gardagent/core";
import { buildApp } from "../src/app.js";
import { PgStore } from "../src/pg-store.js";
import { adminHeaders, config, fakeFetch, jsonResponse } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL;
// Dedicated schema: other PostgreSQL test files reset their own tables in parallel.
const SCHEMA = "ga_ledger_filters";

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

const midnight = (() => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
})();
/** Instant of the UTC day `n` days ago, at noon. */
const at = (n: number) => new Date(midnight - n * 86_400_000 + 12 * 3_600_000).toISOString();
const dayOf = (n: number) => at(n).slice(0, 10);

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

const agentOf = (id: string, name: string): Agent => ({
  id,
  name,
  keyHash: `hash-${randomUUID()}`,
  allowedModels: ["*"],
  allowedTools: [],
  approvalTools: [],
  dailyBudget: 0,
  active: true,
});

const ALPHA = randomUUID();
const BETA = randomUUID();
const GHOST = randomUUID(); // appears in the ledger but is not a registered agent

/** Oracle: the filter semantics written the plain way, on rows already read back from the store. */
function expected(rows: LedgerEntry[], q: LedgerQuery): number[] {
  return rows
    .filter(
      (e) =>
        (q.fromTs === undefined || e.ts >= q.fromTs) &&
        (q.beforeTs === undefined || e.ts < q.beforeTs) &&
        (q.agentId === undefined || e.agentId === q.agentId) &&
        (q.model === undefined || e.model === q.model) &&
        (q.verdict === undefined || e.verdict === q.verdict) &&
        (q.minCost === undefined || e.cost >= q.minCost) &&
        (q.maxCost === undefined || e.cost <= q.maxCost),
    )
    .map((e) => e.seq);
}

for (const backend of backends) {
  describe.skipIf(backend.skip)(`ledger filters (${backend.name})`, () => {
    let store: Store;
    let close: () => Promise<void>;
    let app: ReturnType<typeof buildApp>;
    let all: LedgerEntry[];

    beforeEach(async () => {
      ({ store, close } = await backend.make());
      await store.createAgent(agentOf(ALPHA, "alpha"));
      await store.createAgent(agentOf(BETA, "beta"));
      // 60 deterministic rows mixing agents, models, verdicts, costs and days.
      const agents = [ALPHA, BETA, null, GHOST];
      for (let i = 0; i < 60; i++) {
        await store.appendLedger(
          entry({
            ts: at(Math.floor(i / 4) % 4),
            agentId: agents[i % agents.length]!,
            model: i % 11 === 0 ? null : ["m1", "m2", "m3"][i % 3]!,
            verdict: i % 5 === 0 ? "denied" : "allowed",
            cost: (i % 7) * 250_000, // 0, 0.25, ... 1.5 USD
          }),
        );
      }
      all = await store.listLedger({ limit: 1000 });
      const f = fakeFetch(() => jsonResponse({ usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [] }));
      app = buildApp({ config, store, fetch: f.fetch });
    });

    afterEach(async () => {
      await app.close();
      await close();
    });

    const get = (path: string) => app.inject({ method: "GET", url: path, headers: adminHeaders });
    const seqs = (res: { json: () => any }): number[] => (res.json().entries as LedgerEntry[]).map((e) => e.seq);

    describe("Store.listLedger", () => {
      const cases: Array<[string, LedgerQuery]> = [
        ["agent", { agentId: ALPHA }],
        ["unknown agent", { agentId: "nobody" }],
        ["model", { model: "m2" }],
        ["verdict allowed", { verdict: "allowed" }],
        ["verdict denied", { verdict: "denied" }],
        ["minCost", { minCost: 750_000 }],
        ["maxCost", { maxCost: 500_000 }],
        ["cost range, bounds inclusive", { minCost: 250_000, maxCost: 250_000 }],
        ["zero cost", { minCost: 0, maxCost: 0 }],
        ["agent + model", { agentId: BETA, model: "m1" }],
        ["everything", { agentId: ALPHA, model: "m1", verdict: "allowed", minCost: 250_000, maxCost: 1_250_000 }],
        ["agent + dates", { agentId: GHOST, fromTs: dayOf(2), beforeTs: dayOf(0) }],
        ["verdict + cost + dates", { verdict: "denied", minCost: 250_000, fromTs: dayOf(3), beforeTs: dayOf(1) }],
        ["contradictory", { agentId: BETA, verdict: "denied", minCost: 1_500_000, maxCost: 1_500_000 }],
      ];

      it.each(cases)("%s matches the reference filter", async (_name, q) => {
        const want = expected(all, q);
        expect(want.length).toBeLessThan(all.length);
        expect((await store.listLedger({ ...q, limit: 1000 })).map((e) => e.seq)).toEqual(want);
        expect((await store.listLedger({ ...q, limit: 1000, order: "desc" })).map((e) => e.seq)).toEqual([...want].reverse());
      });

      it("the combined cases are not all trivially empty", async () => {
        for (const [, q] of cases.filter(([name]) => !["unknown agent", "contradictory"].includes(name))) {
          expect(expected(all, q).length, JSON.stringify(q)).toBeGreaterThan(0);
        }
      });

      it("a model filter never matches rows without a model", async () => {
        const rows = await store.listLedger({ model: "m1", limit: 1000 });
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.model === "m1")).toBe(true);
      });

      it("hostile values stay plain data", async () => {
        const hostile = "x'; DROP TABLE ledger; --";
        expect(await store.listLedger({ agentId: hostile, model: hostile })).toEqual([]);
        expect((await store.listLedger({ limit: 1000 })).length).toBe(all.length);
      });

      it.each(["asc", "desc"] as const)("pages stay stable under filters (%s): no duplicate, no gap", async (order) => {
        const q: LedgerQuery = { verdict: "allowed", minCost: 250_000, maxCost: 1_250_000 };
        const want = expected(all, q);
        const collected: number[] = [];
        let cursor: Partial<LedgerQuery> = order === "asc" ? { afterSeq: 0 } : {};
        for (;;) {
          const page = (await store.listLedger({ ...q, ...cursor, order, limit: 7 })).map((e) => e.seq);
          if (page.length === 0) break;
          collected.push(...page);
          const last = page.at(-1)!;
          cursor = order === "asc" ? { afterSeq: last } : { beforeSeq: last };
        }
        expect(collected).toEqual(order === "asc" ? want : [...want].reverse());
        expect(new Set(collected).size).toBe(collected.length);
      });

      it("rows appended between two pages do not shift the cursor", async () => {
        const q: LedgerQuery = { agentId: ALPHA };
        const first = await store.listLedger({ ...q, order: "desc", limit: 5 });
        await store.appendLedger(entry({ agentId: ALPHA }));
        const second = await store.listLedger({ ...q, order: "desc", limit: 5, beforeSeq: first.at(-1)!.seq });
        const full = expected(all, q).reverse();
        expect([...first, ...second].map((e) => e.seq)).toEqual(full.slice(0, 10));
      });
    });

    describe("Store.ledgerFacets", () => {
      it("returns the sorted distinct agent ids and models, without nulls", async () => {
        const facets = await store.ledgerFacets();
        expect(facets.agentIds).toEqual([ALPHA, BETA, GHOST].sort());
        expect(facets.models).toEqual(["m1", "m2", "m3"]);
      });

      it("is empty on an empty ledger", async () => {
        const empty = await backend.make();
        try {
          expect(await empty.store.ledgerFacets()).toEqual({ agentIds: [], models: [] });
        } finally {
          await empty.close();
        }
      });
    });

    describe("GET /admin/ledger", () => {
      const q = (params: Record<string, string>) => `/admin/ledger?${new URLSearchParams({ limit: "1000", ...params })}`;

      it("each filter alone", async () => {
        expect(seqs(await get(q({ agent: ALPHA })))).toEqual(expected(all, { agentId: ALPHA }));
        expect(seqs(await get(q({ model: "m3" })))).toEqual(expected(all, { model: "m3" }));
        expect(seqs(await get(q({ verdict: "denied" })))).toEqual(expected(all, { verdict: "denied" }));
        expect(seqs(await get(q({ verdict: "allowed" })))).toEqual(expected(all, { verdict: "allowed" }));
        expect(seqs(await get(q({ minCost: "0.75" })))).toEqual(expected(all, { minCost: 750_000 }));
        expect(seqs(await get(q({ maxCost: "0.5" })))).toEqual(expected(all, { maxCost: 500_000 }));
      });

      it("converts USD to micro-USD, inclusive on both ends", async () => {
        const res = await get(q({ minCost: "0.25", maxCost: "0.25" }));
        const costs = (res.json().entries as LedgerEntry[]).map((e) => e.cost);
        expect(costs.length).toBeGreaterThan(0);
        expect(new Set(costs)).toEqual(new Set([250_000]));
        expect(seqs(await get(q({ maxCost: "0" })))).toEqual(expected(all, { maxCost: 0 }));
        expect(seqs(await get(q({ minCost: "1", maxCost: "1.5" })))).toEqual(expected(all, { minCost: 1_000_000, maxCost: 1_500_000 }));
      });

      it("combined with each other (AND)", async () => {
        const res = await get(q({ agent: BETA, model: "m1", verdict: "allowed", minCost: "0.25", maxCost: "1.25" }));
        expect(res.statusCode).toBe(200);
        expect(seqs(res)).toEqual(expected(all, { agentId: BETA, model: "m1", verdict: "allowed", minCost: 250_000, maxCost: 1_250_000 }));
      });

      it("combined with the date range (inclusive UTC days) and with order", async () => {
        const want = expected(all, { agentId: ALPHA, fromTs: dayOf(2), beforeTs: dayOf(0) });
        expect(want.length).toBeGreaterThan(0);
        // `to` is inclusive: the day after it is the exclusive bound.
        const res = await get(q({ agent: ALPHA, from: dayOf(2), to: dayOf(1) }));
        expect(seqs(res)).toEqual(want);
        expect(seqs(await get(q({ agent: ALPHA, from: dayOf(2), to: dayOf(1), order: "desc" })))).toEqual([...want].reverse());
        expect(seqs(await get(q({ from: dayOf(0), to: dayOf(0) })))).toEqual(expected(all, { fromTs: dayOf(0) }));
      });

      it.each(["asc", "desc"] as const)("combined with pagination (%s): no duplicate, no gap", async (order) => {
        const params = { verdict: "allowed", minCost: "0.25", from: dayOf(3), to: dayOf(0) };
        const want = expected(all, { verdict: "allowed", minCost: 250_000, fromTs: dayOf(3) });
        const collected: number[] = [];
        let cursor: Record<string, string> = order === "asc" ? { afterSeq: "0" } : {};
        for (let guard = 0; guard < 50; guard++) {
          const page = seqs(await get(q({ ...params, ...cursor, order, limit: "6" })));
          if (page.length === 0) break;
          collected.push(...page);
          const last = String(page.at(-1));
          cursor = order === "asc" ? { afterSeq: last } : { beforeSeq: last };
        }
        expect(collected).toEqual(order === "asc" ? want : [...want].reverse());
      });

      it("limit applies after the filters", async () => {
        const res = await get(q({ agent: ALPHA, limit: "3" }));
        expect(seqs(res)).toEqual(expected(all, { agentId: ALPHA }).slice(0, 3));
      });

      it("empty parameters mean no filter", async () => {
        const res = await get(q({ agent: "", model: "", verdict: "", minCost: "", maxCost: "", from: "", to: "" }));
        expect(seqs(res)).toEqual(all.map((e) => e.seq));
      });

      it("an agent or model with no rows gives an empty list, not an error", async () => {
        const res = await get(q({ agent: "nobody", model: "no-such-model" }));
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ entries: [] });
      });

      it.each([
        ["verdict=maybe", /« verdict » must be « allowed » or « denied »/],
        ["verdict=ALLOWED", /« verdict »/],
        ["minCost=-1", /« minCost » must be a non-negative amount/],
        ["maxCost=-0.5", /« maxCost » must be a non-negative amount/],
        ["minCost=abc", /« minCost »/],
        ["maxCost=1e3", /« maxCost »/],
        ["minCost=0x10", /« minCost »/],
        ["minCost=NaN", /« minCost »/],
        ["maxCost=Infinity", /« maxCost »/],
        ["minCost=1,5", /« minCost »/],
        ["minCost=.5", /« minCost »/],
        ["minCost=%2B1", /« minCost »/],
        ["minCost=99999999999999999999", /« minCost »/],
        ["minCost=2&maxCost=1", /« minCost » must not exceed « maxCost »/],
        ["from=2026-13-01", /« from »/],
        ["to=abc", /« to »/],
        ["from=2026-05-02&to=2026-05-01", /« from » must precede « to »/],
        ["agent=a&agent=b", /« agent » must be given at most once/],
        ["verdict=allowed&verdict=denied", /« verdict » must be given at most once/],
      ])("invalid value (%s) -> 400 with a clear error", async (qs, message) => {
        const res = await get(`/admin/ledger?${qs}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatch(message);
      });

      it("requires the admin token", async () => {
        expect((await app.inject({ method: "GET", url: "/admin/ledger?agent=x" })).statusCode).toBe(401);
      });
    });

    describe("GET /admin/ledger/export.csv", () => {
      const csvSeqs = async (qs = "") => {
        const res = await get(`/admin/ledger/export.csv${qs ? `?${qs}` : ""}`);
        expect(res.statusCode).toBe(200);
        return res.rawPayload.toString("utf8").slice(1).split("\r\n").slice(1, -1).map((l) => Number(l.split(",")[0]));
      };

      it("applies exactly the same filters as the list", async () => {
        const sets: Array<Record<string, string>> = [
          { agent: ALPHA },
          { model: "m2" },
          { verdict: "denied" },
          { minCost: "0.5", maxCost: "1" },
          { agent: BETA, model: "m1", verdict: "allowed", minCost: "0.25" },
          { agent: GHOST, verdict: "allowed", from: dayOf(3), to: dayOf(1) },
        ];
        for (const params of sets) {
          const qs = new URLSearchParams(params);
          const list = seqs(await get(`/admin/ledger?${qs}&limit=1000`));
          expect(list.length, qs.toString()).toBeGreaterThan(0);
          expect(await csvSeqs(qs.toString()), qs.toString()).toEqual(list);
        }
      });

      it("shows the agent name and only matching rows", async () => {
        const res = await get(`/admin/ledger/export.csv?agent=${BETA}&verdict=denied`);
        const lines = res.rawPayload.toString("utf8").slice(1).split("\r\n").slice(1, -1).map((l) => l.split(","));
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.every((c) => c[2] === "beta" && c[5] === "denied")).toBe(true);
      });

      it("an empty selection still yields the header", async () => {
        const res = await get("/admin/ledger/export.csv?agent=nobody");
        expect(res.statusCode).toBe(200);
        expect(res.rawPayload.toString("utf8").slice(1)).toBe(
          "seq,timestamp,agent,action,model,verdict,reason,input_tokens,output_tokens,cost_usd,request_hash,response_hash,entry_hash\r\n",
        );
      });

      it.each(["verdict=maybe", "minCost=-1", "maxCost=abc", "minCost=3&maxCost=2", "agent=a&agent=b"])("invalid value (%s) -> 400", async (qs) => {
        expect((await get(`/admin/ledger/export.csv?${qs}`)).statusCode).toBe(400);
      });

      it("filters across several 1000-row pages without duplicate or gap", async () => {
        const more = 1005;
        for (let i = 0; i < more; i++) await store.appendLedger(entry({ agentId: i % 2 ? ALPHA : BETA, cost: 100 }));
        const rows = await store.listLedger({ limit: 5000 });
        const want = expected(rows, { agentId: ALPHA, minCost: 100, maxCost: 100 });
        expect(want.length).toBe(Math.floor(more / 2));
        expect(await csvSeqs(`agent=${ALPHA}&minCost=0.0001&maxCost=0.0001`)).toEqual(want);
        const allowed = expected(rows, { verdict: "allowed" });
        expect(allowed.length).toBeGreaterThan(1000);
        expect(await csvSeqs("verdict=allowed")).toEqual(allowed);
      }, 120_000);
    });

    describe("GET /admin/ledger/verify", () => {
      it("checks the full ledger whatever the filters", async () => {
        const plain = (await get("/admin/ledger/verify")).json();
        expect(plain).toMatchObject({ valid: true, checked: all.length });
        for (const qs of [`agent=${ALPHA}`, "verdict=denied&minCost=1", "model=nope", "from=2000-01-01&to=2000-01-02", "agent=a&agent=b", "verdict=bogus"]) {
          const res = await get(`/admin/ledger/verify?${qs}`);
          expect(res.statusCode, qs).toBe(200);
          expect(res.json(), qs).toEqual(plain);
        }
      });
    });

    describe("GET /admin/ledger/facets", () => {
      it("lists distinct agents (with names) and models", async () => {
        const res = await get("/admin/ledger/facets");
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.models).toEqual(["m1", "m2", "m3"]);
        expect(body.agents).toHaveLength(3);
        expect(body.agents.find((a: { id: string }) => a.id === ALPHA)).toEqual({ id: ALPHA, name: "alpha" });
        expect(body.agents.find((a: { id: string }) => a.id === BETA)).toEqual({ id: BETA, name: "beta" });
        // Sorted by name, then id; an id without a registered agent has a null name.
        expect(body.agents.find((a: { id: string }) => a.id === GHOST)).toEqual({ id: GHOST, name: null });
        const labels = body.agents.map((a: { id: string; name: string | null }) => a.name ?? a.id);
        expect(labels).toEqual([...labels].sort((x: string, y: string) => x.localeCompare(y)));
      });

      it("does not list registered agents that have no ledger row, nor sensitive fields", async () => {
        await store.createAgent(agentOf(randomUUID(), "silent"));
        const body = (await get("/admin/ledger/facets")).json();
        expect(body.agents.map((a: { name: string | null }) => a.name)).not.toContain("silent");
        expect(Object.keys(body).sort()).toEqual(["agents", "models"]);
        expect(JSON.stringify(body)).not.toMatch(/keyHash|hash-/);
      });

      it("requires the admin token", async () => {
        expect((await app.inject({ method: "GET", url: "/admin/ledger/facets" })).statusCode).toBe(401);
        expect((await app.inject({ method: "GET", url: "/admin/ledger/facets", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
      });
    });
  });
}

describe("verify ignores filters even when the broken row is filtered out (memory)", () => {
  it("still reports the break", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 6; i++) await store.appendLedger(entry({ agentId: i % 2 ? ALPHA : BETA, cost: i }));
    store._tamper(4, { cost: 999 }); // seq 4 belongs to ALPHA
    const f = fakeFetch(() => jsonResponse({}));
    const app = buildApp({ config, store, fetch: f.fetch });
    try {
      const res = await app.inject({ method: "GET", url: `/admin/ledger/verify?agent=${BETA}&maxCost=0.000001`, headers: adminHeaders });
      expect(res.json()).toMatchObject({ valid: false, brokenAtSeq: 4 });
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!url)("ledger indexes (PostgreSQL)", () => {
  it("creates the filter indexes", async () => {
    const { store, close } = await backends[1]!.make();
    void store;
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    try {
      const { rows } = await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'ledger' AND schemaname = $1", [SCHEMA]);
      const names = rows.map((r) => r.indexname);
      expect(names).toEqual(expect.arrayContaining(["ledger_agent_seq_idx", "ledger_model_seq_idx"]));
    } finally {
      await pool.end();
      await close();
    }
  });
});
