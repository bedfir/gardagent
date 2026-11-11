import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetDay, MemoryStore, type Store } from "@gardagent/core";
import { buildApp } from "../src/app.js";
import { PgStore } from "../src/pg-store.js";
import { adminHeaders, config as baseConfig, jsonResponse } from "./helpers.js";

// Model names that are properties of Object.prototype used to give a NaN price, hence a NaN reservation that
// no budget comparison can refuse (E6).
const NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];
const pgUrl = process.env.TEST_DATABASE_URL;
let pool: pg.Pool | undefined;

const backends: Array<[string, () => Promise<Store>]> = [
  ["MemoryStore", async () => new MemoryStore()],
  ["PgStore", async () => {
    const store = new PgStore(pool!);
    await store.migrate();
    return store;
  }],
];

describe.each(backends)("budget cannot be bypassed with prototype property model names (%s)", (name, makeStore) => {
  if (name === "PgStore" && !pgUrl) {
    it.skip("needs TEST_DATABASE_URL", () => undefined);
    return;
  }
  beforeAll(async () => {
    if (name === "PgStore") {
      const boot = new pg.Pool({ connectionString: pgUrl });
      await boot.query("DROP SCHEMA IF EXISTS pricing_test CASCADE");
      await boot.query("CREATE SCHEMA pricing_test");
      await boot.end();
      pool = new pg.Pool({ connectionString: pgUrl, options: "-c search_path=pricing_test" });
    }
  });
  afterAll(async () => {
    await pool?.end();
  });

  it.each(NAMES)("model %s is priced at the fallback and refused when the budget is tiny", async (model) => {
    const store = await makeStore();
    let upstreamCalls = 0;
    const app = buildApp({ config: baseConfig, store, fetch: (async () => { upstreamCalls++; return jsonResponse({ id: "c", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }); }) as unknown as typeof fetch });
    const created = (await app.inject({
      method: "POST", url: "/admin/agents", headers: adminHeaders,
      payload: { name: `bot-${randomUUID()}`, allowedModels: ["*"], dailyBudgetUsd: 0.00001 },
    })).json() as { agent: { id: string }; key: string };

    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${created.key}` },
      payload: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 100 },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("budget_exceeded");
    expect(upstreamCalls).toBe(0);
    expect(await store.getSpent(created.agent.id, budgetDay())).toBe(0);
  });
});
