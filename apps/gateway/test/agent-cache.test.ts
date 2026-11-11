import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { hashAgentKey, MemoryStore, type Agent, type LedgerEntry, type LedgerInput, type Store } from "@gardagent/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AGENT_CACHE_MAX_ENTRIES,
  AGENT_CACHE_OUTAGE_GRACE_MS,
  AgentCache,
  DEFAULT_AGENT_CACHE_TTL_MS,
  agentCacheFor,
  parseAgentCacheTtlMs,
} from "../src/agent-cache.js";
import { buildApp } from "../src/app.js";
import { ledgerGuardFor } from "../src/ledger-guard.js";
import { loadConfig, type GatewayConfig } from "../src/config.js";
import { PgStore } from "../src/pg-store.js";
import { adminHeaders, config, createAgent, jsonResponse } from "./helpers.js";

const completion = { id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
const chat = (model = "gpt-4o-mini") => ({ model, messages: [{ role: "user", content: "hello" }] });
const agentBody = { name: "bot", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 1 };

const mkAgent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id, name: id, keyHash: `h-${id}`, allowedModels: ["*"], allowedTools: [], approvalTools: [], dailyBudget: 0, active: true, ...over,
});

/** Mixin: the database can be switched off; every call the gateway makes on the request path then fails. */
function outageOf<T extends new (...args: any[]) => Store>(Base: T) {
  return class extends Base {
    down = false;
    private check() {
      if (this.down) throw new Error("connection refused");
    }
    override async ping() {
      this.check();
    }
    override async appendLedger(input: LedgerInput, ...rest: any[]): Promise<LedgerEntry> {
      this.check();
      return (super.appendLedger as any)(input, ...rest);
    }
    override async findAgentByKeyHash(hash: string) {
      this.check();
      return super.findAgentByKeyHash(hash);
    }
    override async getSpent(agentId: string, day: string) {
      this.check();
      return super.getSpent(agentId, day);
    }
    override async reserve(...args: Parameters<Store["reserve"]>) {
      this.check();
      return super.reserve(...args);
    }
    override async settleReservation(...args: Parameters<Store["settleReservation"]>) {
      this.check();
      return super.settleReservation(...args);
    }
    override async addSpend(...args: Parameters<Store["addSpend"]>) {
      this.check();
      return super.addSpend(...args);
    }
  };
}
const OutageMemory = outageOf(MemoryStore);
const OutagePg = outageOf(PgStore as unknown as new (pool: pg.Pool) => Store & PgStore);

function gateway(store: Store, overrides: Partial<GatewayConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ga-agentcache-"));
  const cfg: GatewayConfig = { ...config, mode: "observe", dbOutage: "fail-open", ledgerSpoolPath: join(dir, "ledger.jsonl"), ...overrides };
  const app = buildApp({ config: cfg, store, fetch: (async () => jsonResponse(completion)) as unknown as typeof fetch });
  spools.set(app, cfg.ledgerSpoolPath!);
  return app;
}
const spools = new WeakMap<object, string>();
type App = ReturnType<typeof gateway>;
const postChat = (app: App, key: string, model?: string) =>
  app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: chat(model) });
const patch = (app: App, id: string, payload: object) =>
  app.inject({ method: "PATCH", url: `/admin/agents/${id}`, headers: adminHeaders, payload });

afterEach(() => vi.useRealTimers());

/** Database back: probe it and replay the spool, as the gateway's timer does, so that normal operation resumes. */
async function recover(store: Store & { down: boolean }) {
  store.down = false;
  const guard = ledgerGuardFor(store, console, {});
  await guard.probe();
  await guard.replay();
}

