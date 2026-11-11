import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { budgetDay, MemoryStore, type Store } from "@gardagent/core";
import { buildApp } from "../src/app.js";
import { PgStore } from "../src/pg-store.js";
import { RESERVATION_MARGIN_MS } from "../src/shared.js";
import { adminHeaders, config as baseConfig, jsonResponse, type FetchCall } from "./helpers.js";

const TTL = baseConfig.upstreamTimeoutMs + RESERVATION_MARGIN_MS;
// 1 micro-dollar per output token, free input: a request with max_tokens 100 reserves exactly 100.
const prices = { fake: { input: 0, output: 1 } };
const completion = (tokens: number) => ({
  id: "c",
  choices: [{ index: 0, message: { role: "assistant", content: "x" } }],
  usage: { prompt_tokens: 0, completion_tokens: tokens, total_tokens: tokens },
});
const chat = (extra: Record<string, unknown> = {}) => ({ model: "fake", messages: [{ role: "user", content: "hi" }], max_tokens: 100, ...extra });

/** A promise resolved from outside, to keep the fake upstream "slow" on demand. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("until: condition never met");
}

let pgPool: pg.Pool | undefined;
const pgUrl = process.env.TEST_DATABASE_URL;

const backends: Array<[string, () => Promise<Store>]> = [
  ["MemoryStore", async () => new MemoryStore()],
  [
    "PgStore",
    async () => {
      const store = new PgStore(pgPool!);
      await store.migrate();
      return store;
    },
  ],
];

describe.each(backends)("atomic budget reservation (%s)", (name, makeStore) => {
  if (name === "PgStore" && !pgUrl) {
    it.skip("needs TEST_DATABASE_URL", () => undefined);
    return;
  }

  beforeAll(async () => {
    if (name === "PgStore" && !pgPool) {
      // Dedicated schema: does not collide with pg-store.test.ts running in parallel.
      const boot = new pg.Pool({ connectionString: pgUrl });
      await boot.query("DROP SCHEMA IF EXISTS budget_test CASCADE");
      await boot.query("CREATE SCHEMA budget_test");
      await boot.end();
      pgPool = new pg.Pool({ connectionString: pgUrl, options: "-c search_path=budget_test" });
    }
  });
  afterAll(async () => {
    if (name === "PgStore") await pgPool?.end();
  });
  afterEach(() => vi.restoreAllMocks());

  async function boot(
    responder: (call: FetchCall, init: any) => Response | Promise<Response>,
    dailyBudgetUsd: number,
    overrides: Partial<typeof baseConfig> = {},
  ) {
    const store = await makeStore();
    const calls: FetchCall[] = [];
    const fetchFn = (async (input: any, init?: any) => {
      const call: FetchCall = {
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body ?? "{}")),
      };
      calls.push(call);
      return responder(call, init);
    }) as unknown as typeof fetch;
    const app = buildApp({ config: { ...baseConfig, prices, ...overrides }, store, fetch: fetchFn });
    const res = await app.inject({
      method: "POST",
      url: "/admin/agents",
      headers: adminHeaders,
      payload: { name: `bot-${randomUUID()}`, allowedModels: ["fake"], dailyBudgetUsd, ...(dailyBudgetUsd === 0 ? { unlimited: true } : {}) },
    });
    const created = res.json() as { agent: { id: string }; key: string };
    const post = (payload: Record<string, unknown> = chat()) =>
      app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${created.key}` }, payload });
    const day = budgetDay();
    return {
      app,
      store,
      calls,
      post,
      id: created.agent.id,
      key: created.key,
      spent: () => store.getSpent(created.agent.id, day),
      reserved: () => store.getReserved(created.agent.id, day, TTL),
    };
  }

  it("holds the cap under 20 parallel requests: exactly 3 pass", async () => {
    const g = gate();
    const t = await boot(async () => {
      await g.promise;
      return jsonResponse(completion(100));
    }, 0.00035);
    const all = Array.from({ length: 20 }, () => t.post());
    await until(() => t.calls.length === 3);
    expect(await t.reserved()).toBe(300);
    g.open();
    const results = await Promise.all(all);
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(3);
    const denied = results.filter((r) => r.statusCode === 429);
    expect(denied).toHaveLength(17);
    expect(denied[0]!.json().error.code).toBe("budget_exceeded");
    expect(t.calls).toHaveLength(3);
    expect(await t.spent()).toBe(300);
    expect(await t.reserved()).toBe(0);
  });

  it("settles down: a cheaper real cost frees the difference", async () => {
    const t = await boot(() => jsonResponse(completion(40)), 0.001);
    expect((await t.post()).statusCode).toBe(200);
    expect(await t.spent()).toBe(40);
    expect(await t.reserved()).toBe(0);
  });

  it("settles up: a higher real cost is recorded and never blocks the response", async () => {
    const t = await boot(() => jsonResponse(completion(500)), 0.0002);
    const res = await t.post();
    expect(res.statusCode).toBe(200);
    expect(await t.spent()).toBe(500);
    expect((await t.post()).statusCode).toBe(429);
  });

  it("releases the reservation on upstream error (unreachable and HTTP error)", async () => {
    let n = 0;
    const t = await boot(() => {
      if (n++ === 0) throw new Error("boom");
      return jsonResponse({ error: "nope" }, 500);
    }, 0.001);
    expect((await t.post()).statusCode).toBe(502);
    expect(await t.reserved()).toBe(0);
    expect((await t.post()).statusCode).toBe(500);
    expect(await t.reserved()).toBe(0);
    expect(await t.spent()).toBe(0);
  });

  it("releases the reservation on timeout", async () => {
    const t = await boot(
      (_c, init) =>
        new Promise<Response>((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))),
      0.001,
      { upstreamTimeoutMs: 50 },
    );
    const res = await t.post();
    expect(res.statusCode).toBe(502);
    expect(await t.reserved()).toBe(0);
    expect(await t.spent()).toBe(0);
  });

  it("releases the reservation when the client aborts", async () => {
    const t = await boot(
      (_c, init) =>
        new Promise<Response>((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))),
      0.001,
    );
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (t.app.server.address() as AddressInfo).port;
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.key}`, "content-type": "application/json" },
      body: JSON.stringify(chat()),
      signal: controller.signal,
    }).catch(() => null);
    await until(async () => (await t.reserved()) === 100);
    controller.abort();
    await pending;
    await until(async () => (await t.reserved()) === 0);
    expect(await t.spent()).toBe(0);
    await t.app.close();
  });

  it("ignores stale reservations (gateway crash) after the upstream timeout plus margin", async () => {
    const t = await boot(() => jsonResponse(completion(100)), 0.00025);
    const day = budgetDay();
    const stuck = await t.store.reserve(t.id, day, 250, 250, TTL);
    expect(stuck).not.toBeNull();
    expect((await t.post()).statusCode).toBe(429);
    expect(await t.reserved()).toBe(250);

    if (name === "PgStore") {
      await pgPool!.query("UPDATE agent_reservations SET created_at = now() - interval '1 hour' WHERE id = $1", [stuck]);
    } else {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + TTL + 1000);
    }
    expect(await t.reserved()).toBe(0);
    expect((await t.post()).statusCode).toBe(200);
  });

  it("budget 0 means unlimited and creates no reservation", async () => {
    const g = gate();
    const t = await boot(async () => {
      await g.promise;
      return jsonResponse(completion(100));
    }, 0);
    const all = Array.from({ length: 10 }, () => t.post());
    await until(() => t.calls.length === 10);
    expect(await t.reserved()).toBe(0);
    g.open();
    expect((await Promise.all(all)).every((r) => r.statusCode === 200)).toBe(true);
    expect(await t.spent()).toBe(1000);
  });

  it("holds the reservation while streaming and settles on the final usage", async () => {
    const g = gate();
    const enc = new TextEncoder();
    const t = await boot(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
              await g.promise;
              controller.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":30}}\n\n'));
              controller.enqueue(enc.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      0.00025,
    );
    const first = t.post(chat({ stream: true }));
    await until(() => t.calls.length === 1);
    expect(await t.reserved()).toBe(100);
    // Two more streams cannot fit under the cap while the first one holds its reservation.
    const second = t.post(chat({ stream: true }));
    await until(() => t.calls.length === 2);
    expect((await t.post(chat({ stream: true }))).statusCode).toBe(429);
    g.open();
    await Promise.all([first, second]);
    expect(await t.reserved()).toBe(0);
    expect(await t.spent()).toBe(60);
  });

  it("estimates input from body size / 4 and output from max_completion_tokens or the configured default", async () => {
    const g = gate();
    const t = await boot(
      async () => {
        await g.promise;
        return jsonResponse(completion(0));
      },
      1,
      { prices: { fake: { input: 1, output: 1 } }, defaultMaxOutputTokens: 7 },
    );
    const body = { model: "fake", messages: [{ role: "user", content: "x".repeat(396) }] };
    const size = JSON.stringify(body).length;
    const p1 = t.post(body);
    await until(() => t.calls.length === 1);
    expect(await t.reserved()).toBe(Math.ceil(size / 4) + 7);
    const withCompletion = { ...body, max_completion_tokens: 20 };
    const p2 = t.post(withCompletion);
    await until(() => t.calls.length === 2);
    expect(await t.reserved()).toBe(Math.ceil(size / 4) + 7 + Math.ceil(JSON.stringify(withCompletion).length / 4) + 20);
    g.open();
    await Promise.all([p1, p2]);
  });

  it("GET /admin/agents exposes reservedTodayUsd", async () => {
    const g = gate();
    const t = await boot(async () => {
      await g.promise;
      return jsonResponse(completion(100));
    }, 0.001);
    const p = t.post();
    await until(() => t.calls.length === 1);
    const list = await t.app.inject({ method: "GET", url: "/admin/agents", headers: adminHeaders });
    const agent = list.json().agents.find((a: { id: string }) => a.id === t.id);
    expect(agent.reservedTodayUsd).toBeCloseTo(0.0001, 9);
    expect(agent.spentTodayUsd).toBe(0);
    g.open();
    await p;
    const after = await t.app.inject({ method: "GET", url: "/admin/agents", headers: adminHeaders });
    expect(after.json().agents.find((a: { id: string }) => a.id === t.id).reservedTodayUsd).toBe(0);
  });
});
