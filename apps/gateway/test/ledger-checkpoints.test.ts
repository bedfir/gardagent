import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, MemoryStore, verifyChain, type LedgerEntry, type LedgerInput, type Store } from "@gardagent/core";
import { buildApp } from "../src/app.js";
import { PgStore } from "../src/pg-store.js";
import { adminHeaders, config } from "./helpers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const input = (n: number): LedgerInput => ({
  ts: "2026-11-12T00:00:00.000Z", agentId: null, action: `test.${n}`, model: null,
  verdict: "allowed", reason: null, upstreamStatus: null, promptTokens: 0,
  completionTokens: 0, cost: 0, requestHash: null, responseHash: null,
});

for (const backend of ["memory", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !databaseUrl)(`ledger checkpoints: ${backend}`, () => {
    let store: Store;
    let writer: Store;
    let app: ReturnType<typeof buildApp>;
    let pool: pg.Pool | undefined;
    let writerPool: pg.Pool | undefined;
    let admin: pg.Pool | undefined;
    let schema: string;
    beforeEach(async () => {
      if (backend === "postgres") {
        schema = `checkpoint_${randomUUID().replaceAll("-", "")}`;
        admin = new pg.Pool({ connectionString: databaseUrl });
        await admin.query(`CREATE SCHEMA ${schema}`);
        pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
        writerPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
        const pgStore = new PgStore(pool);
        await pgStore.migrate();
        store = pgStore;
        writer = new PgStore(writerPool);
      } else {
        store = new MemoryStore();
        writer = store;
      }
      app = buildApp({ config, store });
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await app?.close();
      await writerPool?.end();
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
      pool = writerPool = admin = undefined;
    });
    const get = (url: string) => app.inject({ method: "GET", url, headers: adminHeaders });
    const check = (payload: unknown) => app.inject({ method: "POST", url: "/admin/ledger/verify", headers: adminHeaders, payload: payload as Record<string, unknown> });
    const page = async (query = "") => {
      const response = await get(`/admin/ledger/export.ndjson${query}`);
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("application/x-ndjson");
      const [metadata, ...entries] = response.body.trim().split("\n").map((line) => JSON.parse(line));
      return { metadata, entries: entries as LedgerEntry[] };
    };
    async function seed(count: number, offset = 0) {
      for (let n = 1; n <= count; n++) await writer.appendLedger(input(n + offset));
    }
    async function replace(count: number, offset = 0) {
      if (pool) {
        // Privileged damage simulation; application writes cannot remove ledger rows.
        await pool.query("TRUNCATE ledger CASCADE");
      } else {
        await app.close();
        store = new MemoryStore();
        writer = store;
        app = buildApp({ config, store });
      }
      await seed(count, offset);
    }

    it("exports exactly the captured chain while another connection appends", async () => {
      await seed(5);
      const original = await store.listLedger();
      const read = store.listLedger.bind(store);
      let appended = false;
      vi.spyOn(store, "listLedger").mockImplementation(async (query) => {
        // The head has been captured before either the anchor or page read.
        if (!appended) { appended = true; await writer.appendLedger(input(99)); }
        return read(query);
      });
      const first = await page("?limit=2");
      const checkpoint = first.metadata.checkpoint;
      expect(checkpoint.sequence).toBe(5);
      expect(checkpoint.head_hash).toBe(original[4]!.hash);
      const all = [...first.entries];
      let cursor = first.metadata.nextAfterSeq;
      while (cursor !== null) {
        const next = await page(`?limit=2&afterSeq=${cursor}&headSequence=${checkpoint.sequence}&headHash=${checkpoint.head_hash}`);
        all.push(...next.entries);
        cursor = next.metadata.nextAfterSeq;
      }
      expect(all).toEqual(original);
      expect(verifyChain(all).valid).toBe(true);
      expect((await store.ledgerHead()).sequence).toBe(6);
      expect((await check(checkpoint)).json()).toMatchObject({ valid: true, checkpointContained: true });
    });

    it("handles empty, exact and partial page boundaries and rejects invalid cursors", async () => {
      const empty = await page();
      expect(empty.metadata).toMatchObject({ checkpoint: { sequence: 0, head_hash: GENESIS_HASH }, nextAfterSeq: null });
      expect(empty.entries).toEqual([]);
      await seed(4);
      const first = await page("?limit=2");
      const c = first.metadata.checkpoint;
      const suffix = `&headSequence=${c.sequence}&headHash=${c.head_hash}`;
      expect(first.entries.map((e) => e.seq)).toEqual([1, 2]);
      const last = await page(`?limit=2&afterSeq=2${suffix}`);
      expect(last.entries.map((e) => e.seq)).toEqual([3, 4]);
      expect(last.metadata.nextAfterSeq).toBeNull();
      expect((await page(`?afterSeq=4${suffix}`)).entries).toEqual([]);
      expect((await page("?limit=3")).metadata.nextAfterSeq).toBe(3);
      for (const q of ["limit=0", "limit=1001", "afterSeq=1", "afterSeq=-1", "headSequence=2", "limit=2&limit=3", "headSequence=9007199254740991&headHash=" + GENESIS_HASH]) {
        expect((await get(`/admin/ledger/export.ndjson?${q}`)).statusCode).toBe(400);
      }
      expect((await get(`/admin/ledger/export.ndjson?headSequence=4&headHash=${GENESIS_HASH}`)).statusCode).toBe(409);
      expect((await check({ ...c, format: "unknown" })).statusCode).toBe(400);
      for (const url of ["/admin/ledger/checkpoint", "/admin/ledger/export.ndjson"]) {
        expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      }
      expect((await app.inject({ method: "POST", url: "/admin/ledger/verify", payload: c })).statusCode).toBe(401);
    });

    it("reports a chain truncated below an external checkpoint", async () => {
      await seed(4);
      const checkpoint = (await get("/admin/ledger/checkpoint")).json();
      await replace(2);
      expect((await check(checkpoint)).json()).toMatchObject({ valid: true, checked: 2, checkpointContained: false });
    });

    it("reports a valid fully rewritten chain against an old checkpoint", async () => {
      await seed(4);
      const checkpoint = (await get("/admin/ledger/checkpoint")).json();
      await replace(5, 100);
      expect((await check(checkpoint)).json()).toMatchObject({ valid: true, checked: 5, checkpointContained: false });
    });
  });
}
