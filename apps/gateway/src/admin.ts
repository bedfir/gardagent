import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  policyRevision,
  budgetDay,
  canonicalJson,
  generateAgentKey,
  GENESIS_HASH,
  hashAgentKey,
  KeyHashCollisionError,
  safeEqual,
  sha256,
  validToolPattern,
  verifyChain,
  type Agent,
  type AgentPatch,
  type ApprovalStatus,
  type LedgerInput,
  type LedgerQuery,
  type Store,
} from "@gardagent/core";
import { agentCacheFor } from "./agent-cache.js";
import { DECIDED, type ApprovalHub } from "./approvals.js";
import { csvChunks } from "./csv.js";
import { agentCacheOptions, type GatewayConfig } from "./config.js";
import { RESERVATION_MARGIN_MS } from "./shared.js";
import { buildStats } from "./stats.js";

interface CreateAgentBody {
  name?: unknown;
  allowedModels?: unknown;
  allowedTools?: unknown;
  approvalTools?: unknown;
  dailyBudgetUsd?: unknown;
  unlimited?: unknown;
}

const PAGE = 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Filters = Pick<LedgerQuery, "fromTs" | "beforeTs" | "agentId" | "model" | "verdict" | "minCost" | "maxCost">;

/** Plain decimal USD amount: digits with an optional fraction. No sign, exponent, hex, "NaN" or "Infinity". */
const USD_AMOUNT = /^\d+(\.\d+)?$/;

/** Smallest positive daily budget: 1 micro-USD. Anything that converts to 0 would be stored as 0, which means "no cap". */
const MIN_BUDGET_USD = 0.000001;

/**
 * Converts a daily budget in USD to integer micro-USD, shared by agent creation and update. Refuses any positive
 * amount whose conversion gives 0: 0 is reserved for "no cap" and must never come from rounding a tiny budget.
 * Returns the micro-USD amount or a 400 message.
 */
function budgetToMicro(usd: number): { micro: number } | { error: string } {
  const micro = Math.round(usd * 1_000_000);
  if (usd > 0 && micro === 0) {
    return { error: `« dailyBudgetUsd » must be at least ${MIN_BUDGET_USD.toFixed(6)} USD (1 micro-USD), or 0 for no cap (with « unlimited »: true on creation). ${usd} would round to 0, which means no cap.` };
  }
  return { micro };
}

/**
 * Ledger filters shared by the list and the CSV export: from, to (UTC days, inclusive), agent, model, verdict,
 * minCost, maxCost (USD). An absent or empty parameter means "no filter". Returns the store query fragment or a
 * 400 message.
 */
function parseLedgerFilters(query: Record<string, unknown>): { filters: Filters } | { error: string } {
  const text = (name: string): string | undefined | { error: string } => {
    const value = query[name];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string") return { error: `« ${name} » must be given at most once.` };
    return value;
  };
  const values: Record<string, string | undefined> = {};
  for (const name of ["from", "to", "agent", "model", "verdict", "minCost", "maxCost"]) {
    const v = text(name);
    if (typeof v === "object") return v;
    values[name] = v;
  }
  const { from, to, agent, model, verdict } = values;
  for (const [name, value] of [["from", from], ["to", to]] as const) {
    if (value !== undefined && !validDay(value)) return { error: `« ${name} » must be a valid YYYY-MM-DD date.` };
  }
  if (from && to && from > to) return { error: "« from » must precede « to »." };
  if (verdict !== undefined && verdict !== "allowed" && verdict !== "denied") {
    return { error: "« verdict » must be « allowed » or « denied »." };
  }
  const cost: Record<string, number> = {};
  for (const name of ["minCost", "maxCost"]) {
    const raw = values[name];
    if (raw === undefined) continue;
    const micro = USD_AMOUNT.test(raw) ? Math.round(Number(raw) * 1_000_000) : NaN;
    if (!Number.isSafeInteger(micro)) return { error: `« ${name} » must be a non-negative amount in USD (for example 0.25).` };
    cost[name] = micro;
  }
  if (cost.minCost !== undefined && cost.maxCost !== undefined && cost.minCost > cost.maxCost) {
    return { error: "« minCost » must not exceed « maxCost »." };
  }
  return {
    filters: {
      // Inclusive UTC-day bounds: [from 00:00, day after to 00:00[.
      fromTs: from,
      beforeTs: to ? new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10) : undefined,
      agentId: agent,
      model,
      verdict: verdict as Filters["verdict"],
      minCost: cost.minCost,
      maxCost: cost.maxCost,
    },
  };
}

