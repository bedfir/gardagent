import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, verifyChain, type LedgerEntry, type LedgerInput } from "@gardagent/core";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ledgerGuardFor } from "../src/ledger-guard.js";
import { PgStore } from "../src/pg-store.js";
import { config, createAgent, jsonResponse, proxyLedger } from "./helpers.js";

/** MemoryStore whose database can be switched off. */
class FlakyStore extends MemoryStore {
  down = false;
  failures = 0;
  override async ping(): Promise<void> {
    if (this.down) throw new Error("connection refused");
  }
  override async appendLedger(input: LedgerInput): Promise<LedgerEntry> {
    if (this.down) {
      this.failures += 1;
      throw new Error("connection refused");
    }
    return super.appendLedger(input);
  }
}

const completion = {
  id: "c1",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};
const chat = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] };

function setupFlaky(responder: (store: FlakyStore) => Promise<Response> | Response) {
  const store = new FlakyStore();
  const dir = mkdtempSync(join(tmpdir(), "ga-spool-"));
  const spool = join(dir, "ledger.jsonl");
  const calls: unknown[] = [];
  const fetchFn = (async () => {
    calls.push(1);
    return responder(store);
  }) as unknown as typeof fetch;
  const app = buildApp({ config: { ...config, ledgerSpoolPath: spool }, store, fetch: fetchFn });
  const guard = ledgerGuardFor(store, console, { spoolPath: spool });
  return { app, store, spool, calls, guard };
}

const post = (app: ReturnType<typeof buildApp>, key: string) =>
  app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: chat });

describe("B1: PostgreSQL pool errors", () => {
  it("an idle pool error is logged and does not crash the process", () => {
    const logged: string[] = [];
    const store = PgStore.connect("postgres://u:p@127.0.0.1:1/db", (message) => logged.push(message));
    const pool = (store as unknown as { pool: { emit(e: string, err: Error): boolean; end(): Promise<void> } }).pool;
    expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(logged).toHaveLength(1);
    return pool.end();
  });
});

describe("B1: /health", () => {
  it("reports degraded with 503 when the database is unreachable, ok again afterwards", async () => {
    const { app, store } = setupFlaky(() => jsonResponse(completion));
    let res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", mode: "enforce", database: "up", spoolBacklog: 0 });
    store.down = true;
    res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "degraded", database: "down" });
    store.down = false;
    res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("B2: the ledger is never silently incomplete", () => {
  it("spools entries when the database dies after the upstream call, then replays them in order", async () => {
    const { app, store, spool, calls, guard } = setupFlaky((s) => {
      s.down = true; // the database dies while the provider is answering
      return jsonResponse(completion);
    });
    const { key } = await createAgent(app);
    const before = (await store.listLedger()).length;

    const res = await post(app, key);
    expect(res.statusCode).toBe(200); // the provider answered; the client got it
    expect(store.failures).toBe(3); // 3 attempts
    expect(guard.spoolBacklog()).toBe(1);
    expect(readFileSync(spool, "utf-8").trim().split("\n")).toHaveLength(1);

    // Fail closed: the store is known to be unhealthy, nothing is forwarded.
    const refused = await post(app, key);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe("ledger_unavailable");
    expect(calls).toHaveLength(1);

    // Replay while still down changes nothing and loses nothing.
    expect(await guard.replay()).toBe(0);
    expect(guard.spoolBacklog()).toBe(1);

    store.down = false;
    expect(await guard.probe()).toBe(true);
    expect(await guard.replay()).toBe(1);
    expect(guard.spoolBacklog()).toBe(0);
    expect(readFileSync(spool, "utf-8")).toBe("");

    const rows = await store.listLedger();
    expect(rows).toHaveLength(before + 1);
    expect((await proxyLedger(store)).at(-1)).toMatchObject({ verdict: "allowed", upstreamStatus: 200, promptTokens: 10 });
    expect(verifyChain(rows).valid).toBe(true);

    // Traffic flows again.
    expect((await post(app, key)).statusCode).toBe(200);
  });

  it("keeps the order of several spooled entries and a valid chain", async () => {
    const { store, guard } = setupFlaky(() => jsonResponse(completion));
    store.down = true;
    const mk = (n: number): LedgerInput => ({
      ts: new Date(1_700_000_000_000 + n).toISOString(), agentId: null, action: "chat.completions", model: "m",
      verdict: "allowed", reason: null, upstreamStatus: 200, promptTokens: n, completionTokens: 0, cost: 0,
      requestHash: `r${n}`, responseHash: null,
    });
    for (const n of [1, 2, 3]) await guard.append(mk(n));
    expect(guard.spoolBacklog()).toBe(3);
    store.down = false;
    await guard.probe();
    // A new entry arriving during replay queues behind the spool.
    await guard.append(mk(4));
    expect(guard.spoolBacklog()).toBe(4);
    expect(await guard.replay()).toBe(4);
    const rows = await store.listLedger();
    expect(rows.map((r) => r.promptTokens)).toEqual([1, 2, 3, 4]);
    expect(verifyChain(rows).valid).toBe(true);
  });

  it("a spool left by a previous run is replayed at startup", async () => {
    const { store, spool, guard } = setupFlaky(() => jsonResponse(completion));
    store.down = true;
    await guard.append({
      ts: new Date().toISOString(), agentId: null, action: "chat.completions", model: "m", verdict: "allowed",
      reason: null, upstreamStatus: 200, promptTokens: 1, completionTokens: 1, cost: 0, requestHash: "r", responseHash: null,
    });
    expect(existsSync(spool)).toBe(true);
    store.down = false;
    const fresh = new (guard.constructor as typeof import("../src/ledger-guard.js").LedgerGuard)(store, console, { spoolPath: spool });
    await fresh.start();
    fresh.stop();
    expect(fresh.spoolBacklog()).toBe(0);
    expect(await store.listLedger()).toHaveLength(1);
  });
});

describe("B4: client-aborted stream", () => {
  const stalledStream = (_u: unknown, init: { signal: AbortSignal }) => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "a" } }] })}\n\n`));
        init.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    });
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
  };

  it("records the reserved estimate as cost when no usage was received", async () => {
    const store = new MemoryStore();
    const app = buildApp({ config: { ...config, upstreamTimeoutMs: 80 }, store, fetch: stalledStream as unknown as typeof fetch });
    const { key } = await createAgent(app);
    await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` },
      payload: { ...chat, stream: true, max_tokens: 100 },
    });
    const row = (await proxyLedger(store)).at(-1)!;
    expect(row.reason).toBe("client_aborted_estimated");
    expect(row.cost).toBeGreaterThan(0);
    // 100 output tokens at the model's output price dominate the estimate
    expect(row.cost).toBeGreaterThanOrEqual(Math.round(100 * 0.6));
  });
});

