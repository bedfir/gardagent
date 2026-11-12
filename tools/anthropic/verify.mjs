// Human-only live check. Never included in the automated test suite.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

if (process.env.CI !== undefined || process.env.GARDAGENT_VERIFY_ANTHROPIC !== "1") {
  console.log("SKIP: human opt-in required; CI is always refused.");
} else {
  try {
    await verify();
  } catch {
    // Do not print exceptions: they can contain upstream bodies or credentials.
    console.error("FAIL: Anthropic verification did not complete; no provider body or credentials printed.");
    process.exitCode = 1;
  }
}

async function verify() {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_VERIFY_MODEL;
  const rate = (name) => {
    const raw = process.env[name];
    assert(raw?.trim());
    const value = Number(raw);
    assert(Number.isFinite(value) && value >= 0);
    return value;
  };
  assert(key && model);
  const input = rate("ANTHROPIC_VERIFY_INPUT_RATE");
  const output = rate("ANTHROPIC_VERIFY_OUTPUT_RATE");
  const { MemoryStore, budgetDay } = await import("../../packages/core/dist/index.js");
  const { buildApp } = await import("../../apps/gateway/dist/app.js");
  const { loadConfig } = await import("../../apps/gateway/dist/config.js");
  const adminToken = randomBytes(32).toString("hex");
  const config = loadConfig({
    GARDAGENT_ADMIN_TOKEN: adminToken,
    UPSTREAM_BASE_URL: "https://api.anthropic.com",
    UPSTREAM_API_KEY: key,
  });
  config.anthropicUpstreamBaseUrl = "https://api.anthropic.com";
  config.anthropicUpstreamApiKey = key;
  config.prices = { [model]: { input, output } };
  const store = new MemoryStore();
  let captured;
  const app = buildApp({ config, store, consoleDir: null, logger: false, fetch: async (url, init) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    const upstream = await fetch(url, init);
    // Retain an independent copy without modifying the gateway's stream.
    const body = upstream.clone().text();
    captured = { status: upstream.status, type: upstream.headers.get("content-type"), body };
    return upstream;
  } });
  try {
    const created = await app.inject({ method: "POST", url: "/admin/agents",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "anthropic-verification", allowedModels: [model], dailyBudgetUsd: 0, unlimited: true } });
    assert.equal(created.statusCode, 201);
    const agent = created.json();
    let total = 0;
    for (const stream of [false, true]) {
      captured = undefined;
      const day = budgetDay();
      const response = await app.inject({ method: "POST", url: "/v1/messages",
        headers: { "x-api-key": agent.key, "anthropic-version": "2023-06-01" },
        payload: { model, max_tokens: 32, stream, messages: [{ role: "user", content: "Reply with hello." }] } });
      assert(captured);
      assert.equal(captured.status, 200);
      assert.equal(response.statusCode, captured.status);
      assert.equal(response.body, await captured.body);
      assert(captured.type?.includes(stream ? "text/event-stream" : "application/json"));
      assert(String(response.headers["content-type"]).includes(stream ? "text/event-stream" : "application/json"));
      let usage = {};
      if (stream) {
        const events = response.body.split(/\r?\n\r?\n/).flatMap((event) => {
          const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          return data ? [JSON.parse(data)] : [];
        });
        assert(events.some((e) => e.type === "message_start" && e.message?.type === "message"));
        assert(events.some((e) => e.type === "content_block_delta"));
        assert(events.some((e) => e.type === "message_stop"));
        assert(!events.some((e) => e.type === "error"));
        for (const e of events) {
          if (e.type === "message_start") usage = { ...usage, ...e.message.usage };
          if (e.type === "message_delta") usage = { ...usage, ...e.usage };
        }
      } else {
        const message = response.json();
        assert.equal(message.type, "message");
        assert.equal(message.role, "assistant");
        assert(Array.isArray(message.content) && message.content.length > 0);
        usage = message.usage;
      }
      for (const field of ["input_tokens", "output_tokens"]) assert(Number.isInteger(usage[field]) && usage[field] >= 0);
      for (const field of ["cache_creation_input_tokens", "cache_read_input_tokens"]) {
        if (usage[field] !== undefined) assert(Number.isInteger(usage[field]) && usage[field] >= 0);
      }
      const prompt = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      const cost = Math.ceil(prompt * input + usage.output_tokens * output);
      const rows = (await store.listLedger()).filter((row) => row.action === "messages");
      assert.equal(rows.length, stream ? 2 : 1);
      const row = rows.at(-1);
      assert.equal(row.agentId, agent.agent.id);
      assert.equal(row.reason, null);
      assert.equal(row.upstreamStatus, 200);
      assert.equal(row.promptTokens, prompt);
      assert.equal(row.completionTokens, usage.output_tokens);
      assert.equal(row.cost, cost);
      total += cost;
      // Refuse an ambiguous midnight-spanning run; retry on a stable UTC day.
      assert.equal(budgetDay(), day);
      assert.equal(await store.getSpent(agent.agent.id, day), total);
      console.log(`PASS: ${stream ? "streaming" : "non-streaming"}; usage and configured cost verified.`);
    }
  } finally {
    await app.close();
  }
}
