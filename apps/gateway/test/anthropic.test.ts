import { budgetDay } from "@gardagent/core";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { config, createAgent, jsonResponse, proxyLedger, setup, sseResponse, waitForLedger } from "./helpers.js";

const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "salut" }],
  usage: { input_tokens: 100, output_tokens: 50 },
};

const req = (model = "gpt-4o-mini", extra: Record<string, unknown> = {}) => ({
  model,
  max_tokens: 64,
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

const post = (app: ReturnType<typeof setup>["app"], headers: Record<string, string>, payload: unknown = req()) =>
  app.inject({ method: "POST", url: "/v1/messages", headers, payload: payload as object });

describe("messages: authentication", () => {
  it("accepts the key in x-api-key and in Authorization: Bearer", async () => {
    const { app, calls } = setup(() => jsonResponse(message));
    const { key } = await createAgent(app);
    expect((await post(app, { "x-api-key": key })).statusCode).toBe(200);
    expect((await post(app, { authorization: `Bearer ${key}` })).statusCode).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["missing", {}],
    ["invalid", { "x-api-key": "ga_this-key-does-not-exist-at-all" }],
    ["malformed", { authorization: "Bearer nope" }],
  ])("%s key -> 401 in Anthropic format and ledger invalid_key", async (_n, headers) => {
    const { app, store, calls } = setup();
    const res = await post(app, headers);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Invalid or missing Gardagent agent key." },
    });
    expect(calls).toHaveLength(0);
    expect((await proxyLedger(store))[0]).toMatchObject({
      action: "messages",
      verdict: "denied",
      reason: "invalid_key",
      agentId: null,
    });
  });

  it("missing model -> 400 invalid_request_error", async () => {
    const { app } = setup();
    const { key } = await createAgent(app);
    const res = await post(app, { "x-api-key": key }, { max_tokens: 1, messages: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  });
});

describe("messages: rules and budget", () => {
  it("non-allowed model -> 403 permission_error without provider call", async () => {
    const { app, store, calls } = setup(() => jsonResponse(message));
    const { key } = await createAgent(app);
    const res = await post(app, { "x-api-key": key }, req("gpt-4o"));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.type).toBe("permission_error");
    expect(calls).toHaveLength(0);
    expect((await proxyLedger(store))[0]).toMatchObject({
      action: "messages",
      verdict: "denied",
      reason: "model_not_allowed",
    });
  });

  it("budget reached -> 429 rate_limit_error on the second request", async () => {
    const { app, calls } = setup(() => jsonResponse(message));
    const { key } = await createAgent(app, { name: "tiny", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 0.00001 });
    // A tiny max_tokens keeps the reservation under the 10 micro-$ cap; the real cost then exhausts it.
    const tiny = { ...req(), max_tokens: 1 };
    expect((await post(app, { "x-api-key": key }, tiny)).statusCode).toBe(200);
    const second = await post(app, { "x-api-key": key }, tiny);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
    expect(calls).toHaveLength(1);
  });
});

describe("messages: non-streaming", () => {
  it("relays the response with the real key in x-api-key, logs and counts the spend", async () => {
    const { app, store, calls } = setup(() => jsonResponse(message));
    const { agent, key } = await createAgent(app);
    const res = await post(app, { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "tools-2024-04-04" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(message);

    expect(calls[0]!.url).toBe("http://anthropic-upstream.test/v1/messages");
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-ant-upstream-test");
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]!.headers["anthropic-beta"]).toBe("tools-2024-04-04");
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(JSON.stringify(calls[0]!.headers)).not.toContain(key);

    const [row] = await proxyLedger(store);
    expect(row).toMatchObject({
      action: "messages",
      agentId: agent.id,
      verdict: "allowed",
      reason: null,
      upstreamStatus: 200,
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(row!.cost).toBeGreaterThan(0);
    expect(row!.responseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.getSpent(agent.id, budgetDay())).toBe(row!.cost);
  });

  it("anthropic-version defaults to 2023-06-01 and anthropic-beta is absent when not provided", async () => {
    const { app, calls } = setup(() => jsonResponse(message));
    const { key } = await createAgent(app);
    await post(app, { authorization: `Bearer ${key}` });
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]!.headers["anthropic-beta"]).toBeUndefined();
  });

  it("counts cache tokens as input tokens", async () => {
    const usage = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 };
    const { app, store } = setup(() => jsonResponse({ ...message, usage }));
    const { key } = await createAgent(app);
    await post(app, { "x-api-key": key });
    expect((await proxyLedger(store))[0]).toMatchObject({ promptTokens: 60, completionTokens: 5 });
  });
});

