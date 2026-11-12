import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore, policyRevision, sha256, verifyChain, type Store } from "@gardagent/core";
import { buildApp } from "../src/app.js";
import { PgStore } from "../src/pg-store.js";
import { adminHeaders, config, fakeFetch, jsonResponse, waitUntil } from "./helpers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

for (const backend of ["memory", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !databaseUrl)(`mandate: ${backend}`, () => {
    async function fixture(run: (app: ReturnType<typeof buildApp>, store: Store, forwarded: unknown[], blockLedger: () => Promise<() => Promise<void>>) => Promise<void>) {
      const schema = `mandate_${randomUUID().replaceAll("-", "")}`;
      const admin = backend === "postgres" ? new pg.Pool({ connectionString: databaseUrl }) : null;
      const pool = backend === "postgres" ? new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` }) : null;
      const store = pool ? new PgStore(pool) : new MemoryStore();
      if (admin) await admin.query(`CREATE SCHEMA ${schema}`);
      if (store instanceof PgStore) await store.migrate();
      const upstream = fakeFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }));
      let logs = "";
      const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
      const app = buildApp({ logger: { stream }, config: { ...config, mcpServers: { local: { url: "http://fake.test", headers: {} } } }, store, fetch: upstream.fetch });
      try {
        const blockLedger = async () => {
          if (pool) {
            await pool.query(`CREATE FUNCTION test_block_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test ledger blocked'; END $$;
              CREATE TRIGGER test_block_ledger BEFORE INSERT ON ledger FOR EACH ROW EXECUTE FUNCTION test_block_ledger()`);
            return async () => { await pool.query("DROP TRIGGER test_block_ledger ON ledger"); };
          }
          type Inner = { appendNow: (...args: unknown[]) => Promise<unknown> };
          const spy = vi.spyOn(store as unknown as Inner, "appendNow").mockRejectedValue(new Error("test ledger blocked"));
          return async () => { spy.mockRestore(); };
        };
        await run(app, store, upstream.calls, blockLedger);
        // The same real logger used by routes must redact credentials even if headers are explicitly logged.
        const issued = await app.inject({ method: "POST", url: "/admin/operators", headers: adminHeaders, payload: { label: "log-test" } });
        const token = issued.json().token as string;
        await app.inject({ url: "/admin/agents", headers: { authorization: `Bearer ${token}` } });
        app.log.info({ req: { headers: { authorization: `Bearer ${token}` } } }, "credential redaction test");
        expect(logs).not.toContain(token);
        expect(logs).not.toContain(sha256(token));
      }
      finally {
        vi.restoreAllMocks();
        await app.close();
        if (pool) await pool.end();
        if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
      }
    }
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });
    async function operator(app: ReturnType<typeof buildApp>, label: string) {
      const res = await app.inject({ method: "POST", url: "/admin/operators", headers: adminHeaders, payload: { label } });
      expect(res.statusCode).toBe(201);
      expect(res.headers["cache-control"]).toBe("no-store");
      return res.json() as { operator: { id: string }; token: string };
    }

    it("refuses revoked tokens, returns credentials once, and attributes administration", async () => fixture(async (app, store) => {
      const created = await operator(app, "test-operator");
      expect(created.token).toMatch(/^gaop_/);
      expect((await store.findOperator(sha256(created.token)))?.id).toBe(created.operator.id);
      expect(await store.findOperator(sha256(created.token + "wrong"))).toBeNull();
      const headers = auth(created.token);
      expect((await app.inject({ url: "/admin/agents", headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/admin/operators", headers, payload: { label: "forbidden" } })).statusCode).toBe(403);
      const revoked = await app.inject({ method: "POST", url: `/admin/operators/${created.operator.id}/revoke`, headers: adminHeaders });
      expect(revoked.statusCode).toBe(200);
      expect((await app.inject({ url: "/admin/agents", headers })).statusCode).toBe(401);
      expect(await store.findOperator(sha256(created.token))).toBeNull();
      const list = await app.inject({ url: "/admin/operators", headers: adminHeaders });
      expect(list.json().operators[0]).toMatchObject({ id: created.operator.id, label: "test-operator", revokedAt: expect.any(String) });
      const rows = await store.listLedger();
      expect(rows.map((row) => [row.action, row.operatorId])).toEqual([["admin.operator.create", "bootstrap"], ["admin.operator.revoke", "bootstrap"]]);
      const visible = JSON.stringify([rows, list.json(), await store.listOperators()]);
      expect(visible).not.toContain(created.token);
      expect(visible).not.toContain(sha256(created.token));
      expect(verifyChain(rows).valid).toBe(true);
    }));

    it("keeps the admission revision while pending and distinguishes two deciding operators", async () => fixture(async (app, store, forwarded) => {
      const alice = await operator(app, "alice-test");
      const bob = await operator(app, "bob-test");
      const created = await app.inject({ method: "POST", url: "/admin/agents", headers: auth(alice.token), payload: {
        name: "mandate-agent", allowedModels: ["*"], allowedTools: ["local/*"], approvalTools: [], dailyBudgetUsd: 1,
      } });
      expect(created.statusCode).toBe(201);
      const { agent, key } = created.json() as { agent: { id: string; policyRev: string }; key: string };
      const start = (n: number) => app.inject({ method: "POST", url: "/mcp/local", headers: auth(key), payload: {
        jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "write", arguments: { n } },
      } }).then((res) => res);
      const first = start(1);
      const a = (await waitUntil(() => store.listApprovals({ status: "pending" }), (rows) => rows.length === 1))[0]!;
      expect(forwarded).toHaveLength(0);
      const updated = await app.inject({ method: "PATCH", url: `/admin/agents/${agent.id}`, headers: auth(bob.token), payload: { dailyBudgetUsd: 2, allowedTools: [] } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().agent.policyRev).not.toBe(agent.policyRev);
      const approve = await app.inject({ method: "POST", url: `/admin/approvals/${a.id}/approve`, headers: auth(alice.token) });
      expect(approve.statusCode).toBe(200);
      expect((await first).statusCode).toBe(200);
      expect(forwarded).toHaveLength(1);
      // Restore permission; this second admission uses the newer budget revision.
      await app.inject({ method: "PATCH", url: `/admin/agents/${agent.id}`, headers: auth(bob.token), payload: { allowedTools: ["local/*"] } });
      const second = start(2);
      const b = (await waitUntil(() => store.listApprovals({ status: "pending" }), (rows) => rows.length === 1))[0]!;
      expect((await app.inject({ method: "POST", url: `/admin/approvals/${b.id}/approve`, headers: auth(bob.token), payload: {} })).statusCode).toBe(200);
      await second;
      expect(forwarded).toHaveLength(2);
      expect((await store.getApproval(a.id))?.operatorId).toBe(alice.operator.id);
      expect((await store.getApproval(b.id))?.operatorId).toBe(bob.operator.id);
      const rows = await store.listLedger();
      const firstRows = rows.filter((row) => row.approvalRef === a.id);
      expect(firstRows.map((row) => row.action)).toEqual(["mcp.approval.requested", "mcp.approval.decided", "mcp.tools/call"]);
      expect(firstRows.every((row) => row.policyRev === agent.policyRev && row.requestHash === a.argsHash)).toBe(true);
      expect(firstRows[1]!.operatorId).toBe(alice.operator.id);
      expect(rows.find((row) => row.approvalRef === b.id && row.action === "mcp.approval.decided")?.operatorId).toBe(bob.operator.id);
      expect(rows.find((row) => row.action === "admin.agent.create")?.operatorId).toBe(alice.operator.id);
      expect(rows.filter((row) => row.action === "admin.agent.update").every((row) => row.operatorId === bob.operator.id)).toBe(true);
      const snapshot = await store.getPolicyRevision(agent.policyRev);
      expect(snapshot && sha256(snapshot)).toBe(agent.policyRev);
      expect(snapshot && JSON.parse(snapshot).dailyBudget).toBe(1_000_000);
      const duplicate = await app.inject({ method: "POST", url: `/admin/approvals/${a.id}/approve`, headers: auth(bob.token) });
      expect(duplicate.statusCode).toBe(409);
      expect(await store.listLedger()).toEqual(rows);
      const visible = JSON.stringify([rows, (await app.inject({ url: "/admin/approvals", headers: adminHeaders })).json()]);
      for (const token of [alice.token, bob.token]) {
        expect(visible).not.toContain(token);
        expect(visible).not.toContain(sha256(token));
      }
      expect(verifyChain(rows).valid).toBe(true);
    }));

    it("rolls back mutations when their ledger evidence fails", async () => fixture(async (app, store, forwarded, blockLedger) => {
      const created = await app.inject({ method: "POST", url: "/admin/agents", headers: adminHeaders, payload: {
        name: "rollback-test", allowedModels: ["*"], allowedTools: ["local/*"], dailyBudgetUsd: 1,
      } });
      const { agent, key } = created.json() as { agent: { id: string; policyRev: string }; key: string };
      const pending = app.inject({ method: "POST", url: "/mcp/local", headers: auth(key), payload: {
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write", arguments: {} },
      } }).then((res) => res);
      const approval = (await waitUntil(() => store.listApprovals({ status: "pending" }), (rows) => rows.length === 1))[0]!;
      const before = await store.listLedger();
      const unblock = await blockLedger();
      try {
        expect((await app.inject({ method: "POST", url: "/admin/operators", headers: adminHeaders, payload: { label: "failed-test" } })).statusCode).toBe(500);
        expect(await store.listOperators()).toEqual([]);
        expect((await app.inject({ method: "PATCH", url: `/admin/agents/${agent.id}`, headers: adminHeaders, payload: { dailyBudgetUsd: 9 } })).statusCode).toBe(500);
        expect((await store.getAgent(agent.id))?.dailyBudget).toBe(1_000_000);
        expect((await app.inject({ method: "POST", url: `/admin/approvals/${approval.id}/approve`, headers: adminHeaders })).statusCode).toBe(500);
        expect((await store.getApproval(approval.id))?.status).toBe("pending");
        expect(forwarded).toHaveLength(0);
        expect(await store.listLedger()).toEqual(before);
      } finally { await unblock(); }
      expect((await app.inject({ method: "POST", url: `/admin/approvals/${approval.id}/reject`, headers: adminHeaders })).statusCode).toBe(200);
      await pending;
      const decision = (await store.listLedger()).at(-1)!;
      expect(decision).toMatchObject({ approvalRef: approval.id, operatorId: "bootstrap", policyRev: agent.policyRev, verdict: "denied" });
    }));

    it("uses identical content addresses for sorted unique lists and excludes display names", async () => fixture(async (_app, store) => {
      const agent = { id: "test-policy", name: "test", keyHash: "fake-test-hash", allowedModels: ["b", "a", "b"], allowedTools: ["local/*"], approvalTools: [], dailyBudget: 1, active: true };
      await store.createAgent(agent);
      const before = policyRevision(agent);
      await store.updateAgent(agent.id, { name: "renamed", allowedModels: ["a", "b"] });
      expect(policyRevision((await store.getAgent(agent.id))!).id).toBe(before.id);
      expect(await store.getPolicyRevision(before.id)).toBe(before.canonical);
      const read = (await store.getAgent(agent.id))!;
      read.allowedTools.push("unpersisted/*");
      expect((await store.getAgent(agent.id))!.allowedTools).toEqual(["local/*"]);
      await Promise.all([store.updateAgent(agent.id, { name: "concurrent-rename" }), store.rotateAgentKey(agent.id, "fake-rotated-hash")]);
      expect(await store.getAgent(agent.id)).toMatchObject({ name: "concurrent-rename", keyHash: "fake-rotated-hash" });
      await store.updateAgent(agent.id, { active: false });
      expect(policyRevision((await store.getAgent(agent.id))!).id).not.toBe(before.id);
      expect(await store.getPolicyRevision(before.id)).toBe(before.canonical);
    }));
  });
}
