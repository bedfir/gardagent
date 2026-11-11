import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "@gardagent/core";
import { parseMcpServers } from "../src/config.js";
import { PgStore } from "../src/pg-store.js";
import { adminHeaders, nextPending, createAgent, jsonResponse, proxyLedger, setupWith, sseResponse } from "./helpers.js";

const servers = { gh: { url: "https://mcp.test/gh", headers: { authorization: "Bearer SECRET-MCP", "x-secret": "s3" }, readTools: ["search"] } };
const mixedServers = {
  erp: { url: "https://mcp.test/erp", headers: {}, readTools: ["read_work_order", "get_*"] },
};
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: "2.0", method, params, ...(id === null ? {} : { id }) });
const call = (name: string, args: unknown = { q: "sensitive-word" }) => rpc("tools/call", { name, arguments: args });
const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } };

function make(responder = () => jsonResponse(ok)) {
  return setupWith({ mcpServers: servers }, responder);
}
function makeMixed(responder = () => jsonResponse(ok)) {
  return setupWith({ mcpServers: mixedServers }, responder);
}
const post = (app: ReturnType<typeof make>["app"], key: string, payload: unknown, headers: Record<string, string> = {}, server = "gh") =>
  app.inject({ method: "POST", url: `/mcp/${server}`, headers: { authorization: `Bearer ${key}`, ...headers }, payload: payload as object });
const agentWith = (app: ReturnType<typeof make>["app"], allowedTools: string[]) =>
  createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools, dailyBudgetUsd: 0, unlimited: true });

describe("mcp: allowed tools", () => {
  it.each([["exact", ["gh/search"]], ["server wildcard", ["gh/*"]], ["global wildcard", ["*"]]])("%s -> relayed and logged", async (_n, tools) => {
    const { app, store, calls } = make();
    const { agent, key } = await agentWith(app, tools);
    const res = await post(app, key, call("search"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://mcp.test/gh");
    const [row] = await proxyLedger(store);
    expect(row).toMatchObject({
      agentId: agent.id,
      action: "mcp.tools/call",
      model: "gh/search#read",
      verdict: "allowed",
      reason: null,
      upstreamStatus: 200,
      cost: 0,
      promptTokens: 0,
    });
    expect(row!.requestHash).toBe(sha256(canonicalJson({ q: "sensitive-word" })));
    expect(row!.responseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await store.listLedger())).not.toContain("sensitive-word");
  });

  it.each([["empty list", []], ["other tool", ["gh/autre"]], ["other server", ["x/*"]]])("%s -> JSON-RPC error -32001 without call", async (_n, tools) => {
    const { app, store, calls } = make();
    const { key } = await agentWith(app, tools);
    const res = await post(app, key, call("search"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32001 } });
    expect(res.json().error.message).toContain("not allowed");
    expect(calls).toHaveLength(0);
    expect((await proxyLedger(store))[0]).toMatchObject({ action: "mcp.tools/call", model: "gh/search#read", verdict: "denied", reason: "tool_not_allowed", upstreamStatus: null });
  });

  it("tools/list, initialize and notifications pass without ledger", async () => {
    const { app, store, calls } = make();
    const { key } = await agentWith(app, []);
    await post(app, key, rpc("initialize", {}));
    await post(app, key, rpc("tools/list"));
    const note = await post(app, key, rpc("notifications/initialized", undefined, null));
    expect(calls.map((c) => c.body.method)).toEqual(["initialize", "tools/list", "notifications/initialized"]);
    expect(note.statusCode).toBe(200);
    expect(await proxyLedger(store)).toHaveLength(0);
  });
});