describe("B2: database down gives 503, never 500", () => {
  class DownStore extends FlakyStore {
    override async findAgentByKeyHash(hash: string) {
      if (this.down) throw new Error("connection refused");
      return super.findAgentByKeyHash(hash);
    }
  }
  function setup() {
    const store = new DownStore();
    const dir = mkdtempSync(join(tmpdir(), "ga-b2-"));
    const spool = join(dir, "ledger.jsonl");
    let upstream = 0;
    const fetchFn = (async () => {
      upstream += 1;
      return jsonResponse(completion);
    }) as unknown as typeof fetch;
    const app = buildApp({ config: { ...config, ledgerSpoolPath: spool }, store, fetch: fetchFn });
    return { app, store, calls: () => upstream, guard: ledgerGuardFor(store, console, { spoolPath: spool }) };
  }

  it("the first request after the database drops gets 503 without calling the provider", async () => {
    const { app, store, calls, guard } = setup();
    const { key } = await createAgent(app);
    expect((await post(app, key)).statusCode).toBe(200);
    expect(guard.isReady()).toBe(true); // flag not flipped yet
    store.down = true;
    const res = await post(app, key);
    expect(res.statusCode).toBe(503);
    expect(calls()).toBe(1);
    expect(guard.isReady()).toBe(false); // flipped immediately
    expect((await post(app, key)).statusCode).toBe(503);
    expect(calls()).toBe(1);
  });

  it("recovers once the database is back", async () => {
    const { app, store, guard } = setup();
    const { key } = await createAgent(app);
    store.down = true;
    expect((await post(app, key)).statusCode).toBe(503);
    store.down = false;
    expect(await guard.probe()).toBe(true);
    expect((await post(app, key)).statusCode).toBe(200);
  });

  it("an error with a healthy database stays a 500", async () => {
    const { app, store } = setup();
    const { key } = await createAgent(app);
    store.findAgentByKeyHash = async () => {
      throw new Error("bug");
    };
    expect((await post(app, key)).statusCode).toBe(500);
  });
});
