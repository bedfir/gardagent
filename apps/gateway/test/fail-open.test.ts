import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, verifyChain, type Approval, type LedgerEntry, type LedgerInput } from "@gardagent/core";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { failOpenActive, parseDbOutage, parseSpoolMaxBytes, type GatewayConfig } from "../src/config.js";
import { ledgerGuardFor, SpoolError } from "../src/ledger-guard.js";
import { adminHeaders, config, createAgent, jsonResponse, sseResponse } from "./helpers.js";

/** MemoryStore whose database can be switched off: every call that touches it fails, like a dead connection. */
class OutageStore extends MemoryStore {
  down = false;
  private check() {
    if (this.down) throw new Error("connection refused");
  }
  override async ping() {
    this.check();
  }
  override async appendLedger(input: LedgerInput): Promise<LedgerEntry> {
    this.check();
    return super.appendLedger(input);
  }
  override async findAgentByKeyHash(hash: string) {
    this.check();
    return super.findAgentByKeyHash(hash);
  }
  hang = false;
  override async getSpent(agentId: string, day: string) {
    if (this.hang) return new Promise<number>(() => undefined); // dead connection: never answers
    this.check();
    return super.getSpent(agentId, day);
  }
  override async reserve(...args: Parameters<MemoryStore["reserve"]>) {
    this.check();
    return super.reserve(...args);
  }
  override async settleReservation(...args: Parameters<MemoryStore["settleReservation"]>) {
    this.check();
    return super.settleReservation(...args);
  }
  override async addSpend(...args: Parameters<MemoryStore["addSpend"]>) {
    this.check();
    return super.addSpend(...args);
  }
  override async createApproval(approval: Approval) {
    this.check();
    return super.createApproval(approval);
  }
  override async listAgents(...args: Parameters<MemoryStore["listAgents"]>) {
    this.check();
    return super.listAgents(...args);
  }
}

const completion = { id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
const chat = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] };
const anthropicBody = { model: "gpt-4o-mini", max_tokens: 16, messages: [{ role: "user", content: "hello" }] };
const sseChunks = [
  `data: ${JSON.stringify({ id: "s", choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`,
  `data: ${JSON.stringify({ id: "s", choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`,
  "data: [DONE]\n\n",
];
const mcpServers = { gh: { url: "https://mcp.test/gh", headers: {}, readTools: ["search"] } };
const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } };

interface Opts extends Partial<GatewayConfig> {
  spoolFile?: string;
}

function setup(overrides: Opts = {}, responder: () => Response = () => jsonResponse(completion)) {
  const store = new OutageStore();
  const dir = mkdtempSync(join(tmpdir(), "ga-failopen-"));
  const spool = overrides.spoolFile ?? join(dir, "spool", "ledger.jsonl");
  let upstream = 0;
  const fetchFn = (async () => {
    upstream += 1;
    return responder();
  }) as unknown as typeof fetch;
  const cfg: GatewayConfig = { ...config, mode: "observe", dbOutage: "fail-open", ledgerSpoolPath: spool, ...overrides };
  const app = buildApp({ config: cfg, store, fetch: fetchFn });
  const guard = ledgerGuardFor(store, console, {});
  const spooled = () => (existsSync(spool) ? readFileSync(spool, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { app, store, spool, guard, spooled, upstreamCalls: () => upstream, dir };
}

const postChat = (app: ReturnType<typeof setup>["app"], key: string, payload: unknown = chat) =>
  app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: payload as object });
const postMcp = (app: ReturnType<typeof setup>["app"], key: string, payload: unknown) =>
  app.inject({ method: "POST", url: "/mcp/gh", headers: { authorization: `Bearer ${key}` }, payload: payload as object });
const agentBody = { name: "bot", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 1 };

describe("config", () => {
  it("parses the outage policy and the cap; fail-open is effective only in observe mode", () => {
    expect(parseDbOutage(undefined)).toBe("fail-closed");
    expect(parseDbOutage("fail-open")).toBe("fail-open");
    expect(() => parseDbOutage("open")).toThrow(/GARDAGENT_DB_OUTAGE/);
    expect(parseSpoolMaxBytes(undefined)).toBe(64 * 1024 * 1024);
    expect(parseSpoolMaxBytes("10000")).toBe(10000);
    expect(() => parseSpoolMaxBytes("12")).toThrow(/GARDAGENT_SPOOL_MAX_BYTES/);
    expect(failOpenActive({ mode: "observe", dbOutage: "fail-open" })).toBe(true);
    expect(failOpenActive({ mode: "enforce", dbOutage: "fail-open" })).toBe(false);
    expect(failOpenActive({ mode: "observe", dbOutage: "fail-closed" })).toBe(false);
    expect(failOpenActive({ mode: "observe" })).toBe(false);
  });
});