describe("GARDAGENT_AGENT_CACHE_TTL_MS", () => {
  it("defaults to 30000 and accepts 1000 to 600000", () => {
    expect(parseAgentCacheTtlMs(undefined)).toBe(DEFAULT_AGENT_CACHE_TTL_MS);
    expect(DEFAULT_AGENT_CACHE_TTL_MS).toBe(30_000);
    expect(parseAgentCacheTtlMs("")).toBe(30_000);
    expect(parseAgentCacheTtlMs("1000")).toBe(1000);
    expect(parseAgentCacheTtlMs("600000")).toBe(600_000);
  });

  it.each(["999", "600001", "0", "-5", "abc", "1500.5"])("rejects %s with a clear startup error", (value) => {
    expect(() => parseAgentCacheTtlMs(value)).toThrow("GARDAGENT_AGENT_CACHE_TTL_MS must be an integer between 1000 and 600000 (milliseconds).");
  });

  it("fails loadConfig at startup and is read into the configuration", () => {
    const env = { UPSTREAM_BASE_URL: "http://u.test", UPSTREAM_API_KEY: "k", GARDAGENT_ADMIN_TOKEN: "t".repeat(32) };
    expect(loadConfig(env).agentCacheTtlMs).toBe(30_000);
    expect(loadConfig({ ...env, GARDAGENT_AGENT_CACHE_TTL_MS: "5000" }).agentCacheTtlMs).toBe(5000);
    expect(() => loadConfig({ ...env, GARDAGENT_AGENT_CACHE_TTL_MS: "10" })).toThrow(/GARDAGENT_AGENT_CACHE_TTL_MS/);
  });
});

describe("AgentCache", () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("never serves an entry older than the TTL when the database is healthy; serves it up to TTL + grace in an outage", () => {
    const c = clock();
    const cache = new AgentCache({ ttlMs: 1000, graceMs: 5000, now: c.now });
    cache.remember("h", mkAgent("a"), cache.begin());
    c.advance(1000);
    expect(cache.get("h", false)?.id).toBe("a"); // exactly the TTL: still fresh
    c.advance(1);
    expect(cache.get("h", false)).toBeNull(); // past the TTL: the caller must re-read
    expect(cache.get("h", true)?.id).toBe("a"); // outage: still within the grace window
    c.advance(4999);
    expect(cache.get("h", true)?.id).toBe("a"); // TTL + grace exactly
    c.advance(1);
    expect(cache.get("h", true)).toBeNull(); // beyond: unknown
    expect(cache.size).toBe(0); // and dropped
  });

  it("a fresh lookup restarts the age of the entry", () => {
    const c = clock();
    const cache = new AgentCache({ ttlMs: 1000, graceMs: 1000, now: c.now });
    cache.remember("h", mkAgent("a"), cache.begin());
    c.advance(1500);
    cache.remember("h", mkAgent("a"), cache.begin());
    c.advance(1500);
    expect(cache.get("h", true)?.id).toBe("a");
  });

  it("invalidateAgent drops every key of the agent and no other", () => {
    const cache = new AgentCache();
    cache.remember("old-key", mkAgent("a"), cache.begin());
    cache.remember("new-key", mkAgent("a"), cache.begin());
    cache.remember("other", mkAgent("b"), cache.begin());
    cache.invalidateAgent("a");
    expect(cache.get("old-key", true)).toBeNull();
    expect(cache.get("new-key", true)).toBeNull();
    expect(cache.get("other", true)?.id).toBe("b");
  });

  it("a database read that overlapped an invalidation does not repopulate the cache", () => {
    const cache = new AgentCache();
    const token = cache.begin();
    cache.invalidateAgent("a"); // the admin action lands while the read is in flight
    cache.remember("h", mkAgent("a"), token);
    expect(cache.get("h", true)).toBeNull();
  });

  it("never keeps a disabled or unknown agent, and drops the previous entry", () => {
    const cache = new AgentCache();
    cache.remember("h", mkAgent("a"), cache.begin());
    cache.remember("h", mkAgent("a", { active: false }), cache.begin());
    expect(cache.get("h", true)).toBeNull();
    cache.remember("h", mkAgent("a"), cache.begin());
    cache.remember("h", null, cache.begin());
    expect(cache.get("h", true)).toBeNull();
  });

  it("caps the number of entries and evicts the oldest first", () => {
    const c = clock();
    const cache = new AgentCache({ maxEntries: 3, now: c.now });
    for (const id of ["a", "b", "c"]) {
      cache.remember(`h-${id}`, mkAgent(id), cache.begin());
      c.advance(1);
    }
    cache.remember("h-a", mkAgent("a"), cache.begin()); // refreshed: now the newest
    cache.remember("h-d", mkAgent("d"), cache.begin()); // evicts "b", the oldest
    expect(cache.size).toBe(3);
    expect(cache.get("h-b", true)).toBeNull();
    for (const id of ["a", "c", "d"]) expect(cache.get(`h-${id}`, true)?.id).toBe(id);
  });

  it("has a bounded default cap and a fixed grace window", () => {
    expect(AGENT_CACHE_MAX_ENTRIES).toBe(1000);
    expect(AGENT_CACHE_OUTAGE_GRACE_MS).toBe(120_000);
  });

  it("is shared per store", () => {
    const store = new MemoryStore();
    expect(agentCacheFor(store)).toBe(agentCacheFor(store));
    expect(agentCacheFor(new MemoryStore())).not.toBe(agentCacheFor(store));
  });
});

