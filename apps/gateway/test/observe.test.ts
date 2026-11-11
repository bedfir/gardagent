import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "@gardagent/core";
import { loadConfig } from "../src/config.js";
import { adminHeaders, createAgent, jsonResponse, proxyLedger, setup, setupWith, sseResponse, waitForLedger } from "./helpers.js";

const completion = {
  id: "c1",
  choices: [{ index: 0, message: { role: "assistant", content: "salut" } }],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
};

const chat = (model = "gpt-4o-mini", extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

describe("observe mode: config", () => {
  const base = { UPSTREAM_BASE_URL: "https://up.test/", UPSTREAM_API_KEY: "k", GARDAGENT_ADMIN_TOKEN: "t".repeat(32) };

  it("defaults to enforce", () => {
    const c = loadConfig({ ...base });
    expect(c.mode).toBe("enforce");
  });

  it("accepts observe", () => {
    const c = loadConfig({ ...base, GARDAGENT_MODE: "observe" });
    expect(c.mode).toBe("observe");
  });

  it.each(["unknown", "", "enforc"])("invalid GARDAGENT_MODE=%j fails at startup", (mode) => {
    expect(() => loadConfig({ ...base, GARDAGENT_MODE: mode })).toThrow(/GARDAGENT_MODE must be "enforce" or "observe"/);
  });
});

describe("observe mode: proxy", () => {
  it("forwards a non-allowed model and logs observed:model_not_allowed", async () => {
    const { app, store, calls } = setupWith({ mode: "observe" }, () => jsonResponse(completion));
    const { key } = await createAgent(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: chat("gpt-4o"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(completion);
    expect(calls).toHaveLength(1);
    expect((await proxyLedger(store))[0]).toMatchObject({
      verdict: "allowed",
      reason: "observed:model_not_allowed",
      upstreamStatus: 200,
    });
  });

  it("forwards when the agent is disabled and logs observed:agent_disabled", async () => {
    const { app, store, calls } = setupWith({ mode: "observe" }, () => jsonResponse(completion));
    const { agent, key } = await createAgent(app);
    await app.inject({ method: "PATCH", url: `/admin/agents/${agent.id}`, headers: adminHeaders, payload: { active: false } });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: chat(),
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await proxyLedger(store))[0]).toMatchObject({
      verdict: "allowed",
      reason: "observed:agent_disabled",
      upstreamStatus: 200,
    });
  });

  it("forwards when the budget is exceeded and logs observed:budget_exceeded", async () => {
    const { app, store, calls } = setupWith({ mode: "observe" }, () => jsonResponse(completion));
    const { key } = await createAgent(app, { name: "tiny", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 0.00001 });
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: chat("gpt-4o-mini", { max_tokens: 10 }),
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: chat("gpt-4o-mini", { max_tokens: 10 }),
    });
    expect(second.statusCode).toBe(200);
    expect(calls).toHaveLength(2);
    const rows = await proxyLedger(store);
    expect(rows[1]).toMatchObject({
      verdict: "allowed",
      reason: "observed:budget_exceeded",
      upstreamStatus: 200,
    });
  });

  it("still rejects an invalid key in observe mode", async () => {
    const { app, store, calls } = setupWith({ mode: "observe" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer ga_this-key-does-not-exist" },
      payload: chat(),
    });
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
    expect((await proxyLedger(store))[0]).toMatchObject({ verdict: "denied", reason: "invalid_key" });
  });

  it("health reports observe", async () => {
    const { app } = setupWith({ mode: "observe" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({ status: "ok", mode: "observe" });
  });

  it("streams are forwarded and observed", async () => {
    const usageBlock = `data: ${JSON.stringify({ id: "c1", choices: [], usage: { prompt_tokens: 20, completion_tokens: 7 } }) }\n\n`;
    const ev1 = `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "Sal" } }] }) }\n\n`;
    const ev2 = `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "ut" } }] }) }\n\n`;
    const done = "data: [DONE]\n\n";
    const full = ev1 + ev2 + usageBlock + done;
    const { app, store, calls } = setupWith({ mode: "observe" }, () => sseResponse([full]));
    const { key } = await createAgent(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: chat("gpt-4o", { stream: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    const [row] = await waitForLedger(store, 1);
    expect(row).toMatchObject({ verdict: "allowed", reason: "observed:model_not_allowed", promptTokens: 20, completionTokens: 7 });
  });
});

describe("observe mode: stats and report", () => {
  it("counts observed reasons separately in /admin/stats", async () => {
    const { app, store } = setupWith({ mode: "observe" }, () => jsonResponse(completion));
    const { key } = await createAgent(app);
    await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: chat("gpt-4o") });
    const stats = await app.inject({ method: "GET", url: "/admin/stats", headers: adminHeaders });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().totals).toMatchObject({
      allowed: 1,
      denied: 0,
      observedByReason: { "observed:model_not_allowed": 1 },
    });
  });
});

const mcpServers = { gh: { url: "https://mcp.test/gh", headers: { authorization: "Bearer SECRET" } } };
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: "2.0", method, params, ...(id === null ? {} : { id }) });
const mcpCall = (name: string, args: unknown = { q: "x" }) => rpc("tools/call", { name, arguments: args });
const mcpOk = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } };

describe("observe mode: mcp", () => {
  it("forwards a non-allowed tool and logs observed:tool_not_allowed", async () => {
    const { app, store, calls } = setupWith({ mode: "observe", mcpServers }, () => jsonResponse(mcpOk));
    const { agent, key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: [], dailyBudgetUsd: 0, unlimited: true });
    const res = await app.inject({
      method: "POST",
      url: "/mcp/gh",
      headers: { authorization: `Bearer ${key}` },
      payload: mcpCall("search"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(mcpOk);
    expect(calls).toHaveLength(1);
    const [row] = await proxyLedger(store);
    expect(row).toMatchObject({
      agentId: agent.id,
      action: "mcp.tools/call",
      model: "gh/search#write",
      verdict: "allowed",
      reason: "observed:tool_not_allowed",
      upstreamStatus: 200,
    });
  });

  it("skips approval and logs observed:approval_required", async () => {
    const { app, store, calls } = setupWith({ mode: "observe", mcpServers }, () => jsonResponse(mcpOk));
    const { agent, key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: ["*"], approvalTools: ["gh/search"], dailyBudgetUsd: 0, unlimited: true });
    const res = await app.inject({
      method: "POST",
      url: "/mcp/gh",
      headers: { authorization: `Bearer ${key}` },
      payload: mcpCall("search", { q: "sensitive-word" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(mcpOk);
    expect(calls).toHaveLength(1);
    const [row] = await proxyLedger(store);
    expect(row).toMatchObject({
      agentId: agent.id,
      action: "mcp.tools/call",
      model: "gh/search#write",
      verdict: "allowed",
      reason: "observed:approval_required",
      upstreamStatus: 200,
    });
    expect(row!.requestHash).toBe(sha256(canonicalJson({ q: "sensitive-word" })));
  });
});
