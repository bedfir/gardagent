import { describe, expect, it, vi } from "vitest";
import { policyRevision, type Agent } from "@gardagent/core";
import { AgentRateLimiter } from "../src/rate-limiter.js";
import { createAgent, jsonResponse, setup, setupWith, waitUntil, adminHeaders } from "./helpers.js";

const policy = { id: "a", requestsPerMinute: 2, maxConcurrentRequests: 2 } as Agent;

describe("agent rate limits", () => {
  it("serializes boundary admissions and isolates agents", async () => {
    const limiter = new AgentRateLimiter(() => 1000);
    const results = await Promise.all(Array.from({ length: 20 }, async () => limiter.acquire(policy)));
    expect(results.filter(r => !r.retryAfter)).toHaveLength(2);
    expect(limiter.acquire({ ...policy, id: "b" }).retryAfter).toBeUndefined();
  });

  it("rounds Retry-After up and expires exactly at 60 seconds", () => {
    let now = 0;
    const limiter = new AgentRateLimiter(() => now);
    limiter.acquire({ ...policy, requestsPerMinute: 1 }).release();
    now = 1001;
    expect(limiter.acquire({ ...policy, requestsPerMinute: 1 }).retryAfter).toBe(59);
    now = 60_000;
    expect(limiter.acquire({ ...policy, requestsPerMinute: 1 }).retryAfter).toBeUndefined();
  });

  it("releases concurrency idempotently", () => {
    const limiter = new AgentRateLimiter();
    const agent = { ...policy, requestsPerMinute: 0, maxConcurrentRequests: 1 };
    const first = limiter.acquire(agent);
    expect(limiter.acquire(agent).retryAfter).toBe(1);
    first.release(); first.release();
    expect(limiter.acquire(agent).retryAfter).toBeUndefined();
  });

  it("refuses before reservation and journals the refusal", async () => {
    const { app, store, calls } = setup(() => jsonResponse({}));
    try {
      const { key } = await createAgent(app, { name: "limited", allowedModels: ["*"], dailyBudgetUsd: 10, requestsPerMinute: 1 });
      const request = { method: "POST" as const, url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: { model: "gpt-4o-mini" } };
      expect((await app.inject(request)).statusCode).toBe(200);
      const reserve = vi.spyOn(store, "reserve");
      const refused = await app.inject(request);
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(59);
      expect(reserve).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      expect((await store.listLedger()).at(-1)).toMatchObject({ reason: "rate_limited", cost: 0, verdict: "denied" });
    } finally { await app.close(); }
  });

  it("observe mode forwards and journals the reason", async () => {
    const { app, store } = setupWith({ mode: "observe" }, () => jsonResponse({}));
    try {
      const { key } = await createAgent(app, { name: "limited", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true, requestsPerMinute: 1 });
      for (let i = 0; i < 2; i++) expect((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: { model: "gpt-4o-mini" } })).statusCode).toBe(200);
      expect((await store.listLedger()).at(-1)?.reason).toBe("observed:rate_limited");
    } finally { await app.close(); }
  });
});