describe("fail-open (observe): database down", () => {
  it("passes OpenAI-compatible traffic, spools durably with cost data, and replays once after recovery", async () => {
    const { app, store, guard, spooled, upstreamCalls } = setup();
    const { key } = await createAgent(app, agentBody);
    expect((await postChat(app, key)).statusCode).toBe(200); // warm: the agent is known to the gateway
    const before = (await store.listLedger()).length;

    store.down = true;
    const res = await postChat(app, key);
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe("ok");
    expect(upstreamCalls()).toBe(2);
    // The row is on disk by the time the client has the answer.
    const lines = spooled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      action: "chat.completions", model: "gpt-4o-mini", verdict: "allowed", upstreamStatus: 200, promptTokens: 10, completionTokens: 5,
      spoolMeta: { degraded: true, budgetSettlement: "pending", estimatedCost: expect.any(Number) },
    });
    expect(lines[0].cost).toBeGreaterThan(0);
    expect(lines[0].spoolMeta.budgetDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(guard.spoolBacklog()).toBe(1);

    // /health: degraded but serving (200), with explicit ledger fields; existing fields kept.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "degraded", mode: "observe", database: "down", spoolBacklog: 1,
      ledger: { status: "degraded", dbOutagePolicy: "fail-open", spool: { backlog: 1, writable: true, maxBytes: 64 * 1024 * 1024 } },
    });
    expect(health.json().ledger.spool.bytes).toBeGreaterThan(0);

    // Recovery: replayed exactly once, in order, chain valid.
    store.down = false;
    expect(await guard.probe()).toBe(true);
    expect(await guard.replay()).toBe(1);
    expect(await guard.replay()).toBe(0);
    expect(spooled()).toHaveLength(0);
    const rows = await store.listLedger();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).not.toHaveProperty("spoolMeta");
    expect(verifyChain(rows).valid).toBe(true);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ status: "ok", ledger: { status: "ok" } });
  });

  it("passes streaming (OpenAI) and Anthropic requests; spool written before the stream is acknowledged", async () => {
    let n = 0;
    const { app, store, guard, spooled } = setup({}, () =>
      n++ < 2 ? sseResponse(sseChunks) : jsonResponse({ id: "m", type: "message", content: [], usage: { input_tokens: 4, output_tokens: 2 } }),
    );
    const { key } = await createAgent(app, agentBody);
    // warm the cache with a request that succeeds while the database is up
    await postChat(app, key, { ...chat, stream: true });
    store.down = true;
    const stream = await postChat(app, key, { ...chat, stream: true });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain("[DONE]");
    expect(spooled()).toHaveLength(1);
    const msg = await app.inject({
      method: "POST", url: "/v1/messages", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, payload: anthropicBody,
    });
    expect(msg.statusCode).toBe(200);
    expect(spooled()).toHaveLength(2);
    expect(spooled()[1]).toMatchObject({ action: expect.stringContaining("messages"), promptTokens: 4, completionTokens: 2 });
    store.down = false;
    await guard.probe();
    expect(await guard.replay()).toBe(2);
    expect(verifyChain(await store.listLedger()).valid).toBe(true);
  });

  it("does not wait for a database call that hangs (bounded, then served and spooled)", async () => {
    const { app, store, spooled, upstreamCalls } = setup();
    const { key } = await createAgent(app, agentBody);
    await postChat(app, key);
    store.down = true;
    store.hang = true;
    const t0 = Date.now();
    const res = await postChat(app, key);
    expect(res.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(upstreamCalls()).toBe(2);
    expect(spooled()).toHaveLength(1);
  });

  it("refuses an unknown key and admin routes while the database is down", async () => {
    const { app, store, upstreamCalls } = setup();
    const { key } = await createAgent(app, agentBody);
    await postChat(app, key);
    store.down = true;
    const unknown = await postChat(app, "ga_" + "0".repeat(40));
    expect(unknown.statusCode).toBe(503);
    const admin = await app.inject({ method: "GET", url: "/admin/agents", headers: adminHeaders });
    expect(admin.statusCode).toBe(503);
    expect(upstreamCalls()).toBe(1);
  });
});