describe("gateway: agent cache and database outage (MemoryStore)", () => {
  it("serves a known agent during an outage (control)", async () => {
    const store = new OutageMemory();
    const app = gateway(store);
    const { key } = await createAgent(app, agentBody);
    expect((await postChat(app, key)).statusCode).toBe(200);
    store.down = true;
    expect((await postChat(app, key)).statusCode).toBe(200);
  });

  it("a disabled agent is refused at once in the same process during an outage, and enabling it again does not resurrect the old entry", async () => {
    const store = new OutageMemory();
    const app = gateway(store);
    const { key, agent } = await createAgent(app, agentBody);
    expect((await postChat(app, key)).statusCode).toBe(200);
    expect(agentCacheFor(store).size).toBe(1);

    expect((await patch(app, agent.id, { active: false })).statusCode).toBe(200);
    expect(agentCacheFor(store).size).toBe(0); // gone before the admin response was sent
    store.down = true;
    expect((await postChat(app, key)).statusCode).not.toBe(200);

    await recover(store);
    expect((await patch(app, agent.id, { active: true })).statusCode).toBe(200);
    store.down = true;
    expect((await postChat(app, key)).statusCode).not.toBe(200); // not cached since the enable: unknown
    await recover(store);
    expect((await postChat(app, key)).statusCode).toBe(200); // database back: re-read and cached again
    store.down = true;
    expect((await postChat(app, key)).statusCode).toBe(200);
  });

  it("a policy patch (allowed models) is applied to the cached agent during an outage", async () => {
    const store = new OutageMemory();
    const app = gateway(store);
    const { key, agent } = await createAgent(app, agentBody);
    await postChat(app, key);
    expect((await patch(app, agent.id, { allowedModels: ["mistral-small"] })).statusCode).toBe(200);
    expect(agentCacheFor(store).size).toBe(0);
    await postChat(app, key, "mistral-small"); // healthy re-read caches the new policy
    store.down = true;
    // Observe mode serves the call but records the violation of the NEW policy in the spooled row.
    expect((await postChat(app, key)).statusCode).toBe(200);
    expect((await postChat(app, key, "mistral-small")).statusCode).toBe(200);
    const spooled = readFileSync(spoolOf(app), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(spooled.map((r) => [r.model, r.reason])).toEqual([["gpt-4o-mini", "observed:model_not_allowed"], ["mistral-small", null]]);
  });

  it("key rotation by replacement: the old key is refused as soon as the old agent is disabled, the new one is served", async () => {
    const store = new OutageMemory();
    const app = gateway(store);
    const old = await createAgent(app, agentBody);
    const next = await createAgent(app, { ...agentBody, name: "bot-2" });
    await postChat(app, old.key);
    await postChat(app, next.key);
    await patch(app, old.agent.id, { active: false });
    store.down = true;
    expect((await postChat(app, old.key)).statusCode).not.toBe(200);
    expect((await postChat(app, next.key)).statusCode).toBe(200);
  });

  it("a failed or no-op admin update still never leaves a stale policy: invalidation also happens when the write throws", async () => {
    const store = new OutageMemory();
    const app = gateway(store);
    const { key, agent } = await createAgent(app, agentBody);
    await postChat(app, key);
    store.updateAgent = async () => {
      throw new Error("write failed after commit");
    };
    await patch(app, agent.id, { active: false });
    expect(agentCacheFor(store).size).toBe(0);
    expect(key).toBeTruthy();
  });

  it("serves within TTL + grace of the last successful lookup, refuses beyond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    const store = new OutageMemory();
    const ttl = 2000;
    const app = gateway(store, { agentCacheTtlMs: ttl });
    const { key } = await createAgent(app, agentBody);
    await postChat(app, key); // last successful lookup at t0
    store.down = true;
    vi.setSystemTime(Date.now() + ttl + AGENT_CACHE_OUTAGE_GRACE_MS - 1000);
    expect((await postChat(app, key)).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + 2000); // now past TTL + grace
    expect((await postChat(app, key)).statusCode).not.toBe(200);
  });

  it("with a healthy database an entry older than the TTL is not used: the agent is re-read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    const store = new OutageMemory();
    const app = gateway(store, { agentCacheTtlMs: 1000 });
    const { key } = await createAgent(app, agentBody);
    await postChat(app, key);
    let lookups = 0;
    const original = store.findAgentByKeyHash.bind(store);
    store.findAgentByKeyHash = async (h: string) => {
      lookups += 1;
      return original(h);
    };
    vi.setSystemTime(Date.now() + 60_000);
    expect((await postChat(app, key)).statusCode).toBe(200);
    expect(lookups).toBe(1); // every healthy request reads the database; the cache is only the outage fallback
    expect(agentCacheFor(store).get(
      hashAgentKey(key), false,
    )).not.toBeNull(); // refreshed by the re-read
  });
});

