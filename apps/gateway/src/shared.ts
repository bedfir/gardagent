import { readFileSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  budgetDay,
  canonicalJson,
  computeCost,
  evaluate,
  hashAgentKey,
  looksLikeAgentKey,
  sha256,
  type Agent,
  type Decision,
  type LedgerInput,
  type Store,
} from "@gardagent/core";
import { randomUUID } from "node:crypto";
import { agentCacheFor } from "./agent-cache.js";
import { agentCacheOptions, guardOptions, RESERVATION_MARGIN_MS, type GatewayConfig } from "./config.js";
import { authSummaryRow } from "./auth-limiter.js";
import { DbTimeoutError, ledgerGuardFor, type SpoolMeta } from "./ledger-guard.js";

const SESSION_HEADER = "x-opencode-session";

/** Never forwarded to the provider, even if listed in the configuration. */
const NEVER_FORWARD = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "host",
  "content-length",
  "content-type",
  "user-agent",
  // hop-by-hop
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function gatewayVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const USER_AGENT = `Gardagent/${gatewayVersion()}`;

/** Tokens counted for a call (input tokens include cache tokens for Anthropic). */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** What is common to the ledger rows of a single call. */
export interface CallContext {
  agent: Agent;
  model: string;
  day: string;
  /** Budget reservation held for this call (null when the budget is unlimited). */
  reservationId: string | null;
  base: { agentId: string; action: string; model: string; requestHash: string };
  /** Worst-case cost estimated at admission; recorded when an aborted call has no usage. */
  estimatedCost: number;
  /** In observe mode, the policy reason that would have denied the request. */
  observedReason?: string;
  /** Admitted in fail-open while the database is down: no budget reservation, spend settlement left to a later replay. */
  degraded?: boolean;
}

export interface Denial {
  status: 403 | 429 | 503;
  reason: "agent_disabled" | "model_not_allowed" | "budget_exceeded" | "ledger_unavailable";
  message: string;
}

export { RESERVATION_MARGIN_MS };

/** Machine-readable code of the 503 given to a key the gateway cannot verify while the database is unreachable. */
export const AGENT_UNVERIFIABLE_CODE = "agent_unverifiable_during_outage";
export const AGENT_UNVERIFIABLE_MESSAGE =
  "The agent could not be verified while the database is unreachable (the key is unknown to the gateway's outage cache). Retry later.";

/**
 * Thrown by `authenticate` in fail-open during a database outage when the key is not in the agent cache (or its
 * entry is older than TTL + grace). It is neither a rejected key (401) nor a ledger refusal: each endpoint answers
 * it with a 503 in its own error format. No ledger row can be written for it (the ledger is down).
 */
export class AgentUnverifiableError extends Error {
  constructor() {
    super(AGENT_UNVERIFIABLE_MESSAGE);
    this.name = "AgentUnverifiableError";
  }
}

/** Worst-case cost of a request: input from the body size (chars / 4), output from the requested maximum. */
export function estimateCost(config: GatewayConfig, model: string, body: Record<string, unknown>): number {
  const promptTokens = Math.ceil(JSON.stringify(body).length / 4);
  const requested = [body.max_tokens, body.max_completion_tokens].find((v) => typeof v === "number" && v > 0);
  const completionTokens = typeof requested === "number" ? requested : config.defaultMaxOutputTokens;
  return computeCost(config.prices, model, promptTokens, completionTokens, config.fallbackPrice);
}

export function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim();
}

/**
 * Governance logic shared by all endpoints: agent identity, rules, budget,
 * ledger writing, timeout and abort. Endpoints keep only their own protocol format.
 */
