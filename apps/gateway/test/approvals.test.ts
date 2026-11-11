import { describe, expect, it } from "vitest";
import { canonicalJson, sha256, summarizeArgs, verifyChain } from "@gardagent/core";
import { adminHeaders, createAgent, jsonResponse, setupWith } from "./helpers.js";

const servers = { gh: { url: "https://mcp.test/gh", headers: {} } };
const mixedServers = { erp: { url: "https://mcp.test/erp", headers: {}, readTools: ["read_work_order"] } };
const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } };
const call = (name: string, args: unknown = { path: "/secret-chemin", token: "mot-sensible" }) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

function make(overrides: Record<string, unknown> = {}) {
  return setupWith({ mcpServers: servers, ...overrides }, () => jsonResponse(ok));
}
type Ctx = ReturnType<typeof make>;

const agentWith = (app: Ctx["app"], approvalTools: string[]) =>
  createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: ["gh/*"], approvalTools, dailyBudgetUsd: 0, unlimited: true });
const post = (app: Ctx["app"], key: string, payload: unknown) =>
  app.inject({ method: "POST", url: "/mcp/gh", headers: { authorization: `Bearer ${key}` }, payload: payload as object });
const postTo = (app: Ctx["app"], key: string, server: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/mcp/${server}`, headers: { authorization: `Bearer ${key}` }, payload: payload as object });
const decide = (app: Ctx["app"], id: string, action: "approve" | "reject", payload: object = {}) =>
  app.inject({ method: "POST", url: `/admin/approvals/${id}/${action}`, headers: adminHeaders, payload });

async function nextPending(store: Ctx["store"]) {
  for (let i = 0; i < 200; i++) {
    const [a] = await store.listApprovals({ status: "pending" });
    if (a) return a;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no pending approval request");
}
const ledgerActions = async (store: Ctx["store"]) =>
  (await store.listLedger()).filter((e) => !e.action.startsWith("admin.")).map((e) => `${e.action}:${e.verdict}:${e.reason}`);

describe("human validation: MCP tools", () => {
  it("approved: no call before the decision, then normal relay", async () => {
    const { app, store, calls } = make();
    const { agent, key } = await agentWith(app, ["gh/delete"]);
    const pending = post(app, key, call("delete"));
    const approval = await nextPending(store);
    expect(approval).toMatchObject({ agentId: agent.id, server: "gh", tool: "delete", status: "pending", argsHash: sha256(canonicalJson({ path: "/secret-chemin", token: "mot-sensible" })) });
    expect(approval.argsSummary).toContain("/secret-chemin");
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(0);

    const res = await decide(app, approval.id, "approve");
    expect(res.statusCode).toBe(200);
    const out = await pending;
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual(ok);
    expect(calls).toHaveLength(1);

    expect(await ledgerActions(store)).toEqual([
      "mcp.approval.requested:allowed:null",
      "mcp.approval.decided:allowed:approved",
      "mcp.tools/call:allowed:null",
    ]);
    const all = await store.listLedger();
    expect(verifyChain(all).valid).toBe(true);
    expect(JSON.stringify(all)).not.toContain("secret-chemin");
    expect(JSON.stringify(all)).not.toContain("mot-sensible");
    const decided = all.find((e) => e.action === "mcp.approval.decided")!;
    expect(decided).toMatchObject({ agentId: agent.id, model: "gh/delete#write", requestHash: approval.argsHash });
  });

  it("rejected: error -32002 with kept reason, no call", async () => {
    const { app, store, calls } = make();
    const { key } = await agentWith(app, ["gh/*"]);
    const pending = post(app, key, call("delete"));
    const approval = await nextPending(store);
    expect((await decide(app, approval.id, "reject", { reason: "too risky" })).statusCode).toBe(200);
    const out = await pending;
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Action rejected by a human" } });
    expect(calls).toHaveLength(0);
    expect(await store.getApproval(approval.id)).toMatchObject({ status: "rejected", reason: "too risky" });
    expect(await ledgerActions(store)).toEqual(["mcp.approval.requested:allowed:null", "mcp.approval.decided:denied:rejected"]);
    expect(verifyChain(await store.listLedger()).valid).toBe(true);
  });

  it("expired: error -32002 \"Approval timeout exceeded\", decision logged, then 409", async () => {
    const { app, store, calls } = make({ approvalTimeoutMs: 120 });
    const { key } = await agentWith(app, ["*"]);
    const out = await post(app, key, call("delete"));
    expect(out.json()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Approval timeout exceeded" } });
    expect(calls).toHaveLength(0);
    const [approval] = await store.listApprovals();
    expect(approval).toMatchObject({ status: "expired" });
    expect(approval!.decidedAt).not.toBeNull();
    expect(await ledgerActions(store)).toEqual(["mcp.approval.requested:allowed:null", "mcp.approval.decided:denied:expired"]);
    expect((await decide(app, approval!.id, "approve")).statusCode).toBe(409);
  });

  it("read tool outside approvalTools: relayed immediately, no request", async () => {
    const { app, store, calls } = make({ mcpServers: mixedServers });
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: ["erp/read_work_order"], approvalTools: [], dailyBudgetUsd: 0, unlimited: true });
    const out = await postTo(app, key, "erp", call("read_work_order"));
    expect(out.json()).toEqual(ok);
    expect(calls).toHaveLength(1);
    expect(await store.listApprovals()).toHaveLength(0);
    expect(await ledgerActions(store)).toEqual(["mcp.tools/call:allowed:null"]);
  });

  it("write tool requires approval even when not in approvalTools", async () => {
    const { app, store, calls } = make();
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: ["gh/*"], approvalTools: [], dailyBudgetUsd: 0, unlimited: true });
    const pending = post(app, key, call("delete"));
    for (let i = 0; i < 200; i++) {
      if ((await store.listApprovals({ status: "pending" })).length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const [approval] = await store.listApprovals({ status: "pending" });
    expect(approval).toMatchObject({ server: "gh", tool: "delete", accessClass: "write" });
    expect(calls).toHaveLength(0);
    await store.decideApproval(approval.id, "approved", null, new Date().toISOString());
    await pending;
    expect(calls).toHaveLength(1);
  });

  it("non-allowed tool: denied -32001 without approval request", async () => {
    const { app, store } = make();
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: [], approvalTools: ["*"], dailyBudgetUsd: 1 });
    const out = await post(app, key, call("delete"));
    expect(out.json().error.code).toBe(-32001);
    expect(await store.listApprovals()).toHaveLength(0);
  });

  it("double decision: 409; unknown request: 404; token required", async () => {
    const { app, store } = make();
    const { key } = await agentWith(app, ["gh/*"]);
    const pending = post(app, key, call("delete"));
    const approval = await nextPending(store);
    expect((await decide(app, approval.id, "approve")).statusCode).toBe(200);
    expect((await decide(app, approval.id, "approve")).statusCode).toBe(409);
    expect((await decide(app, approval.id, "reject")).statusCode).toBe(409);
    await pending;
    expect((await decide(app, "inconnue", "approve")).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/admin/approvals/${approval.id}/approve`, payload: {} })).statusCode).toBe(401);
    expect((await store.listLedger()).filter((e) => e.action === "mcp.approval.decided")).toHaveLength(1);
  });

  it("decision from another instance (store only): detected by polling", async () => {
    const { app, store, calls } = make();
    const { key } = await agentWith(app, ["gh/*"]);
    const pending = post(app, key, call("delete"));
    const approval = await nextPending(store);
    await store.decideApproval(approval.id, "approved", null, new Date().toISOString());
    expect((await pending).json()).toEqual(ok);
    expect(calls).toHaveLength(1);
  });

  it("GET /admin/approvals: filters by status and validates", async () => {
    const { app, store } = make({ approvalTimeoutMs: 80 });
    const { key } = await agentWith(app, ["gh/*"]);
    await post(app, key, call("delete"));
    const get = (q: string) => app.inject({ method: "GET", url: `/admin/approvals${q}`, headers: adminHeaders });
    expect((await get("?status=pending")).json().approvals).toHaveLength(0);
    const expired = (await get("?status=expired")).json().approvals;
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ server: "gh", tool: "delete", status: "expired" });
    expect((await get("")).json().approvals).toHaveLength(1);
    expect((await get("?status=nimporte")).statusCode).toBe(400);
    expect((await get("?limit=0")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/admin/approvals" })).statusCode).toBe(401);
    expect(await store.listApprovals()).toHaveLength(1);
  });

  it("approvalTools: validation, default value, logged update", async () => {
    const { app, store } = make();
    const created = await createAgent(app, { name: "n", allowedModels: ["*"], dailyBudgetUsd: 1 });
    const list = async () => (await app.inject({ method: "GET", url: "/admin/agents", headers: adminHeaders })).json().agents[0];
    expect((await list()).approvalTools).toEqual([]);
    const patch = (payload: object) => app.inject({ method: "PATCH", url: `/admin/agents/${created.agent.id}`, headers: adminHeaders, payload });
    expect((await patch({ approvalTools: ["pas bon"] })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/admin/agents", headers: adminHeaders, payload: { name: "x", allowedModels: ["*"], approvalTools: "gh/*" } })).statusCode).toBe(400);
    expect((await patch({ approvalTools: ["gh/*"] })).statusCode).toBe(200);
    expect((await list()).approvalTools).toEqual(["gh/*"]);
    const last = (await store.listLedger({ order: "desc", limit: 1 }))[0]!;
    expect(last).toMatchObject({ action: "admin.agent.update", reason: "approvalTools" });
  });
});

describe("summarizeArgs", () => {
  it("short keys and values, truncated strings, 500 characters max", () => {
    expect(summarizeArgs({ a: 1, b: "x", c: null, d: [1, 2] })).toBe('a=1, b="x", c=null, d=[1,2]');
    expect(summarizeArgs({ long: "z".repeat(300) })).toBe(`long="${"z".repeat(79)}…"`);
    const big = summarizeArgs(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`cle${i}`, "v".repeat(60)])));
    expect(big.length).toBeLessThanOrEqual(500);
    expect(summarizeArgs(undefined)).toBe("");
  });
});