describe("rate limit lifecycle", () => {
  it.each([
    ["openai", "complete"], ["openai", "error"], ["openai", "disconnect"],
    ["anthropic", "complete"], ["anthropic", "error"], ["anthropic", "disconnect"],
  ] as const)("releases a %s streaming slot on %s", async (provider, outcome) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let calls = 0;
    const { app } = setup(() => {
      calls++;
      if (calls > 1) return jsonResponse({});
      return new Response(new ReadableStream<Uint8Array>({ start(c) {
        controller = c;
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
      } }), { headers: { "content-type": "text/event-stream" } });
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const { key } = await createAgent(app, { name: "stream", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true, maxConcurrentRequests: 1 });
      const url = await app.listen({ host: "127.0.0.1", port: 0 });
      const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
      const endpoint = provider === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
      const response = await fetch(`${url}${endpoint}`, { method: "POST", headers, body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 10, stream: true }) });
      reader = response.body!.getReader();
      await reader.read();
      const request = { method: "POST" as const, url: endpoint, headers, payload: { model: "gpt-4o-mini" } };
      expect((await app.inject(request)).statusCode).toBe(429);
      if (outcome === "disconnect") await reader.cancel();
      else {
        if (outcome === "error") controller.error(new Error("fake stream error"));
        else controller.close();
        while (!(await reader.read()).done) { /* drain the stream */ }
      }
      // Poll admission, not elapsed time: close is delivered asynchronously by the socket.
      const next = await waitUntil(() => app.inject(request), r => r.statusCode !== 429);
      expect(next.statusCode).toBe(200);
      expect(calls).toBe(2);
    } finally {
      // The fake source does not implement fetch's abort propagation.
      try { controller?.close(); } catch { /* already closed */ }
      await reader?.cancel().catch(() => undefined);
      await app.close();
    }
  });

  it("changes policy revision when limits change and preserves unlimited historical revisions", async () => {
    const { app, store } = setup();
    try {
      const { agent } = await createAgent(app);
      const before = (await store.getAgent(agent.id))!;
      const original = policyRevision(before).id;
      expect(policyRevision({ ...before, requestsPerMinute: 0, maxConcurrentRequests: 0 }).id).toBe(original);
      const changed = await app.inject({ method: "PATCH", url: `/admin/agents/${agent.id}`, headers: adminHeaders, payload: { requestsPerMinute: 5, maxConcurrentRequests: 1 } });
      expect(changed.statusCode).toBe(200);
      expect(policyRevision((await store.getAgent(agent.id))!).id).not.toBe(original);
      expect((await store.listLedger()).at(-1)?.policyRev).toBe(policyRevision((await store.getAgent(agent.id))!).id);
    } finally { await app.close(); }
  });
});

it("shares the boundary across model endpoints and MCP, and isolates agents", async () => {
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const { app, calls } = setupWith({ mcpServers: { local: { url: "http://mcp.test", headers: {} } } }, async () => {
    entered();
    await new Promise<void>(resolve => { finish = resolve; });
    return jsonResponse({});
  });
  let pending: PromiseLike<unknown> | undefined;
  try {
    const first = await createAgent(app, { name: "one", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true, maxConcurrentRequests: 1 });
    const second = await createAgent(app);
    const request = { method: "POST" as const, url: "/v1/chat/completions", headers: { authorization: `Bearer ${first.key}` }, payload: { model: "gpt-4o-mini" } };
    pending = app.inject(request).then(r => r);
    await started;
    const refusals = await Promise.all(Array.from({ length: 8 }, () => app.inject(request)));
    expect(refusals.every(r => r.statusCode === 429 && r.headers["retry-after"] === "1")).toBe(true);
    expect(calls).toHaveLength(1);
    const anthropic = await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": first.key }, payload: { model: "gpt-4o-mini", max_tokens: 10, messages: [] } });
    expect(anthropic.statusCode).toBe(429);
    expect(anthropic.json().error.type).toBe("rate_limit_error");
    const mcp = (key: string, notification = false) => app.inject({ method: "POST", url: "/mcp/local", headers: { authorization: `Bearer ${key}` }, payload: notification ? { jsonrpc: "2.0", method: "notifications/initialized" } : { jsonrpc: "2.0", id: 1, method: "ping" } });
    expect((await mcp(first.key)).json().error).toMatchObject({ code: -32004, data: { retryAfter: 1 } });
    const notification = await mcp(first.key, true);
    expect(notification.statusCode).toBe(429);
    expect(notification.body).toBe("");
    expect((await mcp(second.key)).json().result).toEqual({});
    finish();
    await pending;
    expect((await mcp(first.key)).json().result).toEqual({});
  } finally { finish?.(); await pending; await app.close(); }
});

it.each([-1, 0.5, 2147483648, "1", null])("rejects invalid policy limit %j on creation and update", async value => {
  const { app } = setup();
  try {
    const { agent } = await createAgent(app);
    for (const field of ["requestsPerMinute", "maxConcurrentRequests"]) {
      const payload = { name: "invalid", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true, [field]: value };
      expect((await app.inject({ method: "POST", url: "/admin/agents", headers: adminHeaders, payload })).statusCode).toBe(400);
      expect((await app.inject({ method: "PATCH", url: `/admin/agents/${agent.id}`, headers: adminHeaders, payload: { [field]: value } })).statusCode).toBe(400);
    }
  } finally { await app.close(); }
});
