import { describe, expect, it } from "vitest";
import { canonicalJson, sha256, summarizeArgs, verifyChain } from "@gardagent/core";
import { loadConfig } from "../src/config.js";
import { adminHeaders, nextPending, createAgent, jsonResponse, setupWith } from "./helpers.js";

const servers = { gh: { url: "https://mcp.test/gh", headers: {} } };
const mixedServers = { erp: { url: "https://mcp.test/erp", headers: {}, readTools: ["read_work_order"] } };
const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } };
const normalizedUserinfoUrls = [
  ...["\t", "\n", "\r"].flatMap((control) => [
    `https://al${control}ice:pass@example.com/path`,
    `https://alice:pa${control}ss@example.com/path`,
    `https://alice${control}:pass@example.com/path`,
    `https://al${control}ice:pa${control}ss@pri${control}vate@example.com/path`,
  ]),
  "\x00\x1f https://alice:pass@example.com/path \x1f\x00",
  "\t\n https://al\rice:pa\tss@private@example.com/path \r\n",
  "https://alice:pa ss@example.com/path",
  "https://al ice:pass@example.com/path",
  "https://alice:pa ss@pri vate@example.com/path",
  "https://alice:p a\ts s@example.com/path",
];
const shortJwts = [
  "eyJhbGciOiJIUzI1NiJ9.e30." + "a".repeat(43), // {} claims
  "eyJhIjowfQ.e30.a", // {"a":0} header, {} payload and short signature
  "eyJ.a.b", // no minimum beyond the required header prefix
  "eyJhbGciOiJub25lIn0.e30.", // alg none
];
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

const ledgerActions = async (store: Ctx["store"]) =>
  (await store.listLedger()).filter((e) => !e.action.startsWith("admin.")).map((e) => `${e.action}:${e.verdict}:${e.reason}`);