describe("mcp: invalid requests and authentication", () => {
  it("JSON-RPC batch rejected with a clear error", async () => {
    const { app, calls } = make();
    const { key } = await agentWith(app, ["*"]);
    const res = await post(app, key, [call("a"), call("b")]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(res.json().error.message).toContain("batches");
    expect(calls).toHaveLength(0);
  });

  it("invalid key -> 401 and ledger invalid_key; unknown server -> 404", async () => {
    const { app, store, calls } = make();
    expect((await post(app, "ga_cle-inexistante-pour-le-test", call("x"))).statusCode).toBe(401);
    expect((await proxyLedger(store))[0]).toMatchObject({ reason: "invalid_key", verdict: "denied" });
    const { key } = await agentWith(app, ["*"]);
    expect((await post(app, key, call("x"), {}, "inconnu")).statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("without a configured server, the /mcp route does not exist", async () => {
    const { app } = setupWith({ mcpServers: {} });
    expect((await app.inject({ method: "POST", url: "/mcp/gh", payload: {} })).statusCode).toBe(404);
  });
});

describe("mcp: headers", () => {
  it("server secrets go to the server, never to the client; the agent key is never transmitted", async () => {
    const { app, calls } = make(() => new Response(JSON.stringify(ok), { headers: { "content-type": "application/json", "x-secret": "fuite", "set-cookie": "a=b" } }));
    const { key } = await agentWith(app, ["*"]);
    const res = await post(app, key, call("search"));
    expect(calls[0]!.headers.authorization).toBe("Bearer SECRET-MCP");
    expect(calls[0]!.headers["x-secret"]).toBe("s3");
    expect(JSON.stringify(calls[0]!.headers)).not.toContain(key);
    expect(JSON.stringify(res.headers)).not.toContain("SECRET-MCP");
    expect(res.body).not.toContain("SECRET-MCP");
    expect(res.headers["x-secret"]).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("Mcp-Session-Id and MCP-Protocol-Version relayed in both directions", async () => {
    const { app, calls } = make(() => new Response(JSON.stringify(ok), { headers: { "content-type": "application/json", "mcp-session-id": "sess-serveur", "mcp-protocol-version": "2025-06-18" } }));
    const { key } = await agentWith(app, ["*"]);
    const res = await post(app, key, rpc("tools/list"), { "mcp-session-id": "sess-client", "mcp-protocol-version": "2025-03-26" });
    expect(calls[0]!.headers["mcp-session-id"]).toBe("sess-client");
    expect(calls[0]!.headers["mcp-protocol-version"]).toBe("2025-03-26");
    expect(res.headers["mcp-session-id"]).toBe("sess-serveur");
    expect(res.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });
});

describe("mcp: stream and errors", () => {
  it("text/event-stream response relayed as-is, ledger written", async () => {
    const events = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\nevent: message\ndata: ${JSON.stringify(ok)}\n\n`;
    const { app, store } = make(() => sseResponse([events.slice(0, 20), events.slice(20, 90), events.slice(90)]));
    const { key } = await agentWith(app, ["gh/*"]);
    const res = await post(app, key, call("search"));
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toBe(events);
    expect((await proxyLedger(store))[0]).toMatchObject({ model: "gh/search#read", verdict: "allowed", reason: null, upstreamStatus: 200 });
  });

  it("unreachable server -> 502 JSON-RPC and ledger upstream_unreachable", async () => {
    const { app, store } = make(() => {
      throw new TypeError("fetch failed");
    });
    const { key } = await agentWith(app, ["*"]);
    const res = await post(app, key, call("search"));
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32000 } });
    expect((await proxyLedger(store))[0]).toMatchObject({ reason: "upstream_unreachable", upstreamStatus: null, verdict: "allowed" });
  });

  it("server error 500 relayed, ledger upstream_error", async () => {
    const { app, store } = make(() => jsonResponse({ boom: true }, 500));
    const { key } = await agentWith(app, ["*"]);
    const res = await post(app, key, call("search"));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ boom: true });
    expect((await proxyLedger(store))[0]).toMatchObject({ reason: "upstream_error", upstreamStatus: 500 });
  });
});

describe("mcp: agents and configuration", () => {
  it("allowedTools at creation and via PATCH, with format validation and ledger", async () => {
    const { app, store } = make();
    const created = await app.inject({ method: "POST", url: "/admin/agents", headers: adminHeaders, payload: { name: "a", allowedModels: ["*"], allowedTools: ["gh/search", "gh/*", "gh/search"], dailyBudgetUsd: 1 } });
    expect(created.json().agent.allowedTools).toEqual(["gh/search", "gh/*"]);
    const id = created.json().agent.id as string;
    const patch = (payload: unknown) => app.inject({ method: "PATCH", url: `/admin/agents/${id}`, headers: adminHeaders, payload: payload as object });
    const res = await patch({ allowedTools: ["*"] });
    expect(res.json().agent.allowedTools).toEqual(["*"]);
    expect((await store.listLedger()).at(-1)).toMatchObject({ action: "admin.agent.update", reason: "allowedTools" });
    for (const bad of ["gh", ["gh"], ["gh/"], ["/x"], ["a/b/c"], [1], ["gh/a b"], ["*/x"]]) {
      expect((await patch({ allowedTools: bad })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/admin/agents", headers: adminHeaders, payload: { name: "b", allowedModels: ["*"], allowedTools: ["nope"] } })).statusCode).toBe(400);
    expect((await createAgent(app)).agent).toBeTruthy();
  });

  it("parseMcpServers validates the configuration", () => {
    expect(parseMcpServers(undefined)).toEqual({});
    expect(parseMcpServers('{"a":{"url":"https://x/mcp"}}')).toEqual({ a: { url: "https://x/mcp", headers: {} } });
    expect(parseMcpServers('{"a":{"url":"https://x/mcp","readTools":["read_*","status"]}}')).toEqual({
      a: { url: "https://x/mcp", headers: {}, readTools: ["read_*", "status"] },
    });
    expect(() => parseMcpServers("not json")).toThrow(/JSON/);
    expect(() => parseMcpServers('{"a":{"url":"ftp://x"}}')).toThrow(/URL/);
    expect(() => parseMcpServers('{"a":{"url":"https://x","headers":{"h":1}}}')).toThrow(/headers/);
    expect(() => parseMcpServers('{"a":{"url":"https://x/mcp","readTools":"bad"}}')).toThrow(/readTools/);
    expect(() => parseMcpServers('{"a":{"url":"https://x/mcp","readTools":[1]}}')).toThrow(/readTools/);
    expect(() => parseMcpServers('{"a":{"url":"https://x/mcp","readTools":[""]}}')).toThrow(/readTools/);
  });
});

describe("mcp: read/write classification", () => {
  it("read tool passes without approval and is logged as #read", async () => {
    const { app, store, calls } = makeMixed();
    const { agent, key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: ["erp/*"], approvalTools: [], dailyBudgetUsd: 0, unlimited: true });
    const res = await post(app, key, call("read_work_order"), {}, "erp");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ok);
    expect(calls).toHaveLength(1);
    expect(await store.listApprovals()).toHaveLength(0);
    const [row] = await proxyLedger(store);
    expect(row).toMatchObject({ agentId: agent.id, action: "mcp.tools/call", model: "erp/read_work_order#read", verdict: "allowed", reason: null });
  });

  it("write tool requires approval even when approvalTools is empty", async () => {
    const { app, store, calls } = makeMixed();
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: ["erp/*"], approvalTools: [], dailyBudgetUsd: 0, unlimited: true });
    const pending = post(app, key, call("update_work_order"), {}, "erp").then((response) => response);
    const approval = await nextPending(store);
    expect(approval).toMatchObject({ server: "erp", tool: "update_work_order", accessClass: "write" });
    expect(calls).toHaveLength(0);
    await store.decideApproval(approval.id, "approved", null, new Date().toISOString());
    const out = await pending;
    expect(out.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("glob patterns classify tools as read", async () => {
    const { app, store, calls } = makeMixed();
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: ["erp/*"], approvalTools: [], dailyBudgetUsd: 0, unlimited: true });
    const res = await post(app, key, call("get_status"), {}, "erp");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ok);
    expect(calls).toHaveLength(1);
    expect((await proxyLedger(store))[0]).toMatchObject({ model: "erp/get_status#read" });
  });

  it("missing readTools means every tool is write", async () => {
    const { app, store } = setupWith({ mcpServers: { gh: { url: "https://mcp.test/gh", headers: {} } } }, () => jsonResponse(ok));
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: ["gh/*"], approvalTools: [], dailyBudgetUsd: 0, unlimited: true });
    const pending = post(app, key, call("search")).then((response) => response);
    const approval = await nextPending(store);
    expect(approval).toMatchObject({ server: "gh", tool: "search", accessClass: "write" });
    await store.decideApproval(approval.id, "approved", null, new Date().toISOString());
    await pending;
  });

  it("observe mode forwards write tools and logs observed:approval_required", async () => {
    const writeServers = { gh: { url: "https://mcp.test/gh", headers: {} } };
    const { app, store, calls } = setupWith({ mcpServers: writeServers, mode: "observe" }, () => jsonResponse(ok));
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: ["gh/*"], approvalTools: [], dailyBudgetUsd: 0, unlimited: true });
    const res = await post(app, key, call("search"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ok);
    expect(calls).toHaveLength(1);
    expect((await proxyLedger(store))[0]).toMatchObject({
      action: "mcp.tools/call",
      model: "gh/search#write",
      verdict: "allowed",
      reason: "observed:approval_required",
    });
  });

  it("observe mode forwards read tools without approval_required reason", async () => {
    const { app, store, calls } = setupWith({ mcpServers: mixedServers, mode: "observe" });
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: ["erp/*"], approvalTools: [], dailyBudgetUsd: 0, unlimited: true });
    const res = await post(app, key, call("read_work_order"), {}, "erp");
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await proxyLedger(store))[0]).toMatchObject({
      action: "mcp.tools/call",
      model: "erp/read_work_order#read",
      verdict: "allowed",
      reason: null,
    });
  });
});

const dbUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!dbUrl)("mcp: PostgreSQL migration", () => {
  it("adds allowed_tools to an existing agents table, idempotently", async () => {
    // Concurrent fixtures also cover overlapping invocations against the same database.
    const migrateFixture = async (allowedTool: string) => {
      const schema = `ga_mcp_${randomUUID().replaceAll("-", "")}`;
      const admin = new pg.Pool({ connectionString: dbUrl, max: 1 });
      const pool = new pg.Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` });
      try {
        // Completion of CREATE SCHEMA is the readiness signal; no timing delay.
        await admin.query(`CREATE SCHEMA "${schema}"`);
        await pool.query(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
          allowed_models TEXT[] NOT NULL, daily_budget BIGINT NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await pool.query("INSERT INTO agents (id, name, key_hash, allowed_models) VALUES ('old', 'ancien', 'h', '{a}')");
        const store = new PgStore(pool);
        await store.migrate();
        await store.migrate();
        expect((await store.getAgent("old"))!.allowedTools).toEqual([]);
        await store.updateAgent("old", { allowedTools: [allowedTool] });
        await store.migrate();
        expect((await store.getAgent("old"))!.allowedTools).toEqual([allowedTool]);
        const { rows } = await pool.query("SELECT column_default, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='agents' AND column_name='allowed_tools'", [schema]);
        expect(rows[0]).toMatchObject({ is_nullable: "NO" });
      } finally {
        try {
          await pool.end();
        } finally {
          try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
          finally { await admin.end(); }
        }
      }
    };
    // Wait for both cleanups even if one fixture fails.
    const results = await Promise.allSettled([migrateFixture("gh/*"), migrateFixture("erp/*")]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  });
});