const spoolOf = (app: App): string => spools.get(app)!;

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("gateway: agent cache with PostgreSQL", () => {
  let pool: pg.Pool;
  let store: InstanceType<typeof OutagePg>;

  beforeAll(async () => {
    const boot = new pg.Pool({ connectionString: url });
    await boot.query("DROP SCHEMA IF EXISTS agent_cache_test CASCADE");
    await boot.query("CREATE SCHEMA agent_cache_test");
    await boot.end();
    pool = new pg.Pool({ connectionString: url, options: "-c search_path=agent_cache_test" });
    store = new OutagePg(pool) as InstanceType<typeof OutagePg>;
    await (store as unknown as PgStore).migrate();
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("disable takes effect immediately in the process, then holds after the database returns", async () => {
    const app = gateway(store);
    const { key, agent } = await createAgent(app, agentBody);
    expect((await postChat(app, key)).statusCode).toBe(200);
    store.down = true;
    expect((await postChat(app, key)).statusCode).toBe(200); // served from the cache
    await recover(store);
    expect((await patch(app, agent.id, { active: false })).statusCode).toBe(200);
    expect(agentCacheFor(store).size).toBe(0);
    store.down = true;
    expect((await postChat(app, key)).statusCode).not.toBe(200);
    await recover(store);
    expect((await store.getAgent(agent.id))?.active).toBe(false);
  });

  it("a policy patch is visible on the next healthy lookup and replaces the cached entry", async () => {
    const app = gateway(store);
    const { key, agent } = await createAgent(app, agentBody);
    await postChat(app, key);
    await patch(app, agent.id, { allowedModels: ["mistral-small"] });
    expect(agentCacheFor(store).size).toBe(0);
    await postChat(app, key, "mistral-small");
    const cached = agentCacheFor(store).get(hashAgentKey(key), true);
    expect(cached?.allowedModels).toEqual(["mistral-small"]);
  });
});
