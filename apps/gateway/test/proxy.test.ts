import { budgetDay } from "@gardagent/core";
import { describe, expect, it } from "vitest";
import { createAgent, jsonResponse, proxyLedger, setup, sseResponse, waitForLedger } from "./helpers.js";

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

describe("proxy: authentication", () => {
  it.each([
    ["missing", undefined],
    ["invalid", "Bearer ga_this-key-does-not-exist-at-all"],
    ["malformed", "Bearer nope"],
  ])("%s key -> 401 and ledger denied/invalid_key", async (_n, auth) => {
    const { app, store, calls } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth ? { authorization: auth } : {},
      payload: chat(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_api_key");
    expect(calls).toHaveLength(0);
    const ledger = await proxyLedger(store);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ verdict: "denied", reason: "invalid_key", agentId: null });
  });
});

describe("proxy: non-streaming", () => {
  it("relays the response, uses the upstream key, logs and counts the spend", async () => {
    const { app, store, calls } = setup(() => jsonResponse(completion));
    const { agent, key } = await createAgent(app);

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: chat(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(completion);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://upstream.test/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-upstream-test");
    expect(JSON.stringify(calls[0]!.headers)).not.toContain(key);

    const [row] = await proxyLedger(store);
    expect(row).toMatchObject({
      agentId: agent.id,
      verdict: "allowed",
      reason: null,
      upstreamStatus: 200,
      promptTokens: 100,
      completionTokens: 50,
      model: "gpt-4o-mini",
    });
    expect(row!.cost).toBeGreaterThan(0);
    expect(row!.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.responseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.getSpent(agent.id, budgetDay())).toBe(row!.cost);
  });

  it("non-allowed model -> 403 without upstream call", async () => {
    const { app, store, calls } = setup(() => jsonResponse(completion));
    const { key } = await createAgent(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: chat("gpt-4o"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("model_not_allowed");
    expect(calls).toHaveLength(0);
    expect((await proxyLedger(store))[0]).toMatchObject({ verdict: "denied", reason: "model_not_allowed" });
  });

  it("budget exceeded -> 429 on the second request", async () => {
    const { app, calls } = setup(() => jsonResponse(completion));
    // 100 tokens * 0.15 + 50 * 0.6 = 45 micro-$ ; budget de 0.00001 $ = 10 micro-$
    const { key } = await createAgent(app, { name: "tiny", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 0.00001 });
    const send = () =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${key}` },
        payload: chat("gpt-4o-mini", { max_tokens: 10 }),
      });
    expect((await send()).statusCode).toBe(200);
    const second = await send();
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("budget_exceeded");
    expect(calls).toHaveLength(1);
  });
});

describe("proxy: streaming", () => {
  const usageBlock = `data: ${JSON.stringify({ id: "c1", choices: [], usage: { prompt_tokens: 20, completion_tokens: 7 } })}\n\n`;
  const ev1 = `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "Sal" } }] })}\n\n`;
  const ev2 = `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "ut" } }] })}\n\n`;
  const done = "data: [DONE]\n\n";
  const full = ev1 + ev2 + usageBlock + done;

  /** Irregular splitting, including in the middle of an event. */
  function irregular(text: string): string[] {
    const cuts = [7, 25, ev1.length + 3, ev1.length + ev2.length - 1, ev1.length + ev2.length + 10, text.length - 4];
    const out: string[] = [];
    let last = 0;
    for (const c of cuts) {
      out.push(text.slice(last, c));
      last = c;
    }
    out.push(text.slice(last));
    return out;
  }

  it("injects include_usage, hides the usage block and records it", async () => {
    const { app, store, calls } = setup(() => sseResponse(irregular(full)));
    const { key } = await createAgent(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: chat("gpt-4o-mini", { stream: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body.stream_options.include_usage).toBe(true);
    expect(res.body).toBe(ev1 + ev2 + done);
    expect(res.body).not.toContain('"usage"');

    const [row] = await waitForLedger(store, 1);
    expect(row).toMatchObject({ verdict: "allowed", reason: null, promptTokens: 20, completionTokens: 7 });
    expect(row!.cost).toBeGreaterThan(0);
  });

  it("relays the usage block if the client requested it", async () => {
    const { app, store, calls } = setup(() => sseResponse(irregular(full)));
    const { key } = await createAgent(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: chat("gpt-4o-mini", { stream: true, stream_options: { include_usage: true } }),
    });
    expect(calls[0]!.body.stream_options.include_usage).toBe(true);
    expect(res.body).toBe(full);
    const [row] = await waitForLedger(store, 1);
    expect(row).toMatchObject({ promptTokens: 20, completionTokens: 7 });
  });
});

describe("proxy: provider errors", () => {
  it("unreachable provider -> 502 and ledger", async () => {
    const { app, store } = setup(() => {
      throw new TypeError("fetch failed");
    });
    const { key } = await createAgent(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: chat(),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("upstream_unreachable");
    expect((await proxyLedger(store))[0]).toMatchObject({ reason: "upstream_unreachable", upstreamStatus: null });
  });

  it("provider error 500 -> status relayed, reason upstream_error", async () => {
    const { app, store } = setup(() => jsonResponse({ error: { message: "boom" } }, 500));
    const { key } = await createAgent(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: chat(),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { message: "boom" } });
    expect((await proxyLedger(store))[0]).toMatchObject({ reason: "upstream_error", upstreamStatus: 500, cost: 0 });
  });
});
