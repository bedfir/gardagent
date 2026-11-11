import { MemoryStore } from "@gardagent/core";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config, createAgent, fakeFetch, jsonResponse, proxyLedger, adminHeaders, type Responder } from "./helpers.js";
import type { GatewayConfig } from "../src/config.js";

const completion = { id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const BAD_KEY = "Bearer ga_this-key-does-not-exist-at-all";
const chat = (extra: Record<string, unknown> = {}) => ({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }], ...extra });

function make(overrides: Partial<GatewayConfig> = {}, clock?: () => number, responder: Responder = () => jsonResponse(completion)) {
  const store = new MemoryStore();
  const f = fakeFetch(responder);
  const app = buildApp({ config: { ...config, authFailLimit: 3, authFailWindowMs: 60_000, ...overrides }, store, fetch: f.fetch, clock });
  return { app, store, ...f };
}

const badAgent = (app: ReturnType<typeof buildApp>, remoteAddress?: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/v1/chat/completions", remoteAddress, headers: { authorization: BAD_KEY, ...headers }, payload: chat() });
const badAdmin = (app: ReturnType<typeof buildApp>, remoteAddress?: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/admin/agents", remoteAddress, headers: { authorization: "Bearer wrong", ...headers } });

describe("authentication failure rate limit (E3b)", () => {
  it("admin: answers 429 with Retry-After after the limit, while another address is served", async () => {
    const { app } = make();
    for (let i = 0; i < 3; i++) expect((await badAdmin(app, "10.0.0.1")).statusCode).toBe(401);
    const blocked = await badAdmin(app, "10.0.0.1");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(blocked.headers["retry-after"])).toBeLessThanOrEqual(60);
    const other = await app.inject({ method: "GET", url: "/admin/agents", remoteAddress: "10.0.0.2", headers: adminHeaders });
    expect(other.statusCode).toBe(200);
  });

  it("agent keys: 429 after the limit for the same address only", async () => {
    const { app, calls } = make();
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 1 });
    for (let i = 0; i < 3; i++) expect((await badAgent(app, "10.0.0.1")).statusCode).toBe(401);
    const blocked = await badAgent(app, "10.0.0.1");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    const ok = await app.inject({ method: "POST", url: "/v1/chat/completions", remoteAddress: "10.0.0.2", headers: { authorization: `Bearer ${key}` }, payload: chat() });
    expect(ok.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("failed admin attempts do not block agent traffic from the same address", async () => {
    const { app } = make();
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 1 });
    for (let i = 0; i < 4; i++) await badAdmin(app, "10.0.0.1");
    expect((await badAdmin(app, "10.0.0.1")).statusCode).toBe(429);
    const ok = await app.inject({ method: "POST", url: "/v1/chat/completions", remoteAddress: "10.0.0.1", headers: { authorization: `Bearer ${key}` }, payload: chat() });
    expect(ok.statusCode).toBe(200);
  });

  it("is disabled with a limit of 0", async () => {
    const { app } = make({ authFailLimit: 0 });
    for (let i = 0; i < 25; i++) expect((await badAdmin(app, "10.0.0.1")).statusCode).toBe(401);
    for (let i = 0; i < 25; i++) expect((await badAgent(app, "10.0.0.1")).statusCode).toBe(401);
  });

  it("counts attempts again once the window has passed", async () => {
    let now = 1_000_000;
    const { app } = make({}, () => now);
    for (let i = 0; i < 4; i++) await badAdmin(app, "10.0.0.1");
    expect((await badAdmin(app, "10.0.0.1")).statusCode).toBe(429);
    now += 60_001;
    expect((await badAdmin(app, "10.0.0.1")).statusCode).toBe(401);
  });

  it("behind trustProxy the client address comes from X-Forwarded-For; without it the header cannot dodge the limit", async () => {
    const trusted = make({ trustProxy: ["172.20.0.0/16"] });
    for (let i = 0; i < 3; i++) await badAdmin(trusted.app, "172.20.0.5", { "x-forwarded-for": "1.1.1.1" });
    expect((await badAdmin(trusted.app, "172.20.0.5", { "x-forwarded-for": "1.1.1.1" })).statusCode).toBe(429);
    expect((await badAdmin(trusted.app, "172.20.0.5", { "x-forwarded-for": "2.2.2.2" })).statusCode).toBe(401);

    const untrusted = make();
    for (let i = 0; i < 3; i++) await badAdmin(untrusted.app, "10.0.0.1", { "x-forwarded-for": `9.9.9.${i}` });
    expect((await badAdmin(untrusted.app, "10.0.0.1", { "x-forwarded-for": "9.9.9.200" })).statusCode).toBe(429);
  });
});

describe("invalid_key ledger rows are capped (E3c)", () => {
  it("writes the first failure, aggregates the following ones and keeps the chain valid", async () => {
    let now = 5_000_000;
    const { app, store } = make({ authFailLimit: 0 }, () => now);
    for (let i = 0; i < 6; i++) await badAgent(app, "10.0.0.1");
    let rows = await proxyLedger(store);
    expect(rows.map((r) => r.reason)).toEqual(["invalid_key"]);

    now += 60_001;
    await badAgent(app, "10.0.0.1"); // new window: closes the old one with its count
    rows = await proxyLedger(store);
    expect(rows.map((r) => r.reason)).toEqual(["invalid_key", "invalid_key_repeated:5", "invalid_key"]);
    expect(rows.every((r) => r.verdict === "denied" && r.agentId === null)).toBe(true);
  });

  it("an address other than the first is logged on its own", async () => {
    const { app, store } = make({ authFailLimit: 0 });
    await badAgent(app, "10.0.0.1");
    await badAgent(app, "10.0.0.1");
    await badAgent(app, "10.0.0.2");
    expect((await proxyLedger(store)).map((r) => r.reason)).toEqual(["invalid_key", "invalid_key"]);
  });

  it("flushes the pending count when the application closes", async () => {
    const { app, store } = make({ authFailLimit: 0 });
    for (let i = 0; i < 4; i++) await badAgent(app, "10.0.0.1");
    await app.close();
    expect((await proxyLedger(store)).map((r) => r.reason)).toEqual(["invalid_key", "invalid_key_repeated:3"]);
  });
});

describe("body size before authentication (E3d)", () => {
  const big = () => chat({ padding: "x".repeat(200_000) });

  it("refuses a large body from a request without an agent key, before reading it all", async () => {
    const { app } = make();
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: big() });
    expect(res.statusCode).toBe(413);
  });

  it("still accepts a small unauthenticated body (401 as before)", async () => {
    const { app } = make();
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: chat() });
    expect(res.statusCode).toBe(401);
  });

  it("keeps the large limit for a request carrying a well-formed agent key", async () => {
    const { app } = make();
    const { key } = await createAgent(app, { name: "bot", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 1 });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: big() });
    expect(res.statusCode).toBe(200);
  });
});