export function createGovernance(app: FastifyInstance, deps: { config: GatewayConfig; store: Store }) {
  const { config, store } = deps;
  /** A reservation older than the upstream timeout plus a margin is considered orphaned (crashed gateway). */
  const reservationTtlMs = config.upstreamTimeoutMs + RESERVATION_MARGIN_MS;

  const guard = ledgerGuardFor(store, app.log, guardOptions(config));
  const cache = agentCacheFor(store, agentCacheOptions(config));

  /** Never silent: retried, then spooled (fsync) and replayed (see LedgerGuard). Throws if the proof cannot be kept. */
  async function record(input: Omit<LedgerInput, "ts">, meta?: SpoolMeta): Promise<void> {
    await guard.append({ ts: new Date().toISOString(), ...input }, meta);
  }

  /** Fail closed (or fail-open with a writable spool): no traffic is forwarded without a way to keep the proof. */
  function ledgerReady(): boolean {
    return guard.canServe();
  }

  /**
   * A database call that hangs (dead connection, frozen server) must not hold the request for the driver's own
   * timeouts (seen: 3 s on the first request of an outage, 17 s at the end of a stream): in every mode it is bounded
   * (GARDAGENT_DB_CALL_TIMEOUT_MS), the database is declared unreachable and the outage path is taken.
   */
  function bounded<T>(promise: Promise<T>): Promise<T> {
    return guard.bounded(promise);
  }

  /** True while the database is unavailable and traffic is served in fail-open. */
  function degraded(): boolean {
    return guard.degraded();
  }

  /** After a store error: true when fail-open applies (database really down, spool writable) and the call may go on. */
  async function outageTolerated(error: unknown): Promise<boolean> {
    if (!guard.failOpen) return false;
    // A timeout already proved the outage (and flagged it): no second wait on a probe.
    if (!(error instanceof DbTimeoutError)) {
      if (await guard.probe()) return false;
      guard.markUnhealthy();
    }
    return guard.admissible();
  }

  /** Finds the agent for a key; logs the denial (invalid_key) if the key is missing or unknown. Throws AgentUnverifiableError (see above). */
  async function authenticate(action: string, key: string | null, sourceIp = "unknown"): Promise<Agent | null> {
    let agent: Agent | null = null;
    if (key && looksLikeAgentKey(key)) {
      const hash = hashAgentKey(key);
      if (guard.failOpen && guard.degraded()) {
        // Outage: an entry serves only up to TTL + grace; beyond that the agent is unknown.
        agent = cache.get(hash, true);
        if (!agent) throw new AgentUnverifiableError();
      } else {
        const token = cache.begin();
        try {
          agent = await bounded(store.findAgentByKeyHash(hash));
        } catch (error) {
          const cached = cache.get(hash, true);
          if (!(await outageTolerated(error))) throw error;
          if (!cached) throw new AgentUnverifiableError();
          agent = cached;
          return agent;
        }
        // Healthy database: always re-read; the cache is refreshed (or the entry dropped if disabled/unknown).
        if (guard.failOpen) cache.remember(hash, agent, token);
      }
    }
    if (!agent) {
      // One `invalid_key` row per source address and window, the rest aggregated (see AuthFailureLimiter).
      const limiter = app.agentAuthLimiter;
      const { first } = limiter.recordFailure(sourceIp);
      for (const n of limiter.drain()) await record(authSummaryRow(n));
      if (first) await record({
        agentId: null,
        action,
        model: null,
        verdict: "denied",
        reason: "invalid_key",
        upstreamStatus: null,
        promptTokens: 0,
        completionTokens: 0,
        cost: 0,
        requestHash: null,
        responseHash: null,
      });
    }
    return agent;
  }

  /** Applies the rules; a denial is logged here and described in `denial`. */
  async function admit(
    action: string,
    agent: Agent,
    model: string,
    body: Record<string, unknown>,
  ): Promise<{ ctx: CallContext; denial: Denial | null }> {
    const day = budgetDay();
    if (!guard.canServe()) {
      return {
        ctx: { agent, model, day, reservationId: null, estimatedCost: 0, base: { agentId: agent.id, action, model, requestHash: "" } },
        denial: { status: 503, reason: "ledger_unavailable", message: "The audit ledger is unavailable; request refused (fail closed)." },
      };
    }
    const ctx: CallContext = {
      agent,
      model,
      day,
      reservationId: null,
      estimatedCost: estimateCost(config, model, body),
      base: { agentId: agent.id, action, model, requestHash: sha256(canonicalJson(body)) },
    };
    // Fail-open (observe only): without the database, spend is unknown and no reservation is taken; the
    // spooled row carries the cost and the day so that a later settlement can account for it.
    let spentToday = 0;
    if (guard.isReady()) {
      try {
        spentToday = await bounded(store.getSpent(agent.id, day));
      } catch (error) {
        if (!(await outageTolerated(error))) throw error;
        ctx.degraded = true;
      }
    } else {
      ctx.degraded = true;
    }
    const decision: Decision = evaluate(agent, { model, spentToday });
    if (decision.allowed && agent.dailyBudget > 0 && !ctx.degraded) {
      const estimate = ctx.estimatedCost;
      try {
        ctx.reservationId = await bounded(store.reserve(agent.id, day, estimate, agent.dailyBudget, reservationTtlMs, { action, model, requestHash: ctx.base.requestHash }));
      } catch (error) {
        if (!(await outageTolerated(error))) throw error;
        ctx.degraded = true;
        ctx.reservationId = null;
      }
      if (ctx.reservationId === null && !ctx.degraded) {
        if (config.mode === "observe") {
          ctx.observedReason = "observed:budget_exceeded";
          return { ctx, denial: null };
        }
        return deny(ctx, { allowed: false, reason: "budget_exceeded", message: `Daily budget reached for agent ${agent.name}.` });
      }
    }
    if (decision.allowed) return { ctx, denial: null };
    if (config.mode === "observe") {
      ctx.observedReason = `observed:${decision.reason}`;
      return { ctx, denial: null };
    }
    return deny(ctx, decision);
  }

  async function deny(ctx: CallContext, decision: Extract<Decision, { allowed: false }>): Promise<{ ctx: CallContext; denial: Denial }> {
    await record({
      ...ctx.base,
      verdict: "denied",
      reason: decision.reason,
      upstreamStatus: null,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      responseHash: null,
    });
    const status = decision.reason === "budget_exceeded" ? 429 : 403;
    return { ctx, denial: { status, reason: decision.reason, message: decision.message } };
  }

/** Timeout and abort when the client disconnects before the end. */
  function startCall(reply: FastifyReply) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), config.upstreamTimeoutMs);
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) abort.abort();
    });
    return { signal: abort.signal, aborted: () => abort.signal.aborted, done: () => clearTimeout(timeout) };
  }

  /** True when the reservation is gone (or there was none); false when it is left behind for the replay to drop. */
  async function releaseReservation(ctx: CallContext): Promise<boolean> {
    if (ctx.reservationId === null) return true;
    if (guard.dbKnownDown()) return false; // dropped when the ledger row is replayed, or purged after its TTL
    try {
      await bounded(store.releaseReservation(ctx.reservationId));
      return true;
    } catch (error) {
      app.log.error({ err: error }, "Reservation release failed (dropped at replay or after its TTL)");
      return false;
    }
  }

  async function recordUnreachable(ctx: CallContext, call: { done: () => void }): Promise<void> {
    call.done();
    const released = await releaseReservation(ctx);
    await record({
      ...ctx.base,
      verdict: "allowed",
      reason: ctx.observedReason ?? "upstream_unreachable",
      upstreamStatus: null,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      responseHash: null,
    }, released ? undefined : { budgetSettlement: "pending", budgetDay: ctx.day, reservationId: ctx.reservationId });
  }

  /** Records the spend and writes the ledger row for a finished call. */
  async function settle(
    ctx: CallContext,
    call: { done: () => void },
    usage: Usage | null,
    responseText: string,
    status: number,
    reason: string | null,
  ): Promise<void> {
    call.done();
    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    let cost = computeCost(config.prices, ctx.model, promptTokens, completionTokens, config.fallbackPrice);
    // An aborted call may still be billed: without any usage received, record the reserved estimate.
    if (reason === "client_aborted" && usage === null) {
      cost = ctx.estimatedCost;
      reason = "client_aborted_estimated";
    }
    // Database already known to be down (another call timed out): do not wait on it again, the row carries the
    // cost and the day and the budget is settled later (see SpoolMeta).
    // The key makes the increment idempotent: if this attempt times out client-side but the server applies it, the
    // replay of the ledger row carries the same key and does not count the call twice.
    const settlementKey = randomUUID();
    let settled = !ctx.degraded && !guard.dbKnownDown();
    if (settled) {
      try {
        if (ctx.reservationId !== null) await bounded(store.settleReservation(ctx.reservationId, ctx.agent.id, ctx.day, cost, settlementKey));
        else if (cost > 0) await bounded(store.addSpend(ctx.agent.id, ctx.day, cost, settlementKey));
      } catch (error) {
        settled = false;
        app.log.error({ err: error }, "Spend settlement failed");
      }
    }
    const meta: SpoolMeta | undefined = settled
      ? undefined
      : {
          degraded: ctx.degraded === true,
          budgetSettlement: "pending",
          budgetDay: ctx.day,
          estimatedCost: ctx.estimatedCost,
          settlementKey,
          reservationId: ctx.reservationId,
        };
    await record({
      ...ctx.base,
      verdict: "allowed",
      reason: ctx.observedReason ?? reason,
      upstreamStatus: status,
      promptTokens,
      completionTokens,
      cost,
      responseHash: responseText ? sha256(responseText) : null,
    }, meta);
  }

  /**
   * Headers sent to the provider in addition to authentication: those from the client-provided whitelist,
   * a stable session per agent and per day if the client does not provide one, and always the gateway's User-Agent.
   */
  function upstreamHeaders(request: FastifyRequest, ctx: CallContext): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of config.forwardHeaders) {
      if (NEVER_FORWARD.has(name)) continue;
      const raw = request.headers[name];
      const value = (Array.isArray(raw) ? raw.join(", ") : raw)?.trim();
      if (value) out[name] = value;
    }
    if (config.forwardHeaders.includes(SESSION_HEADER) && !out[SESSION_HEADER]) {
      out[SESSION_HEADER] = `gardagent-${ctx.agent.id}-${ctx.day}`;
    }
    out["user-agent"] = USER_AGENT;
    return out;
  }

  return { upstreamHeaders, record, ledgerReady, degraded, authenticate, admit, startCall, recordUnreachable, settle };
}