/** Public view of an agent: the key fingerprint stays internal. */
function publicAgent(agent: Agent, spentToday: number, reservedToday = 0) {
  return {
    policyRev: policyRevision(agent).id,
    id: agent.id,
    name: agent.name,
    allowedModels: agent.allowedModels,
    allowedTools: agent.allowedTools,
    approvalTools: agent.approvalTools,
    dailyBudgetUsd: agent.dailyBudget / 1_000_000,
    spentTodayUsd: spentToday / 1_000_000,
    reservedTodayUsd: reservedToday / 1_000_000,
    active: agent.active,
  };
}

const TOOLS_ERROR = "« allowedTools » must be a list of « server/tool », « server/* » or « * ».";

const APPROVAL_TOOLS_ERROR = "« approvalTools » must be a list of « server/tool », « server/* » or « * ».";
const STATUSES = ["pending", "approved", "rejected", "expired"];

/** Validated and cleaned list of tools, or null if the format is incorrect. */
function parseTools(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const tools = value.map((t) => (typeof t === "string" ? t.trim() : null));
  if (tools.some((t) => t === null || !validToolPattern(t))) return null;
  return [...new Set(tools as string[])];
}

function validDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  // Reject non-existent dates (e.g. 2026-02-30) that Date may "fix" or reject.
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export function registerAdmin(app: FastifyInstance, deps: { config: GatewayConfig; store: Store; approvals: ApprovalHub }): void {
  const { config, store, approvals } = deps;
  const agentCache = agentCacheFor(store, agentCacheOptions(config));

  /** The ledger row of an admin action. */
  function auditInput(action: string, agentId: string | null, reason: string | null, content: unknown): LedgerInput {
    return {
      ts: new Date().toISOString(),
      agentId,
      action,
      model: null,
      verdict: "allowed",
      reason,
      upstreamStatus: null,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      requestHash: sha256(canonicalJson(content)),
      responseHash: null,
    };
  }

  const operators = new WeakMap<FastifyRequest, string>();

  app.register(async (admin) => {
    admin.addHook("onRequest", async (request: FastifyRequest, reply) => {
      const header = request.headers.authorization ?? "";
      const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
      let operatorId: string | undefined;
      if (token && safeEqual(sha256(token), sha256(config.adminToken))) operatorId = "bootstrap";
      else if (token.startsWith("gaop_")) operatorId = (await store.findOperator(sha256(token)))?.id;
      if (!operatorId) {
        app.adminAuthLimiter.recordFailure(request.ip);
        return reply.code(401).send({ error: "Invalid admin token." });
      }
      operators.set(request, operatorId);
    });

    admin.get("/admin/operators", async () => ({ operators: await store.listOperators() }));
    admin.post("/admin/operators", async (request, reply) => {
      if (operators.get(request) !== "bootstrap") return reply.code(403).send({ error: "Only bootstrap may manage operators." });
      const label = ((request.body ?? {}) as { label?: unknown }).label;
      if (typeof label !== "string" || !label.trim() || label.trim().length > 200) return reply.code(400).send({ error: "A label of 1 to 200 characters is required." });
      const operator = { id: randomUUID(), label: label.trim(), createdAt: new Date().toISOString(), revokedAt: null };
      const token = "gaop_" + randomBytes(32).toString("base64url");
      await store.createOperator(operator, sha256(token), { ...auditInput("admin.operator.create", null, null, { id: operator.id, label: operator.label }), operatorId: operators.get(request)! });
      return reply.code(201).header("cache-control", "no-store").send({ operator, token });
    });
    admin.post("/admin/operators/:id/revoke", async (request, reply) => {
      if (operators.get(request) !== "bootstrap") return reply.code(403).send({ error: "Only bootstrap may manage operators." });
      const { id } = request.params as { id: string };
      const revoked = await store.revokeOperator(id, new Date().toISOString(), { ...auditInput("admin.operator.revoke", null, null, { id }), operatorId: operators.get(request)! });
      if (!revoked) return reply.code(404).send({ error: "Active operator not found." });
      return { revoked: true };
    });
    admin.get("/admin/policy-revisions/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const canonical = await store.getPolicyRevision(id);
      if (canonical === null) return reply.code(404).send({ error: "Policy revision not found." });
      return { id, policy: JSON.parse(canonical) };
    });

    admin.post("/admin/agents", async (request, reply) => {
      const body = (request.body ?? {}) as CreateAgentBody;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const models = Array.isArray(body.allowedModels) ? body.allowedModels.filter((m) => typeof m === "string") : [];
      const budget = body.dailyBudgetUsd;
      const tools = body.allowedTools === undefined ? [] : parseTools(body.allowedTools);
      if (!tools) return reply.code(400).send({ error: TOOLS_ERROR });
      const approvalTools = body.approvalTools === undefined ? [] : parseTools(body.approvalTools);
      if (!approvalTools) return reply.code(400).send({ error: APPROVAL_TOOLS_ERROR });
      if (!name) return reply.code(400).send({ error: "The « name » field is required." });
      if (models.length === 0) return reply.code(400).send({ error: "Provide at least one model in « allowedModels »." });
      // A missing budget must never silently mean "unlimited": a cap is required, and no cap needs an explicit opt-in.
      if (body.unlimited !== undefined && typeof body.unlimited !== "boolean") {
        return reply.code(400).send({ error: "« unlimited » must be a boolean." });
      }
      if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) {
        return reply.code(400).send({ error: "« dailyBudgetUsd » is required: a positive number of USD per day (use 0 together with « unlimited »: true for no cap)." });
      }
      if (budget === 0 && body.unlimited !== true) {
        return reply.code(400).send({ error: "« dailyBudgetUsd » is 0: set a positive daily budget, or send « unlimited »: true to create the agent without a cap." });
      }
      if (budget > 0 && body.unlimited === true) {
        return reply.code(400).send({ error: "« unlimited »: true cannot be combined with a positive « dailyBudgetUsd » (use 0 for an agent without a cap)." });
      }
      const budgetMicro = budgetToMicro(budget);
      if ("error" in budgetMicro) return reply.code(400).send({ error: budgetMicro.error });

      const key = generateAgentKey();
      const agent: Agent = {
        id: randomUUID(),
        name,
        keyHash: hashAgentKey(key),
        allowedModels: models as string[],
        allowedTools: tools,
        approvalTools,
        dailyBudget: budgetMicro.micro,
        active: true,
      };
      await store.createAgent(agent, { ...auditInput("admin.agent.create", agent.id, null, {
        name: agent.name,
        allowedModels: agent.allowedModels,
        allowedTools: agent.allowedTools,
        approvalTools: agent.approvalTools,
        dailyBudget: agent.dailyBudget,
      }), operatorId: operators.get(request)! });
      // The key is returned only here: it is stored only as a fingerprint.
      return reply.code(201).send({ agent: publicAgent(agent, 0), key });
    });

    admin.get("/admin/agents", async () => {
      const day = budgetDay();
      const agents = await store.listAgents();
      return {
        agents: await Promise.all(agents.map(async (a) =>
            publicAgent(a, await store.getSpent(a.id, day), await store.getReserved(a.id, day, config.upstreamTimeoutMs + RESERVATION_MARGIN_MS)),
          )),
      };
    });

    admin.patch("/admin/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const current = await store.getAgent(id);
      if (!current) return reply.code(404).send({ error: "Agent not found." });

      const body = (request.body ?? {}) as Record<string, unknown>;
      const patch: AgentPatch = {};
      if ("name" in body) {
        if (typeof body.name !== "string" || !body.name.trim()) {
          return reply.code(400).send({ error: "« name » must be a non-empty string." });
        }
        patch.name = body.name.trim();
      }
      if ("allowedModels" in body) {
        const models = Array.isArray(body.allowedModels) ? body.allowedModels : null;
        if (!models || !models.every((m) => typeof m === "string") || models.every((m) => !String(m).trim())) {
          return reply.code(400).send({ error: "« allowedModels » must contain at least one model." });
        }
        patch.allowedModels = (models as string[]).map((m) => m.trim()).filter(Boolean);
      }
      if ("allowedTools" in body) {
        const tools = parseTools(body.allowedTools);
        if (!tools) return reply.code(400).send({ error: TOOLS_ERROR });
        patch.allowedTools = tools;
      }
      if ("approvalTools" in body) {
        const tools = parseTools(body.approvalTools);
        if (!tools) return reply.code(400).send({ error: APPROVAL_TOOLS_ERROR });
        patch.approvalTools = tools;
      }
      if ("dailyBudgetUsd" in body) {
        const budget = body.dailyBudgetUsd;
        if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) {
          return reply.code(400).send({ error: "« dailyBudgetUsd » must be a positive or zero number." });
        }
        const budgetMicro = budgetToMicro(budget);
        if ("error" in budgetMicro) return reply.code(400).send({ error: budgetMicro.error });
        patch.dailyBudget = budgetMicro.micro;
      }
      if ("active" in body) {
        if (typeof body.active !== "boolean") return reply.code(400).send({ error: "« active » must be a boolean." });
        patch.active = body.active;
      }
      if (Object.keys(patch).length === 0) {
        return reply.code(400).send({ error: "Provide at least one field to update." });
      }

      // Keep (and log) only what actually changes.
      const changed: AgentPatch = {};
      const fields: string[] = [];
      if (patch.name !== undefined && patch.name !== current.name) {
        changed.name = patch.name;
        fields.push("name");
      }
      if (patch.allowedModels !== undefined && JSON.stringify(patch.allowedModels) !== JSON.stringify(current.allowedModels)) {
        changed.allowedModels = patch.allowedModels;
        fields.push("allowedModels");
      }
      if (patch.allowedTools !== undefined && JSON.stringify(patch.allowedTools) !== JSON.stringify(current.allowedTools)) {
        changed.allowedTools = patch.allowedTools;
        fields.push("allowedTools");
      }
      if (patch.approvalTools !== undefined && JSON.stringify(patch.approvalTools) !== JSON.stringify(current.approvalTools)) {
        changed.approvalTools = patch.approvalTools;
        fields.push("approvalTools");
      }
      if (patch.active !== undefined && patch.active !== current.active) {
        changed.active = patch.active;
        fields.push("active");
      }
      if (patch.dailyBudget !== undefined && patch.dailyBudget !== current.dailyBudget) {
        changed.dailyBudget = patch.dailyBudget;
        fields.push("dailyBudget");
      }

      const spent = await store.getSpent(id, budgetDay());
      const reserved = await store.getReserved(id, budgetDay(), config.upstreamTimeoutMs + RESERVATION_MARGIN_MS);
      if (fields.length === 0) return { agent: publicAgent(current, spent, reserved) };

      // Dropped even if the write fails (it may have been applied before the error), and before the response:
      // from here on this process no longer serves the old entry.
      let updated: Agent | null;
      try {
        updated = await store.updateAgent(id, changed, { ...auditInput("admin.agent.update", id, fields.join(","), changed), operatorId: operators.get(request)! });
      } finally {
        agentCache.invalidateAgent(id);
      }
      if (!updated) return reply.code(404).send({ error: "Agent not found." });
      return { agent: publicAgent(updated, spent, reserved) };
    });

    /**
     * Replaces the key of an existing agent (same id, policy, budget and history). The new key is returned once;
     * the old one stops working at once. The agent cache entry is dropped before answering, even if the write throws.
     */
    // Own scope: this route alone accepts an empty body sent with « Content-Type: application/json »
    // (Fastify's default parser answers 400 FST_ERR_CTP_EMPTY_JSON_BODY). A non-empty body is still parsed strictly.
    admin.register(async (scoped) => {
      scoped.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
        const text = (body as string).trim();
        if (text === "") return done(null, undefined);
        try {
          done(null, JSON.parse(text));
        } catch (e) {
          (e as { statusCode?: number }).statusCode = 400;
          done(e as Error, undefined);
        }
      });
      scoped.post("/admin/agents/:id/rotate-key", async (request, reply) => {
        const { id } = request.params as { id: string };
        let key = "";
        let updated: Agent | null = null;
        // Neither the key nor its hash goes into the ledger. The row is written in the same transaction as the key.
        const rotateAudit = { ...auditInput("admin.agent.rotate-key", id, null, { agentId: id, action: "rotate-key" }), operatorId: operators.get(request)! };
        try {
          // The hash column is unique: on the (practically impossible) collision, generate another key.
          for (let attempt = 0; ; attempt++) {
            key = generateAgentKey();
            try {
              updated = await store.rotateAgentKey(id, hashAgentKey(key), rotateAudit);
              break;
            } catch (e) {
              if (!(e instanceof KeyHashCollisionError) || attempt >= 4) throw e;
            }
          }
        } finally {
          agentCache.invalidateAgent(id);
        }
        if (!updated) return reply.code(404).send({ error: "Agent not found." });
        const day = budgetDay();
        const spent = await store.getSpent(id, day);
        const reserved = await store.getReserved(id, day, config.upstreamTimeoutMs + RESERVATION_MARGIN_MS);
        return reply.header("cache-control", "no-store").send({ agent: publicAgent(updated, spent, reserved), key });
      });
    });

    /** Spend counters versus ledger sums for the current UTC day: only the agents that disagree are listed. */
    admin.get("/admin/spend-check", async (_request, reply) => {
      const day = budgetDay();
      const divergences = await store.reconcileSpend(day);
      const names = new Map((await store.listAgents()).map((a) => [a.id, a.name]));
      return reply.header("cache-control", "no-store").send({
        day,
        divergences: divergences.map((d) => ({
          agentId: d.agentId,
          name: names.get(d.agentId) ?? null,
          spentUsd: d.spent / 1_000_000,
          ledgerUsd: d.ledger / 1_000_000,
        })),
      });
    });

    admin.get("/admin/approvals", async (request, reply) => {
      const { status, limit: rawLimit } = request.query as { status?: string; limit?: string };
      if (status !== undefined && !STATUSES.includes(status)) {
        return reply.code(400).send({ error: "« status » must be pending, approved, rejected or expired." });
      }
      let limit = 100;
      if (rawLimit !== undefined) {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          return reply.code(400).send({ error: "« limit » must be an integer between 1 and 500." });
        }
      }
      return { approvals: await store.listApprovals({ status: status as ApprovalStatus | undefined, limit }) };
    });

    /** Human decision: atomic (409 if already decided), logged, then the agent's request is woken up. */
    async function decide(id: string, status: "approved" | "rejected", reason: string | null, reply: FastifyReply, operatorId: string) {
      const existing = await store.getApproval(id);
      if (!existing) return reply.code(404).send({ error: "Approval request not found." });
      const decidedAt = new Date().toISOString();
      const decided = await store.decideApproval(id, status, reason, decidedAt, operatorId, {
        ts: decidedAt,
        agentId: existing.agentId,
        action: DECIDED,
        model: `${existing.server}/${existing.tool}#${existing.accessClass}`,
        verdict: status === "approved" ? "allowed" : "denied",
        reason: status === "approved" ? "approved" : "rejected",
        upstreamStatus: null, promptTokens: 0, completionTokens: 0, cost: 0,
        requestHash: existing.argsHash, responseHash: null,
        ...(existing.policyRev ? { policyRev: existing.policyRev } : {}),
        approvalRef: id, operatorId,
      });
      if (!decided) return reply.code(409).send({ error: `Request already decided (${existing.status}).` });
      approvals.notify(id);
      return { approval: decided };
    }

    admin.post("/admin/approvals/:id/approve", async (request, reply) => {
      const { id } = request.params as { id: string };
      return decide(id, "approved", null, reply, operators.get(request)!);
    });

    admin.post("/admin/approvals/:id/reject", async (request, reply) => {
      const { id } = request.params as { id: string };
      const raw = ((request.body ?? {}) as { reason?: unknown }).reason;
      if (raw !== undefined && raw !== null && typeof raw !== "string") {
        return reply.code(400).send({ error: "« reason » must be a string." });
      }
      const reason = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 500) : null;
      return decide(id, "rejected", reason, reply, operators.get(request)!);
    });

    admin.get("/admin/stats", async (request, reply) => {
      const { days: raw } = request.query as { days?: string };
      let days = 7;
      if (raw !== undefined) {
        days = Number(raw);
        if (!Number.isInteger(days) || days < 1 || days > 90) {
          return reply.code(400).send({ error: "« days » must be an integer between 1 and 90." });
        }
      }
      return buildStats(store, days);
    });

    admin.get("/admin/ledger", async (request, reply) => {
      const query = request.query as { afterSeq?: string; beforeSeq?: string; limit?: string; order?: string };
      const parsed = parseLedgerFilters(request.query as Record<string, unknown>);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const seq = (value: string | undefined): number | null | undefined => {
        if (value === undefined || value === "") return undefined;
        const n = Number(value);
        return Number.isInteger(n) && n >= 0 ? n : null;
      };
      const afterSeq = seq(query.afterSeq);
      const beforeSeq = seq(query.beforeSeq);
      const limit = seq(query.limit);
      if (afterSeq === null) return reply.code(400).send({ error: "« afterSeq » must be a positive or zero integer." });
      if (beforeSeq === null) return reply.code(400).send({ error: "« beforeSeq » must be a positive or zero integer." });
      if (limit === null) return reply.code(400).send({ error: "« limit » must be a positive or zero integer." });
      if (query.order !== undefined && query.order !== "asc" && query.order !== "desc") {
        return reply.code(400).send({ error: "« order » must be « asc » or « desc »." });
      }
      const entries = await store.listLedger({
        afterSeq: afterSeq ?? 0,
        beforeSeq,
        limit: Math.min(limit || 100, PAGE),
        order: query.order ?? "asc",
        ...parsed.filters,
      });
      return { entries };
    });

    /** Distinct agents and models present in the ledger, to populate the console filter selectors. */
    admin.get("/admin/ledger/facets", async () => {
      const [facets, agents] = await Promise.all([store.ledgerFacets(), store.listAgents()]);
      const names = new Map(agents.map((a) => [a.id, a.name]));
      return {
        agents: facets.agentIds
          .map((id) => ({ id, name: names.get(id) ?? null }))
          .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)),
        models: facets.models,
      };
    });

    admin.get("/admin/ledger/export.csv", async (request, reply) => {
      const parsed = parseLedgerFilters(request.query as Record<string, unknown>);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });

      const names = new Map((await store.listAgents()).map((a) => [a.id, a.name]));
      const today = new Date().toISOString().slice(0, 10);
      reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="gardagent-journal-${today}.csv"`)
        .header("cache-control", "no-store");
      return reply.send(Readable.from(csvChunks(store, names, parsed.filters)));
    });

    const checkpointFormat = "gardagent-checkpoint-v1";
    const checkpoint = async () => ({ format: checkpointFormat, ...await store.ledgerHead(), created_at: new Date().toISOString() });
    function validCheckpoint(value: unknown): value is { format: string; sequence: number; head_hash: string; created_at: string } {
      if (!value || typeof value !== "object") return false;
      const c = value as Record<string, unknown>;
      return c.format === checkpointFormat && Number.isSafeInteger(c.sequence) &&
        (c.sequence as number) >= 0 && (c.sequence as number) < Number.MAX_SAFE_INTEGER &&
        typeof c.head_hash === "string" && /^[0-9a-f]{64}$/.test(c.head_hash) &&
        (c.sequence !== 0 || c.head_hash === GENESIS_HASH) &&
        typeof c.created_at === "string" && Number.isFinite(Date.parse(c.created_at));
    }

    admin.get("/admin/ledger/checkpoint", async (_request, reply) => {
      return reply.header("cache-control", "no-store").send(await checkpoint());
    });

    admin.get("/admin/ledger/export.ndjson", async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      const integer = (v: unknown, fallback: number) => v === undefined ? fallback :
        typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : NaN;
      const afterSeq = integer(q.afterSeq, 0);
      const limit = integer(q.limit, PAGE);
      const head = await checkpoint();
      const sequence = integer(q.headSequence, head.sequence);
      const hash = q.headHash ?? head.head_hash;
      if (!Number.isSafeInteger(afterSeq) || !Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER ||
          afterSeq > sequence || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE ||
          typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) ||
          ((q.headSequence === undefined) !== (q.headHash === undefined)) ||
          (afterSeq > 0 && q.headSequence === undefined)) {
        return reply.code(400).send({ error: "Invalid export cursor, head or limit (1..1000)." });
      }
      const anchor = sequence === 0 ? GENESIS_HASH :
        (await store.listLedger({ afterSeq: sequence - 1, beforeSeq: sequence + 1, limit: 1 }))[0]?.hash;
      if (anchor !== hash) return reply.code(409).send({ error: "Export head is no longer present." });
      const entries = await store.listLedger({ afterSeq, beforeSeq: sequence + 1, limit });
      const last = entries.at(-1)?.seq ?? afterSeq;
      const metadata = { type: "metadata", checkpoint: { ...head, sequence, head_hash: hash }, nextAfterSeq: last < sequence ? last : null };
      return reply.header("cache-control", "no-store").type("application/x-ndjson")
        .send([JSON.stringify(metadata), ...entries.map((entry) => JSON.stringify(entry))].join("\n") + "\n");
    });

    async function verify(expected?: { sequence: number; head_hash: string }) {
      const head = await store.ledgerHead();
      let afterSeq = 0;
      let prevHash = GENESIS_HASH;
      let lastVersion: 1 | 2 = 1;
      let total = 0;
      let contains = expected?.sequence === 0 && expected.head_hash === GENESIS_HASH;
      for (;;) {
        const page = await store.listLedger({ afterSeq, beforeSeq: head.sequence + 1, limit: PAGE });
        if (page.length === 0) break;
        if (page[0]!.seq !== afterSeq + 1) return { valid: false, checked: total, brokenAtSeq: page[0]!.seq, problem: "seq_gap", ...(expected ? { checkpointContained: false } : {}) };
        const check = verifyChain(page, prevHash, lastVersion);
        if (!check.valid) return { valid: false, checked: total, brokenAtSeq: check.brokenAtSeq, problem: check.problem, ...(expected ? { checkpointContained: false } : {}) };
        if (expected && page.some((e) => e.seq === expected.sequence && e.hash === expected.head_hash)) contains = true;
        total += page.length;
        prevHash = check.lastHash;
        lastVersion = check.lastVersion;
        afterSeq = page.at(-1)!.seq;
      }
      if (afterSeq !== head.sequence || prevHash !== head.head_hash) return { valid: false, checked: total, problem: "head_mismatch", ...(expected ? { checkpointContained: false } : {}) };
      return { valid: true, checked: total, lastHash: prevHash, ...(expected ? { checkpointContained: contains } : {}) };
    }
    admin.get("/admin/ledger/verify", async () => verify());
    admin.post("/admin/ledger/verify", async (request, reply) => {
      if (!validCheckpoint(request.body)) return reply.code(400).send({ error: "Expected a gardagent-checkpoint-v1 checkpoint." });
      return reply.header("cache-control", "no-store").send(await verify(request.body));
    });
  });
}
