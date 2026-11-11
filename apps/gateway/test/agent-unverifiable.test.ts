import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@gardagent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { GatewayConfig } from "../src/config.js";
import { config, createAgent, jsonResponse } from "./helpers.js";

/** MemoryStore whose database can be switched off: every call that touches it fails, like a dead connection. */
class OutageStore extends MemoryStore {
  down = false;
  private check() {
    if (this.down) throw new Error("connection refused");
  }
  override async ping() {
    this.check();
  }
  override async findAgentByKeyHash(hash: string) {
    this.check();
    return super.findAgentByKeyHash(hash);
  }
  override async getSpent(agentId: string, day: string) {
    this.check();
    return super.getSpent(agentId, day);
  }
  override async reserve(...args: Parameters<MemoryStore["reserve"]>) {
    this.check();
    return super.reserve(...args);
  }
  override async appendLedger(...args: Parameters<MemoryStore["appendLedger"]>) {
    this.check();
    return super.appendLedger(...args);
  }
}

const completion = { id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
const anthropicOk = { id: "m1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 2 } };
const UNKNOWN = "ga_" + "0".repeat(40);
const CODE = "agent_unverifiable_during_outage";

function setup(overrides: Partial<GatewayConfig> = {}) {
  const store = new OutageStore();
  const dir = mkdtempSync(join(tmpdir(), "ga-unverifiable-"));
  const cfg: GatewayConfig = {
    ...config,
    mode: "observe",
    dbOutage: "fail-open",
    ledgerSpoolPath: join(dir, "spool", "ledger.jsonl"),
    mcpServers: { gh: { url: "https://mcp.test/gh", headers: {}, readTools: ["search"] } },
    ...overrides,
  };
  const fetchFn = (async (input: unknown) => (String(input).includes("anthropic") ? jsonResponse(anthropicOk) : jsonResponse(completion))) as unknown as typeof fetch;
  const app = buildApp({ config: cfg, store, fetch: fetchFn });
  return { app, store };
}

const chat = (app: ReturnType<typeof setup>["app"], key: string) =>
  app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${key}` },
    payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
  });
const messages = (app: ReturnType<typeof setup>["app"], key: string) =>
  app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": key },
    payload: { model: "gpt-4o-mini", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
  });
const mcp = (app: ReturnType<typeof setup>["app"], key: string) =>
  app.inject({
    method: "POST",
    url: "/mcp/gh",
    headers: { authorization: `Bearer ${key}` },
    payload: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search", arguments: {} } },
  });

describe("agent unverifiable during an outage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("OpenAI format: 503 agent_unverifiable_during_outage for a key unknown to the cache", async () => {
    const { app, store } = setup();
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], dailyBudgetUsd: 1 });
    expect((await chat(app, key)).statusCode).toBe(200); // cached while the database is up
    store.down = true;
    const res = await chat(app, UNKNOWN);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: {
        message: expect.stringContaining("could not be verified while the database is unreachable"),
        type: "gardagent_policy",
        code: CODE,
      },
    });
    expect((await chat(app, key)).statusCode).toBe(200); // a cached agent is still served
  });

  it("Anthropic format: 503 with the code in its own error shape", async () => {
    const { app, store } = setup();
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], dailyBudgetUsd: 1 });
    expect((await messages(app, key)).statusCode).toBe(200);
    store.down = true;
    const res = await messages(app, UNKNOWN);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      type: "error",
      error: { type: "api_error", message: expect.stringContaining("Retry later"), code: CODE },
    });
  });

  it("MCP: 503 JSON-RPC error carrying the code in error.data", async () => {
    const { app, store } = setup();
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], allowedTools: ["gh/*"], dailyBudgetUsd: 1 });
    store.down = true;
    const res = await mcp(app, UNKNOWN);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: expect.stringContaining("could not be verified"), data: { code: CODE } },
    });
    void key;
  });

  it("an agent whose cache entry is older than TTL + grace is unverifiable too", async () => {
    // The cache captures Date.now when the app is built: install the skewed clock first.
    const real = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    const { app, store } = setup();
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], dailyBudgetUsd: 1 });
    expect((await chat(app, key)).statusCode).toBe(200);
    store.down = true;
    skew = 30_000 + 120_000 - 1000; // inside TTL + grace: still served
    expect((await chat(app, key)).statusCode).toBe(200);
    skew = 30_000 + 120_000 + 5_000;
    const res = await chat(app, key);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe(CODE);
  });

  it("fail-closed keeps the genuine ledger_unavailable refusal", async () => {
    const { app, store } = setup({ mode: "enforce" });
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["*"], dailyBudgetUsd: 1 });
    expect((await chat(app, key)).statusCode).toBe(200);
    store.down = true;
    for (const call of [chat(app, key), chat(app, UNKNOWN)]) {
      const res = await call;
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("ledger_unavailable");
    }
  });

  it("a rejected key with a healthy database is still 401", async () => {
    const { app } = setup();
    const res = await chat(app, UNKNOWN);
    expect(res.statusCode).toBe(401);
  });
});
