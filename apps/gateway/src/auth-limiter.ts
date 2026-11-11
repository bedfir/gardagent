import type { LedgerInput } from "@gardagent/core";

/**
 * In-memory counter of failed authentications per source address, in fixed windows.
 *
 * - `retryAfterSeconds` tells whether an address is currently blocked (limit reached inside its window).
 * - `recordFailure` counts a failure and says whether it is the first of its window (the only one that gets a
 *   ledger row; the others are only counted).
 * - `drain` returns the number of failures that were counted but not logged, for windows that have ended
 *   (or all windows with `force`), so the caller can write one aggregated row per window.
 *
 * State lives in the process: it is lost on restart and not shared between instances. The number of tracked
 * addresses is bounded; the oldest entry is evicted when the table is full.
 */
export interface AuthLimiterOptions {
  /** Failures per window before blocking; 0 disables blocking (counting for the log cap continues). */
  limit: number;
  windowMs: number;
  now?: () => number;
  maxEntries?: number;
  /** Keep the counts of ended windows for `drain` (default true). Off for a limiter that is never drained. */
  trackSuppressed?: boolean;
}

interface Entry {
  windowStart: number;
  failures: number;
  /** Failures and blocked attempts that did not get their own ledger row. */
  suppressed: number;
}

export const AUTH_LIMITER_MAX_ENTRIES = 10_000;

/** Largest body read from a request on /v1 or /mcp that carries no well-formed agent key (it will get a 401 anyway). */
export const UNAUTHENTICATED_BODY_LIMIT = 64 * 1024;

declare module "fastify" {
  interface FastifyInstance {
    /** Failed agent-key authentications (/v1, /mcp). */
    agentAuthLimiter: AuthFailureLimiter;
    /** Failed admin-token authentications (/admin). */
    adminAuthLimiter: AuthFailureLimiter;
  }
}

/** Ledger row standing for failures of one window that did not get their own `invalid_key` row. */
export function authSummaryRow(suppressed: number): LedgerInput {
  return {
    ts: new Date().toISOString(),
    agentId: null,
    action: "auth.invalid_key",
    model: null,
    verdict: "denied",
    reason: `invalid_key_repeated:${suppressed}`,
    upstreamStatus: null,
    promptTokens: 0,
    completionTokens: 0,
    cost: 0,
    requestHash: null,
    responseHash: null,
  };
}

export class AuthFailureLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(private readonly options: AuthLimiterOptions) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? AUTH_LIMITER_MAX_ENTRIES;
  }

  private live(ip: string): Entry | undefined {
    const entry = this.entries.get(ip);
    if (entry && this.now() - entry.windowStart < this.options.windowMs) return entry;
    return undefined;
  }

  /** Seconds to wait when the address is blocked, 0 otherwise. A blocked attempt is counted as suppressed. */
  retryAfterSeconds(ip: string): number {
    if (this.options.limit <= 0) return 0;
    const entry = this.live(ip);
    if (!entry || entry.failures < this.options.limit) return 0;
    entry.suppressed++;
    return Math.max(1, Math.ceil((entry.windowStart + this.options.windowMs - this.now()) / 1000));
  }

  /** Counts a failure; `first` is true when it opens a new window for this address. */
  recordFailure(ip: string): { first: boolean } {
    const entry = this.live(ip);
    if (entry) {
      entry.failures++;
      entry.suppressed++;
      return { first: false };
    }
    // The previous (expired) window of this address, if any, stays in the table until drained: keep its count.
    const previous = this.entries.get(ip);
    if (previous) this.retire(previous.suppressed);
    this.entries.delete(ip);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.retire(this.entries.get(oldest)!.suppressed);
        this.entries.delete(oldest);
      }
    }
    this.entries.set(ip, { windowStart: this.now(), failures: 1, suppressed: 0 });
    return { first: true };
  }

  private readonly expired: number[] = [];

  private retire(suppressed: number): void {
    if (this.options.trackSuppressed !== false) this.expired.push(suppressed);
  }

  /** Counts of unlogged failures per ended window (zero counts omitted). `force` also ends the running windows. */
  drain(force = false): number[] {
    for (const [ip, entry] of this.entries) {
      if (force || this.now() - entry.windowStart >= this.options.windowMs) {
        this.retire(entry.suppressed);
        this.entries.delete(ip);
      }
    }
    return this.expired.splice(0).filter((n) => n > 0);
  }
}