describe("human validation: MCP tools", () => {
  it.each(["approve", "reject"] as const)("%s sanitizes summaries, fingerprints full arguments and preserves forwarding", async (action) => {
    const base = { UPSTREAM_BASE_URL: "https://up.test", UPSTREAM_API_KEY: "test", GARDAGENT_ADMIN_TOKEN: "t".repeat(32) };
    const configured = loadConfig({ ...base, GARDAGENT_REDACT_KEYS: " , CustomerCode, CUSTOMERcode, " });
    expect(configured.redactKeys).toEqual(["customercode"]);
    expect(loadConfig(base).redactKeys).toEqual([]);
    const { app, store, calls } = make({ redactKeys: configured.redactKeys });
    const { key } = await agentWith(app, ["gh/*"]);
    const args = { path: "/visible", password: "synthetic-password", customerCode: "synthetic-custom", nested: ["ghp_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"] };
    const pending = post(app, key, call("delete", args)).then((response) => response);
    const approval = await nextPending(store);
    expect(approval.argsSummary).toContain('/visible');
    expect(approval.argsSummary).toContain('[redacted]');
    for (const secret of [args.password, args.customerCode, args.nested[0]]) expect(approval.argsSummary).not.toContain(secret);
    expect(approval.argsHash).toBe(sha256(canonicalJson(args)));
    expect(approval.argsHash).not.toBe(sha256(canonicalJson({ ...args, password: "different" })));
    const listed = await app.inject({ method: "GET", url: "/admin/approvals", headers: adminHeaders });
    expect(listed.json().approvals[0].argsSummary).toBe(approval.argsSummary);
    const decision = await decide(app, approval.id, action);
    expect(decision.statusCode).toBe(200);
    expect(decision.body).not.toContain(args.password);
    const response = await pending;
    if (action === "approve") {
      expect(response.json()).toEqual(ok);
      expect(calls[0]!.body.params.arguments).toEqual(args);
    } else {
      expect(response.json().error.code).toBe(-32002);
      expect(calls).toHaveLength(0);
    }
    const rows = await store.listLedger();
    expect(verifyChain(rows).valid).toBe(true);
    const serialized = JSON.stringify(rows);
    for (const secret of [args.password, args.customerCode, args.nested[0]]) expect(serialized).not.toContain(secret);
    const expectedActions = action === "approve"
      ? ["mcp.approval.requested", "mcp.approval.decided", "mcp.tools/call"]
      : ["mcp.approval.requested", "mcp.approval.decided"];
    const argumentRows = rows.filter((row) => expectedActions.includes(row.action));
    expect(argumentRows.map((row) => row.action).sort()).toEqual([...expectedActions].sort());
    for (const row of argumentRows) expect(row.requestHash).toBe(sha256(canonicalJson(args)));
    // A second request has its own approval and hash; this does not test approval reuse.
    const secondRequest = post(app, key, call("delete", { ...args, password: "different" })).then((response) => response);
    const next = await nextPending(store);
    expect(next.id).not.toBe(approval.id);
    expect(next.argsSummary).toBe(approval.argsSummary);
    expect(next.argsHash).not.toBe(approval.argsHash);
    await decide(app, next.id, "reject");
    await secondRequest;
  });

  it.each([
    ...normalizedUserinfoUrls.map((url) => ({ args: { value: url }, expected: 'value="https://[redacted]@example.com/path"' })),
    ...shortJwts.map((jwt) => ({ args: { value: `before ${jwt} after` }, expected: 'value="[redacted]"' })),
  ])("stores and returns sanitized MCP summaries: $args.value", async ({ args, expected }) => {
    const { app, store, calls } = make();
    const { key } = await agentWith(app, ["gh/*"]);
    const pending = post(app, key, call("delete", args)).then((response) => response);
    const approval = await nextPending(store);
    expect(approval.argsSummary).toBe(expected);
    expect((await store.getApproval(approval.id))!.argsSummary).toBe(expected);
    expect(approval.argsHash).toBe(sha256(canonicalJson(args)));
    const listed = await app.inject({ method: "GET", url: "/admin/approvals", headers: adminHeaders });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().approvals[0].argsSummary).toBe(expected);
    await decide(app, approval.id, "approve");
    expect((await pending).json()).toEqual(ok);
    expect(calls[0]!.body.params.arguments).toEqual(args);
  });

  it("approved: no call before the decision, then normal relay", async () => {
    const { app, store, calls } = make();
    const { agent, key } = await agentWith(app, ["gh/delete"]);
    const pending = post(app, key, call("delete")).then((response) => response);
    const approval = await nextPending(store);
    expect(approval).toMatchObject({ agentId: agent.id, server: "gh", tool: "delete", status: "pending", argsHash: sha256(canonicalJson({ path: "/secret-chemin", token: "mot-sensible" })) });
    expect(approval.argsSummary).toContain("/secret-chemin");
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
    const pending = post(app, key, call("delete")).then((response) => response);
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
    const pending = post(app, key, call("delete")).then((response) => response);
    const approval = await nextPending(store);
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
    const pending = post(app, key, call("delete")).then((response) => response);
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
    const pending = post(app, key, call("delete")).then((response) => response);
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
  it.each(["password", "passwd", "secret", "token", "api_key", "apikey", "authorization", "cookie", "credential", "private_key", "access_key", "session"])("redacts substring key %s case-insensitively", (key) => {
    expect(summarizeArgs({ [`prefix_${key.toUpperCase()}_suffix`]: { value: "synthetic" }, path: "/visible" })).toBe(`prefix_${key.toUpperCase()}_suffix="[redacted]", path="/visible"`);
  });

  it.each([
    "sk-" + "a".repeat(20), "sk-ant-" + "a".repeat(40),
    "ghp_" + "a".repeat(36), "gho_" + "a".repeat(36), "github_pat_" + "a".repeat(22) + "_" + "b".repeat(59),
    "ga_" + "a".repeat(32), "AKIA" + "A".repeat(16),
    ...["a", "b", "p", "r"].map((kind) => `xox${kind}-123456789012-123456789012-${"a".repeat(24)}`),
    ...shortJwts, "eyJx.a.b", "eyJ.not.ajwt",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0." + "a".repeat(43), "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN EC PRIVATE KEY-----",
  ])("redacts a secret anywhere in strings: %s", (secret) => {
    expect(summarizeArgs({ value: `before ${secret} after` })).toBe('value="[redacted]"');
    expect(summarizeArgs(secret)).toBe('"[redacted]"');
  });

  it.each([
    "task-delete", "/workspace/task-123", "disk-image", "risk-assessment", "ask-user",
    "sk-short", "sk-ant-short", "ghp_short", "gho_short", "github_pat_short", "ga_short",
    "AKIA123", "xoxb-short", "eyJ..abc", "eyJ.a",
    ...shortJwts.map((jwt) => `prefix${jwt}`),
    "ghp_" + "a".repeat(36) + "suffix", "gho_" + "a".repeat(36) + "suffix",
    "github_pat_" + "a".repeat(22) + "_" + "b".repeat(59) + "suffix",
    "AKIA" + "A".repeat(16) + "suffix", "ga_" + "a".repeat(32) + "suffix",
    "prefix-----BEGIN PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----suffix",
    ...["sk-" + "a".repeat(20), "ghp_" + "a".repeat(36), "gho_" + "a".repeat(36),
      "github_pat_" + "a".repeat(22) + "_" + "b".repeat(59), "ga_" + "a".repeat(32),
      "AKIA" + "A".repeat(16), "xoxb-123456789012-123456789012-" + "a".repeat(24),
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0." + "a".repeat(43)]
      .map((secret) => `prefix${secret}`),
  ])("preserves ordinary values and embedded credential-like identifiers: %s", (value) => {
    expect(summarizeArgs({ value })).not.toContain("[redacted]");
  });

  it.each([
    ...normalizedUserinfoUrls.map((url) => [url, "https://[redacted]@example.com/path"]),
    ["https://alice:public@private@example.com/path", "https://[redacted]@example.com/path"],
    ["https://alice:p%40ss%3Aword@example.com/path", "https://[redacted]@example.com/path"],
    ["https://a%40b:public@private@[::1]:8443/path", "https://[redacted]@[::1]:8443/path"],
    ["https://example.com/path@visible?q=user@visible", "https://example.com/path@visible?q=user@visible"],
  ])("redacts complete URL authority userinfo: %s", (url, expected) => {
    expect(summarizeArgs({ url })).toBe(`url=${JSON.stringify(expected)}`);
  });

  it("walks nested objects and arrays without changing arguments", () => {
    const args = { group: [{ password: "synthetic", path: "/ok" }, ["ghp_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS", 2]], count: 3 };
    expect(summarizeArgs(args)).toBe('group=[{"password":"[redacted]","path":"/ok"},["[redacted]",2]], count=3');
    expect(args.group[0]).toEqual({ password: "synthetic", path: "/ok" });
  });

  it("redacts URL userinfo while retaining the scheme, host and path", () => {
    expect(summarizeArgs({ url: "postgres://alice:p%40ss@db.example:5432/data" })).toBe('url="postgres://[redacted]@db.example:5432/data"');
    expect(summarizeArgs(["https://alice:pass@example.com/path"])).toBe('["https://[redacted]@example.com/path"]');
  });

  it("adds custom keys without replacing defaults and redacts before truncation", () => {
    expect(summarizeArgs({ custom: "hidden", password: "hidden", path: "/ok" }, 500, ["CUSTOM"])).toBe('custom="[redacted]", password="[redacted]", path="/ok"');
    expect(summarizeArgs({ value: "z".repeat(100) + " ghp_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS" })).toBe('value="[redacted]"');
    expect(summarizeArgs({ password: "z".repeat(300) })).toBe('password="[redacted]"');
    expect(summarizeArgs({ password: "hidden", path: "z".repeat(300) }, 25)).toHaveLength(25);
    expect(summarizeArgs("ga_short")).toBe('"ga_short"');
  });

  it("short keys and values, truncated strings, 500 characters max", () => {
    expect(summarizeArgs({ a: 1, b: "x", c: null, d: [1, 2] })).toBe('a=1, b="x", c=null, d=[1,2]');
    expect(summarizeArgs({ long: "z".repeat(300) })).toBe(`long="${"z".repeat(79)}…"`);
    const big = summarizeArgs(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`cle${i}`, "v".repeat(60)])));
    expect(big.length).toBeLessThanOrEqual(500);
    expect(summarizeArgs(undefined)).toBe("");
  });
});