describe("fail-closed behavior is kept", () => {
  it("blocking mode stays fail-closed even with fail-open configured", async () => {
    const { app, store, upstreamCalls, spooled } = setup({ mode: "enforce" });
    const { key } = await createAgent(app, agentBody);
    await postChat(app, key);
    store.down = true;
    const res = await postChat(app, key);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("ledger_unavailable");
    expect(upstreamCalls()).toBe(1);
    expect(spooled()).toHaveLength(0);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(503);
    expect(health.json().ledger).toMatchObject({ status: "down", dbOutagePolicy: "fail-closed" });
  });

  it("observe mode without the setting (default) is fail-closed", async () => {
    const { app, store, upstreamCalls } = setup({ dbOutage: "fail-closed" });
    const { key } = await createAgent(app, agentBody);
    await postChat(app, key);
    store.down = true;
    expect((await postChat(app, key)).statusCode).toBe(503);
    expect(upstreamCalls()).toBe(1);
  });
});

describe("proof first: no durable spool, no traffic", () => {
  it("unwritable spool -> 503, nothing forwarded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-unwritable-"));
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const { app, store, upstreamCalls } = setup({ spoolFile: join(blocker, "ledger.jsonl") });
    const { key } = await createAgent(app, agentBody);
    await postChat(app, key);
    store.down = true;
    const res = await postChat(app, key);
    expect(res.statusCode).toBe(503);
    expect(upstreamCalls()).toBe(1);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(503);
    expect(health.json().ledger).toMatchObject({ status: "down", spool: { writable: false } });
  });

  it("spool at its size cap -> 503, nothing forwarded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-full-"));
    const spoolFile = join(dir, "ledger.jsonl");
    writeFileSync(spoolFile, "x".repeat(5000));
    const { app, store, upstreamCalls } = setup({ spoolFile, spoolMaxBytes: 5000 });
    const { key } = await createAgent(app, agentBody);
    await postChat(app, key);
    store.down = true;
    const res = await postChat(app, key);
    expect(res.statusCode).toBe(503);
    expect(upstreamCalls()).toBe(1);
  });

  it("an entry that would exceed the cap is rejected, never silently dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ga-cap-"));
    const { store, guard } = setup({ spoolFile: join(dir, "ledger.jsonl"), spoolMaxBytes: 4096 });
    store.down = true;
    const entry: LedgerInput = {
      ts: new Date().toISOString(), agentId: null, action: "chat.completions", model: "m", verdict: "allowed", reason: null,
      upstreamStatus: 200, promptTokens: 1, completionTokens: 1, cost: 0, requestHash: "r", responseHash: null,
    };
    let accepted = 0;
    let rejected: unknown = null;
    for (let i = 0; i < 100 && !rejected; i++) {
      try {
        await guard.append(entry);
        accepted += 1;
      } catch (error) {
        rejected = error;
      }
    }
    expect(rejected).toBeInstanceOf(SpoolError);
    expect(guard.spoolBacklog()).toBe(accepted);
    store.down = false;
    await guard.probe();
    expect(await guard.replay()).toBe(accepted);
  });
});

describe("MCP during a database outage (fail-open)", () => {
  async function mcpSetup(approvalTools: string[] = []) {
    const t = setup({ mcpServers }, () => jsonResponse(ok));
    const { key } = await createAgent(t.app, { name: "bot", allowedModels: ["*"], allowedTools: ["gh/*"], approvalTools, dailyBudgetUsd: 0, unlimited: true });
    // warm the agent cache with a read call while the database is up
    expect((await postMcp(t.app, key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: {} } })).statusCode).toBe(200);
    t.store.down = true;
    return { ...t, key };
  }
  const callTool = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { q: "x" } } });

  it("a read tool passes and is spooled", async () => {
    const { app, key, spooled, upstreamCalls } = await mcpSetup();
    const res = await postMcp(app, key, callTool("search"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ok);
    expect(upstreamCalls()).toBe(2);
    expect(spooled()).toHaveLength(1);
    expect(spooled()[0]).toMatchObject({ action: "mcp.tools/call", model: "gh/search#read", verdict: "allowed" });
  });

  it("a write tool is refused, never forwarded", async () => {
    const { app, key, spooled, upstreamCalls } = await mcpSetup();
    const res = await postMcp(app, key, callTool("delete_everything"));
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toContain("approval");
    expect(upstreamCalls()).toBe(1);
    expect(spooled()[0]).toMatchObject({ model: "gh/delete_everything#write", verdict: "denied", reason: "approval_unavailable_db_outage" });
  });

  it("a read tool that requires approval is refused", async () => {
    const { app, key, upstreamCalls } = await mcpSetup(["gh/search"]);
    // warm call above ran with approval skipped (observe); during the outage it must be refused
    const res = await postMcp(app, key, callTool("search"));
    expect(res.statusCode).toBe(503);
    expect(upstreamCalls()).toBe(1);
  });
});