describe("messages: streaming", () => {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const events = [
    ev("message_start", {
      message: { id: "msg_1", usage: { input_tokens: 25, cache_read_input_tokens: 5, output_tokens: 1 } },
    }),
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    "event: ping\ndata: {\"type\": \"ping\"}\n\n",
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Sal" } }),
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ut" } }),
    ev("content_block_stop", { index: 0 }),
    ev("message_delta", { delta: { stop_reason: null }, usage: { output_tokens: 4 } }),
    ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
    ev("message_stop", {}),
  ];
  const full = events.join("");

  /** Irregular splitting, including in the middle of an event. */
  function irregular(text: string): string[] {
    const cuts = [5, 40, events[0]!.length + 3, events[0]!.length + events[1]!.length + 11, text.length - 30, text.length - 2];
    const out: string[] = [];
    let last = 0;
    for (const c of cuts) {
      out.push(text.slice(last, c));
      last = c;
    }
    out.push(text.slice(last));
    return out;
  }

  it("relays all events as-is and reconstructs usage", async () => {
    const { app, store, calls } = setup(() => sseResponse(irregular(full)));
    const { key } = await createAgent(app);
    const res = await post(app, { "x-api-key": key }, req("gpt-4o-mini", { stream: true }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(full);
    expect(calls[0]!.body.stream).toBe(true);
    expect(calls[0]!.body).not.toHaveProperty("stream_options");

    const [row] = await waitForLedger(store, 1);
    // input = 25 + 5 (cache) from message_start; output = last cumulative value from message_delta
    expect(row).toMatchObject({ action: "messages", verdict: "allowed", reason: null, promptTokens: 30, completionTokens: 9 });
    expect(row!.cost).toBeGreaterThan(0);
  });
});

describe("messages: provider errors", () => {
  it("unreachable provider -> 502 api_error and ledger", async () => {
    const { app, store } = setup(() => {
      throw new TypeError("fetch failed");
    });
    const { key } = await createAgent(app);
    const res = await post(app, { "x-api-key": key });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect((await proxyLedger(store))[0]).toMatchObject({
      action: "messages",
      reason: "upstream_unreachable",
      upstreamStatus: null,
    });
  });

  it("provider error 500 relayed, reason upstream_error", async () => {
    const body = { type: "error", error: { type: "api_error", message: "boom" } };
    const { app, store } = setup(() => jsonResponse(body, 500));
    const { key } = await createAgent(app);
    const res = await post(app, { "x-api-key": key }, req("gpt-4o-mini", { stream: true }));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual(body);
    expect((await proxyLedger(store))[0]).toMatchObject({ reason: "upstream_error", upstreamStatus: 500, cost: 0 });
  });
});

describe("messages: ledger chaining", () => {
  it("messages and chat.completions rows share the same valid chain", async () => {
    const { app } = setup(() => jsonResponse({ ...message, usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const { key } = await createAgent(app);
    await post(app, { "x-api-key": key });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: req(),
    });
    const verify = await app.inject({
      method: "GET",
      url: "/admin/ledger/verify",
      headers: { authorization: `Bearer ${config.adminToken}` },
    });
    expect(verify.json()).toMatchObject({ valid: true, checked: 3 });
  });
});

describe("Anthropic provider configuration", () => {
  const base = { UPSTREAM_BASE_URL: "https://up.test/", UPSTREAM_API_KEY: "k-openai", GARDAGENT_ADMIN_TOKEN: "t".repeat(32) };

  it("falls back to UPSTREAM_* when ANTHROPIC_* variables are absent", () => {
    const c = loadConfig({ ...base });
    expect(c.anthropicUpstreamBaseUrl).toBe("https://up.test");
    expect(c.anthropicUpstreamApiKey).toBe("k-openai");
  });

  it("uses ANTHROPIC_UPSTREAM_* when they are set", () => {
    const c = loadConfig({
      ...base,
      ANTHROPIC_UPSTREAM_BASE_URL: "https://ant.test//",
      ANTHROPIC_UPSTREAM_API_KEY: "k-ant",
    });
    expect(c.anthropicUpstreamBaseUrl).toBe("https://ant.test");
    expect(c.anthropicUpstreamApiKey).toBe("k-ant");
    expect(c.upstreamBaseUrl).toBe("https://up.test");
  });

  it("can change only the key or only the URL", () => {
    const keyOnly = loadConfig({ ...base, ANTHROPIC_UPSTREAM_API_KEY: "k-ant" });
    expect(keyOnly).toMatchObject({ anthropicUpstreamBaseUrl: "https://up.test", anthropicUpstreamApiKey: "k-ant" });
    const urlOnly = loadConfig({ ...base, ANTHROPIC_UPSTREAM_BASE_URL: "https://ant.test" });
    expect(urlOnly).toMatchObject({ anthropicUpstreamBaseUrl: "https://ant.test", anthropicUpstreamApiKey: "k-openai" });
  });
});
