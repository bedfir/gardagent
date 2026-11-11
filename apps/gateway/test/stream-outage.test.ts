import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type LedgerEntry, type LedgerInput } from "@gardagent/core";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { parseTimeoutMs, type GatewayConfig } from "../src/config.js";
import { DbTimeoutError, ledgerGuardFor } from "../src/ledger-guard.js";
import { PgStore } from "../src/pg-store.js";
import { config, createAgent } from "./helpers.js";

/**
 * A database that is really gone: once `frozen`, every call on the request path never answers (like a frozen server
 * or a dead TCP connection, where the driver would wait for its own 5 s+ timeouts) instead of failing fast.
 */
class FrozenStore extends MemoryStore {
  frozen = false;
  calls: Record<string, number> = {};
  appendSignals: (AbortSignal | undefined)[] = [];
  private gate<T>(name: string, run: () => Promise<T>): Promise<T> {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    return this.frozen ? new Promise<T>(() => undefined) : run();
  }
  override ping() {
    return this.gate("ping", async () => undefined);
  }
  override findAgentByKeyHash(hash: string) {
    return this.gate("findAgent", () => super.findAgentByKeyHash(hash));
  }
  override getSpent(agentId: string, day: string) {
    return this.gate("getSpent", () => super.getSpent(agentId, day));
  }
  override reserve(...args: Parameters<MemoryStore["reserve"]>) {
    return this.gate("reserve", () => super.reserve(...args));
  }
  override settleReservation(...args: Parameters<MemoryStore["settleReservation"]>) {
    return this.gate("settle", () => super.settleReservation(...args));
  }
  override addSpend(...args: Parameters<MemoryStore["addSpend"]>) {
    return this.gate("addSpend", () => super.addSpend(...args));
  }
  override releaseReservation(id: string) {
    return this.gate("release", () => super.releaseReservation(id));
  }
  override appendLedger(input: LedgerInput, options?: { signal?: AbortSignal }): Promise<LedgerEntry> {
    this.appendSignals.push(options?.signal);
    return this.gate("append", () => super.appendLedger(input));
  }
}

const CALL_TIMEOUT_MS = 300;
const chat = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] };
const anthropicBody = { model: "gpt-4o-mini", max_tokens: 16, messages: [{ role: "user", content: "hello" }] };
const agentBody = { name: "bot", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 1 };

type Policy = "fail-open" | "fail-closed";

