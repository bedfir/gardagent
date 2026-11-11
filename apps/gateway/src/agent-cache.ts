import type { Agent, Store } from "@gardagent/core";

/** Default lifetime of a cache entry (GARDAGENT_AGENT_CACHE_TTL_MS). */
export const DEFAULT_AGENT_CACHE_TTL_MS = 30_000;
/**
 * Extra time past the TTL during which an entry may still identify an agent while the database is down.
 * Fixed on purpose (not configurable): the TTL is the policy knob, the grace only keeps a short outage from
 * refusing every agent whose last successful lookup was a few seconds before the TTL ran out.
 */
export const AGENT_CACHE_OUTAGE_GRACE_MS = 120_000;
/** Maximum number of cached agent keys; the oldest entry is evicted first. */
export const AGENT_CACHE_MAX_ENTRIES = 1000;

/** GARDAGENT_AGENT_CACHE_TTL_MS: integer milliseconds between 1000 and 600000, default 30000. */
export function parseAgentCacheTtlMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_AGENT_CACHE_TTL_MS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1000 || n > 600_000) {
    throw new Error("GARDAGENT_AGENT_CACHE_TTL_MS must be an integer between 1000 and 600000 (milliseconds).");
  }
  return n;
}

export interface AgentCacheOptions {
  ttlMs?: number;
  graceMs?: number;
  maxEntries?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

interface Entry {
  agent: Agent;
  /** When the entry was last read from the database. */
  storedAt: number;
}

/**
 * Agents seen while the database was up, by key hash. Used only during a fail-open outage, when the database
 * cannot identify the caller. Entries are dropped synchronously by admin actions (`invalidateAgent`), expire
 * after the TTL (plus a fixed grace window during an outage) and are capped in number. A restart empties it.
 */
export class AgentCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly graceMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Bumped by each invalidation: a database read that started before it must not repopulate the cache. */
  private generation = 0;

  constructor(options: AgentCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_AGENT_CACHE_TTL_MS;
    this.graceMs = options.graceMs ?? AGENT_CACHE_OUTAGE_GRACE_MS;
    this.maxEntries = options.maxEntries ?? AGENT_CACHE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** Token to pass to `remember`, taken before the database read it protects. */
  begin(): number {
    return this.generation;
  }

  /**
   * Remembers the result of a database lookup. A missing or disabled agent is never kept (and drops any previous
   * entry for the key); a read that overlapped an invalidation is discarded.
   */
  remember(keyHash: string, agent: Agent | null, token: number): void {
    if (!agent || !agent.active) {
      this.entries.delete(keyHash);
      return;
    }
    if (token !== this.generation) return;
    this.entries.delete(keyHash); // re-insert at the end: the Map order is the age order
    this.entries.set(keyHash, { agent, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  /**
   * The cached agent, or null. Without `outage` an entry older than the TTL is never returned (the caller
   * re-reads the database); with it, an entry is returned up to TTL + grace.
   */
  get(keyHash: string, outage: boolean): Agent | null {
    const entry = this.entries.get(keyHash);
    if (!entry) return null;
    const age = this.now() - entry.storedAt;
    if (age > this.ttlMs + this.graceMs) {
      this.entries.delete(keyHash);
      return null;
    }
    if (!outage && age > this.ttlMs) return null;
    return entry.agent;
  }

  /** Drops every entry of an agent (any key it had). Call synchronously, before answering the admin request. */
  invalidateAgent(agentId: string): void {
    this.generation += 1;
    for (const [hash, entry] of this.entries) if (entry.agent.id === agentId) this.entries.delete(hash);
  }

  get size(): number {
    return this.entries.size;
  }
}

const caches = new WeakMap<Store, AgentCache>();

/** One cache per store, shared by the endpoints and the admin routes of the same process. */
export function agentCacheFor(store: Store, options: AgentCacheOptions = {}): AgentCache {
  let cache = caches.get(store);
  if (!cache) caches.set(store, (cache = new AgentCache(options)));
  return cache;
}
