import { readFileSync } from "node:fs";
import { MCP_REQUESTS, MCP_NOTIFICATIONS, MCP_SERVER_NOTIFICATIONS } from "../src/mcp.js";
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

  it.each(["initialize", "tools/list", "notifications/initialized", "notifications/cancelled"])("%s is governed and journaled", async (method) => {
    const { app, store, calls } = make();
    const { key } = await agentWith(app, []);
    const notification = method.startsWith("notifications/");
    const res = await post(app, key, rpc(method, method.endsWith("cancelled") ? { requestId: 1 } : {}, notification ? null : 1));
    expect(res.statusCode).toBe(notification ? 202 : 200);
    expect(calls).toHaveLength(1);
    expect((await proxyLedger(store))[0]).toMatchObject({ action: `mcp.${method}`, model: "gh/-", verdict: "allowed" });
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
    const { app, store } = make(() => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "upstream failure" } }, 500));
    const { key } = await agentWith(app, ["*"]);
    const res = await post(app, key, call("search"));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: -32603 } });
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
    const { app, store, calls } = setupWith({ mcpServers: mixedServers, mode: "observe" }, () => jsonResponse(ok));
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: ["erp/*"], approvalTools: [], dailyBudgetUsd: 0, unlimited: true });
    const res = await post(app, key, call("read_work_order"), {}, "erp");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ok);
    expect(calls).toHaveLength(1);
    expect(await store.listApprovals()).toHaveLength(0);
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
  it("preserves allowed_tools across versioned restarts", async () => {
    // Concurrent fixtures also cover overlapping invocations against the same database.
    const migrateFixture = async (allowedTool: string) => {
      const schema = `ga_mcp_${randomUUID().replaceAll("-", "")}`;
      const admin = new pg.Pool({ connectionString: dbUrl, max: 1 });
      const pool = new pg.Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` });
      try {
        // Completion of CREATE SCHEMA is the readiness signal; no timing delay.
        await admin.query(`CREATE SCHEMA "${schema}"`);
        const store = new PgStore(pool);
        await store.migrate();
        await store.migrate();
        await store.createAgent({ id: "old", name: "old", keyHash: "fake", allowedModels: ["a"], allowedTools: [], approvalTools: [], dailyBudget: 0, active: true });
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

const refusedMethods = ["resources/list", "resources/templates/list", "resources/read", "resources/subscribe", "resources/unsubscribe", "prompts/list", "prompts/get", "completion/complete", "logging/setLevel", "extension/unknown"];
const refusedNotifications = ["notifications/progress", "notifications/roots/list_changed", "notifications/unknown"];

describe("mcp: exhaustive governance matrix", () => {
  it.each(["enforce", "observe"] as const)("%s suppresses and journals malformed upstream responses", async (mode) => {
    const { app, store, calls } = setupWith({ mcpServers: servers, mode }, () => jsonResponse({}));
    const { key } = await agentWith(app, ["gh/search"]);
    const res = await post(app, key, call("search"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32603 } });
    expect(calls).toHaveLength(1);
    expect((await proxyLedger(store))[0]).toMatchObject({
      action: "mcp.tools/call", model: "gh/search#read", verdict: "allowed",
      reason: "invalid_upstream_message", responseHash: sha256(res.body),
    });
  });

  it("declares every named method in the written matrix", () => {
    const matrix = readFileSync(new URL("../../../docs/mcp-matrix.md", import.meta.url), "utf8");
    const declared = new Set<string>([...MCP_REQUESTS, ...MCP_NOTIFICATIONS, ...MCP_SERVER_NOTIFICATIONS, ...refusedMethods, ...refusedNotifications, "sampling/createMessage", "elicitation/create", "roots/list"]);
    for (const match of matrix.matchAll(/`((?:notifications|tools|resources|prompts|completion|logging|sampling|elicitation|roots)\/[A-Za-z_/]+|initialize|ping)`/g)) {
      expect(declared.has(match[1]!), match[1]).toBe(true);
    }
  });

  it.each([...refusedMethods, ...refusedNotifications])("%s defaults to refusal with proof", async (method) => {
    const { app, store, calls } = make();
    const { key } = await agentWith(app, ["*"]);
    const notification = method.startsWith("notifications/");
    const res = await post(app, key, rpc(method, {}, notification ? null : 1));
    expect(calls).toHaveLength(0);
    expect(res.statusCode).toBe(notification ? 202 : 200);
    if (!notification) expect(res.json().error.code).toBe(-32601);
    expect((await proxyLedger(store))[0]).toMatchObject({ action: `mcp.${method}`, verdict: "denied", reason: "method_not_governed" });
  });

  it.each([...refusedMethods, ...refusedNotifications])("observe relays %s with proof", async (method) => {
    const { app, store, calls } = setupWith({ mcpServers: servers, mode: "observe" }, () => jsonResponse(ok));
    const { key } = await agentWith(app, []);
    await post(app, key, rpc(method, {}, method.startsWith("notifications/") ? null : 1));
    expect(calls).toHaveLength(1);
    expect((await proxyLedger(store))[0]).toMatchObject({ verdict: "allowed", reason: "observed:method_not_governed" });
  });

  it("ping is local and journaled; unsupported transports are explicit", async () => {
    const { app, store, calls } = make();
    const { key } = await agentWith(app, []);
    expect((await post(app, key, rpc("ping"))).json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect((await proxyLedger(store))[0]).toMatchObject({ action: "mcp.ping" });
    for (const method of ["GET", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/mcp/gh" });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("POST");
    }
    expect(calls).toHaveLength(0);
  });

  it.each([false, true])("filters capabilities including streamed lists (SSE=%s)", async (stream) => {
    const listing = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "search" }, { name: "write" }] } };
    const { app, store } = make(() => stream ? sseResponse([`data: ${JSON.stringify(listing)}\n\n`]) : jsonResponse(listing));
    const { key } = await agentWith(app, ["gh/search"]);
    const res = await post(app, key, rpc("tools/list"));
    expect(res.body).toContain('"search"');
    expect(res.body).not.toContain('"write"');
    expect((await proxyLedger(store))[0]).toMatchObject({ action: "mcp.tools/list", responseHash: sha256(res.body) });
  });

  it("observe retains listings and journals the hidden capabilities", async () => {
    const listing = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "write" }] } };
    const { app, store } = setupWith({ mcpServers: servers, mode: "observe" }, () => jsonResponse(listing));
    const { key } = await agentWith(app, []);
    expect((await post(app, key, rpc("tools/list"))).json()).toEqual(listing);
    expect((await proxyLedger(store))[0]).toMatchObject({ reason: "observed:tool_not_allowed" });
  });

  it.each(["sampling/createMessage", "elicitation/create", "roots/list", "ping", "extension/unknown", "notifications/unknown"])("screens server message %s in both modes", async (method) => {
    for (const mode of ["enforce", "observe"] as const) {
      const message = { jsonrpc: "2.0", method, ...(method.startsWith("notifications/") ? {} : { id: "server-1" }), params: {} };
      const events = `data: ${JSON.stringify(message)}\n\ndata: ${JSON.stringify(ok)}\n\n`;
      const { app, store } = setupWith({ mcpServers: servers, mode }, () => sseResponse([events.slice(0, 13), events.slice(13)]));
      const { key } = await agentWith(app, ["*"]);
      const res = await post(app, key, call("search"));
      expect(res.body.includes(method)).toBe(mode === "observe");
      expect(await proxyLedger(store)).toEqual(expect.arrayContaining([expect.objectContaining({ action: `mcp.${method}`, reason: `${mode === "observe" ? "observed:" : ""}server_request_refused` })]));
    }
  });

  it.each(MCP_SERVER_NOTIFICATIONS)("relays declared server notification %s as part of the governed hash", async (method) => {
    const events = `data: ${JSON.stringify({ jsonrpc: "2.0", method })}\n\ndata: ${JSON.stringify(ok)}\n\n`;
    const { app, store } = make(() => sseResponse([events]));
    const { key } = await agentWith(app, ["*"]);
    expect((await post(app, key, call("search"))).body).toBe(events);
    expect((await proxyLedger(store))[0]).toMatchObject({ responseHash: sha256(events) });
  });

  it("filters initialization capabilities and journals observe differences", async () => {
    for (const mode of ["enforce", "observe"] as const) {
      const initialized = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {}, prompts: {}, experimental: {} } } };
      const { app, store } = setupWith({ mcpServers: servers, mode }, () => jsonResponse(initialized));
      const { key } = await agentWith(app, []);
      const res = await post(app, key, rpc("initialize", {}));
      expect(res.json().result.capabilities).toEqual(mode === "enforce" ? { tools: {} } : initialized.result.capabilities);
      expect((await proxyLedger(store))[0]).toMatchObject({ action: "mcp.initialize", reason: mode === "observe" ? "observed:method_not_governed" : null });
    }
  });

  it("screens server requests in ordinary JSON responses too", async () => {
    const { app, store } = make(() => jsonResponse({ jsonrpc: "2.0", id: "server-request", method: "sampling/createMessage", params: {} }));
    const { key } = await agentWith(app, ["*"]);
    const res = await post(app, key, call("search"));
    expect(res.json().error.code).toBe(-32603);
    expect(res.body).not.toContain("sampling/createMessage");
    expect(await proxyLedger(store)).toEqual(expect.arrayContaining([expect.objectContaining({ action: "mcp.sampling/createMessage", verdict: "denied" })]));
  });

  it.each(["tools/call", "tools/list", "initialize", "ping"])("request-only %s cannot bypass governance as a notification", async (method) => {
    const { app, store, calls } = make();
    const { key } = await agentWith(app, ["*"]);
    expect((await post(app, key, rpc(method, { name: "search" }, null))).statusCode).toBe(202);
    expect(calls).toHaveLength(0);
    expect((await proxyLedger(store))[0]).toMatchObject({ verdict: "denied", reason: "method_not_governed" });
  });

  it("client responses and malformed framing never reach upstream", async () => {
    const { app, store, calls } = make();
    const { key } = await agentWith(app, ["*"]);
    expect((await post(app, key, { jsonrpc: "2.0", id: 2, result: {} })).statusCode).toBe(400);
    expect((await proxyLedger(store))[0]).toMatchObject({ reason: "mcp_client_response_refused", verdict: "denied" });
    for (const payload of [{ jsonrpc: "2.0", method: "initialize", params: [] }, { jsonrpc: "2.0", method: "initialize", id: {} }]) {
      expect((await post(app, key, payload)).statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});