/** Upstream stream of `kind` that is still running when the database freezes, then ends. */
function liveStream(kind: "openai" | "anthropic", onFreeze: () => void): Response {
  const enc = new TextEncoder();
  const sse = (event: string | null, data: unknown) => (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`;
  const head =
    kind === "anthropic"
      ? [sse("message_start", { type: "message_start", message: { id: "m", usage: { input_tokens: 7, output_tokens: 1 } } }), sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })]
      : [sse(null, { id: "s", choices: [{ index: 0, delta: { content: "hi" } }] })];
  const tail =
    kind === "anthropic"
      ? [sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }), sse("message_stop", { type: "message_stop" })]
      : [sse(null, { id: "s", choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }), "data: [DONE]\n\n"];
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of head) controller.enqueue(enc.encode(c));
      await new Promise((r) => setTimeout(r, 60));
      onFreeze(); // the database goes away while the stream is in flight
      await new Promise((r) => setTimeout(r, 60));
      for (const c of tail) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function setup(policy: Policy, responder: (store: FrozenStore) => Response, overrides: Partial<GatewayConfig> = {}) {
  const store = new FrozenStore();
  const dir = mkdtempSync(join(tmpdir(), "ga-stream-outage-"));
  const spool = join(dir, "spool", "ledger.jsonl");
  const cfg: GatewayConfig = { ...config, mode: "observe", dbOutage: policy, ledgerSpoolPath: spool, dbCallTimeoutMs: CALL_TIMEOUT_MS, dbProbeTimeoutMs: CALL_TIMEOUT_MS, ...overrides };
  const app = buildApp({ config: cfg, store, fetch: (async () => responder(store)) as unknown as typeof fetch });
  const guard = ledgerGuardFor(store, console, {});
  const spooled = () => (existsSync(spool) ? readFileSync(spool, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { app, store, guard, spooled };
}

const postOpenAi = (app: ReturnType<typeof buildApp>, key: string, payload: object = chat) =>
  app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload });
const postAnthropic = (app: ReturnType<typeof buildApp>, key: string, payload: object = anthropicBody) =>
  app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": key }, payload });

describe("config: database timeouts", () => {
  it("parses the timeout variables with defaults and bounds", () => {
    expect(parseTimeoutMs("X", undefined, 600)).toBe(600);
    expect(parseTimeoutMs("X", "", 600)).toBe(600);
    expect(parseTimeoutMs("X", "250", 600)).toBe(250);
    expect(() => parseTimeoutMs("GARDAGENT_DB_CALL_TIMEOUT_MS", "10", 600)).toThrow(/GARDAGENT_DB_CALL_TIMEOUT_MS/);
    expect(() => parseTimeoutMs("X", "abc", 600)).toThrow();
    expect(() => parseTimeoutMs("X", "70000", 600)).toThrow();
  });
});

describe.each([["fail-open" as Policy], ["fail-closed" as Policy]])("stream in flight when the database freezes (%s)", (policy) => {
  for (const kind of ["openai", "anthropic"] as const) {
    it(`${kind}: the end of the stream is not delayed beyond the call timeout, and the proof is spooled`, async () => {
      let freeze = () => undefined as void;
      const { app, store, guard, spooled } = setup(policy, () => liveStream(kind, () => freeze()));
      freeze = () => {
        store.frozen = true;
      };
      const { key } = await createAgent(app, agentBody);
      const started = Date.now();
      const res = kind === "openai" ? await postOpenAi(app, key, { ...chat, stream: true }) : await postAnthropic(app, key, { ...anthropicBody, stream: true });
      const elapsed = Date.now() - started;
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(kind === "openai" ? "[DONE]" : "message_stop");
      // ~120 ms of stream + one bounded settlement. Before the fix this call never returned (frozen driver) or waited 3 x 5 s.
      expect(elapsed).toBeLessThan(120 + CALL_TIMEOUT_MS + 500);
      expect(guard.dbKnownDown()).toBe(true);
      const rows = spooled();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: kind === "openai" ? "chat.completions" : "messages", verdict: "allowed", promptTokens: 7, completionTokens: 3 });
      expect(rows[0].spoolMeta).toMatchObject({ budgetSettlement: "pending" });
      // Only admin.create_agent reached the store: once the settlement timed out the database was known to be down,
      // so the ledger write went straight to the spool (no 3 attempts of 5 s each).
      expect(store.calls.append).toBe(1);
    });
  }

  it("a stream that starts after the outage was detected adds no wait at all", async () => {
    const { app, store, guard, spooled } = setup(policy, () => liveStream("openai", () => undefined));
    const { key } = await createAgent(app, agentBody);
    expect((await postOpenAi(app, key)).statusCode).toBe(200); // warm: the agent is known (fail-open cache)
    store.frozen = true; // another request already found the database down:
    guard.markUnhealthy();
    const settleCalls = store.calls.settle ?? 0;
    const started = Date.now();
    const res = await postOpenAi(app, key, { ...chat, stream: true });
    const elapsed = Date.now() - started;
    if (policy === "fail-open") {
      expect(res.statusCode).toBe(200);
      expect(elapsed).toBeLessThan(120 + 200); // stream duration only, nothing waited on the database
      expect(store.calls.settle ?? 0).toBe(settleCalls);
      expect(spooled()).toHaveLength(1);
    } else {
      expect(res.statusCode).toBe(503); // fail-closed: refused at once, nothing forwarded
      expect(elapsed).toBeLessThan(100);
    }
  });
});

describe.each([["fail-open" as Policy], ["fail-closed" as Policy]])("first request after the database froze (%s)", (policy) => {
  it("answers (fail-open) or refuses (fail-closed) within the call timeout, not after the driver timeouts", async () => {
    const { app, store, spooled } = setup(policy, () => new Response(JSON.stringify({ id: "c", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }));
    const { key } = await createAgent(app, agentBody);
    expect((await postOpenAi(app, key)).statusCode).toBe(200); // warm: the agent is known (fail-open cache)
    store.frozen = true;
    const started = Date.now();
    const res = await postOpenAi(app, key);
    const elapsed = Date.now() - started;
    if (policy === "fail-open") {
      expect(res.statusCode).toBe(200);
      expect(spooled()).toHaveLength(1);
    } else {
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("ledger_unavailable");
    }
    // One bounded call (the lookup), no extra probe wait on top of it: < 1.5 x the timeout plus scheduling slack.
    expect(elapsed).toBeLessThan(CALL_TIMEOUT_MS * 1.5 + 150);
    expect(elapsed).toBeGreaterThanOrEqual(CALL_TIMEOUT_MS - 20);
    expect(store.calls.ping ?? 0).toBe(0); // the timeout was proof enough: no second wait on a probe
  });
});

describe("ledger guard: bounded writes", () => {
  it("abandons a frozen write (signal aborted) and spools; replay does not hold the spool lock", async () => {
    const { store, guard, spooled } = setup("fail-closed", () => new Response("{}"));
    const row = (n: number): LedgerInput => ({ ts: new Date().toISOString(), agentId: "a", action: "x", model: "m", verdict: "allowed", reason: String(n), upstreamStatus: 200, promptTokens: 1, completionTokens: 1, cost: 1, requestHash: `h${n}`, responseHash: null });
    store.frozen = true;
    const started = Date.now();
    await guard.append(row(1));
    expect(Date.now() - started).toBeLessThan(CALL_TIMEOUT_MS + 200);
    expect(store.appendSignals.at(-1)?.aborted).toBe(true);
    expect(spooled()).toHaveLength(1);
    // Database "back" for the probe but frozen for writes: the replay attempt times out instead of blocking forever.
    const replayStarted = Date.now();
    const replayed = await guard.replay();
    expect(replayed).toBe(0);
    expect(Date.now() - replayStarted).toBeLessThan(CALL_TIMEOUT_MS + 200);
    // A spool write is not stuck behind the replay.
    const spoolStarted = Date.now();
    await guard.append(row(2));
    expect(Date.now() - spoolStarted).toBeLessThan(150);
    expect(spooled()).toHaveLength(2);
    // Thaw: everything is replayed, once each, in order.
    store.frozen = false;
    expect(await guard.probe()).toBe(true);
    expect(await guard.replay()).toBe(2);
    expect((await store.listLedger()).filter((e) => e.action === "x").map((e) => e.requestHash)).toEqual(["h1", "h2"]);
  });

  it("a timeout is a DbTimeoutError and flags the database down at once", async () => {
    const { store, guard } = setup("fail-open", () => new Response("{}"));
    store.frozen = true;
    await expect(guard.bounded(store.getSpent("a", "2026-01-01"))).rejects.toBeInstanceOf(DbTimeoutError);
    expect(guard.dbKnownDown()).toBe(true);
  });
});

describe("PgStore: client errors", () => {
  it("a client error between two queries of a transaction is logged and does not crash the process", async () => {
    const logged: string[] = [];
    const store = PgStore.connect("postgres://u:p@127.0.0.1:1/db", (m) => logged.push(m), { connectTimeoutMs: 100 });
    const pool = (store as unknown as { pool: { emit(e: string, ...a: unknown[]): boolean; end(): Promise<void> } }).pool;
    // A client checked out between two queries emits 'error' with no query to carry it: must not throw (crash).
    const fakeClient = new (await import("node:events")).EventEmitter();
    pool.emit("connect", fakeClient);
    expect(() => fakeClient.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(logged.some((m) => m.includes("client error"))).toBe(true);
    await pool.end();
  });
});
