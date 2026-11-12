import { randomUUID } from "node:crypto";
import { chainEntry, GENESIS_HASH } from "./ledger.js";
import { INTERRUPTED_FALLBACK_ACTION, INTERRUPTED_REASON, KeyHashCollisionError } from "./types.js";
import type { Agent, AgentPatch, AppendLedgerOptions, Approval, ApprovalStatus, LedgerAggregate, LedgerEntry, LedgerFacets, LedgerInput, LedgerQuery, MicroUsd, ReservationMeta, SpendDivergence, Store } from "./types.js";

/** In-memory storage, for tests and demos without a database. */
export class MemoryStore implements Store {
  private agents = new Map<string, Agent>();
  private spend = new Map<string, MicroUsd>();
  private reservations = new Map<string, { agentId: string; day: string; amount: MicroUsd; at: number; meta?: ReservationMeta }>();
  private ledger: LedgerEntry[] = [];
  private ledgerKeys = new Map<string, number>();
  private spendKeys = new Set<string>();
  private approvals = new Map<string, Approval>();
  private queue: Promise<unknown> = Promise.resolve();

  async findAgentByKeyHash(keyHash: string): Promise<Agent | null> {
    for (const agent of this.agents.values()) {
      if (agent.keyHash === keyHash) return { ...agent };
    }
    return null;
  }

  async createAgent(agent: Agent): Promise<void> {
    if (this.agents.has(agent.id)) throw new Error(`Agent ${agent.id} already exists`);
    this.agents.set(agent.id, { ...agent });
  }

  async getAgent(id: string): Promise<Agent | null> {
    const agent = this.agents.get(id);
    return agent ? { ...agent } : null;
  }

  async updateAgent(id: string, patch: AgentPatch): Promise<Agent | null> {
    const agent = this.agents.get(id);
    if (!agent) return null;
    if (patch.name !== undefined) agent.name = patch.name;
    if (patch.allowedModels !== undefined) agent.allowedModels = [...patch.allowedModels];
    if (patch.allowedTools !== undefined) agent.allowedTools = [...patch.allowedTools];
    if (patch.approvalTools !== undefined) agent.approvalTools = [...patch.approvalTools];
    if (patch.dailyBudget !== undefined) agent.dailyBudget = patch.dailyBudget;
    if (patch.active !== undefined) agent.active = patch.active;
    return { ...agent };
  }

  async rotateAgentKey(id: string, keyHash: string, audit?: LedgerInput): Promise<Agent | null> {
    const agent = this.agents.get(id);
    if (!agent) return null;
    for (const other of this.agents.values()) {
      if (other.id !== id && other.keyHash === keyHash) throw new KeyHashCollisionError();
    }
    if (!audit) {
      agent.keyHash = keyHash;
      return { ...agent };
    }
    // Same all-or-nothing contract as PgStore: inside the ledger queue, undo the change if the audit row fails.
    return this.enqueue(async () => {
      const previous = agent.keyHash;
      agent.keyHash = keyHash;
      try {
        await this.appendNow(audit, {});
      } catch (e) {
        agent.keyHash = previous;
        throw e;
      }
      return { ...agent };
    });
  }

  async createApproval(approval: Approval): Promise<void> {
    this.approvals.set(approval.id, { ...approval });
  }

  async getApproval(id: string): Promise<Approval | null> {
    const a = this.approvals.get(id);
    return a ? { ...a } : null;
  }

  async decideApproval(id: string, status: Exclude<ApprovalStatus, "pending">, reason: string | null, decidedAt: string): Promise<Approval | null> {
    const a = this.approvals.get(id);
    if (!a || a.status !== "pending") return null;
    Object.assign(a, { status, reason, decidedAt });
    return { ...a };
  }

  async listApprovals(options: { status?: ApprovalStatus; limit?: number } = {}): Promise<Approval[]> {
    const rows = [...this.approvals.values()].filter((a) => !options.status || a.status === options.status).reverse();
    return (options.limit ? rows.slice(0, options.limit) : rows).map((a) => ({ ...a }));
  }

  async listAgents(): Promise<Agent[]> {
    return [...this.agents.values()].map((a) => ({ ...a }));
  }

  async getSpent(agentId: string, day: string): Promise<MicroUsd> {
    return this.spend.get(`${agentId}:${day}`) ?? 0;
  }

  async addSpend(agentId: string, day: string, amount: MicroUsd, idempotencyKey?: string): Promise<void> {
    if (idempotencyKey !== undefined) {
      if (this.spendKeys.has(idempotencyKey)) return;
      this.spendKeys.add(idempotencyKey);
    }
    const key = `${agentId}:${day}`;
    this.spend.set(key, (this.spend.get(key) ?? 0) + amount);
  }

  private liveReserved(agentId: string, day: string, ttlMs: number): MicroUsd {
    const limit = Date.now() - ttlMs;
    let sum = 0;
    for (const r of this.reservations.values()) {
      // An expired one is ignored here, not deleted: housekeeping purges it and writes its ledger row.
      if (r.at >= limit && r.agentId === agentId && r.day === day) sum += r.amount;
    }
    return sum;
  }

  // The methods below run without any await: they are atomic on the single JS thread.
  async reserve(agentId: string, day: string, amount: MicroUsd, budget: MicroUsd, ttlMs: number, meta?: ReservationMeta): Promise<string | null> {
    const spent = this.spend.get(`${agentId}:${day}`) ?? 0;
    if (this.liveReserved(agentId, day, ttlMs) + spent + amount > budget) return null;
    const id = randomUUID();
    this.reservations.set(id, { agentId, day, amount, at: Date.now(), ...(meta ? { meta } : {}) });
    return id;
  }

  async settleReservation(reservationId: string, agentId: string, day: string, actual: MicroUsd, idempotencyKey?: string): Promise<void> {
    this.reservations.delete(reservationId);
    if (actual > 0) await this.addSpend(agentId, day, actual, idempotencyKey);
  }

  async housekeeping(reservationTtlMs: number): Promise<{ reservations: number; keys: number }> {
    // Inside the writer queue: a concurrent run waits, then finds the reservation gone and writes nothing.
    const reservations = await this.enqueue(async () => {
      const limit = Date.now() - reservationTtlMs;
      let purged = 0;
      for (const [id, r] of [...this.reservations]) {
        if (r.at >= limit) continue;
        const key = `interrupted:${id}`;
        // One atomic step (ledger row + spend + reservation deletion), idempotent on the reservation id.
        await this.appendNow(
          {
            ts: new Date().toISOString(),
            agentId: r.agentId,
            action: r.meta?.action ?? INTERRUPTED_FALLBACK_ACTION,
            model: r.meta?.model ?? null,
            verdict: "allowed",
            reason: INTERRUPTED_REASON,
            upstreamStatus: null,
            promptTokens: 0,
            completionTokens: 0,
            cost: r.amount,
            requestHash: r.meta?.requestHash ?? null,
            responseHash: null,
          },
          { idempotencyKey: key, settlement: { key, agentId: r.agentId, day: r.day, amount: r.amount, reservationId: id } },
        );
        this.reservations.delete(id);
        purged += 1;
      }
      return purged;
    });
    return { reservations, keys: 0 };
  }

  async releaseReservation(reservationId: string): Promise<void> {
    this.reservations.delete(reservationId);
  }

  async getReserved(agentId: string, day: string, ttlMs: number): Promise<MicroUsd> {
    return this.liveReserved(agentId, day, ttlMs);
  }

  appendLedger(input: LedgerInput, options: AppendLedgerOptions = {}): Promise<LedgerEntry> {
    return this.enqueue(() => this.appendNow(input, options));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The append itself; callers run it inside the queue (one writer at a time). */
  private async appendNow(input: LedgerInput, options: AppendLedgerOptions): Promise<LedgerEntry> {
    const known = options.idempotencyKey === undefined ? undefined : this.ledgerKeys.get(options.idempotencyKey);
    if (known !== undefined) return { ...this.ledger[known - 1]! };
    const last = this.ledger.at(-1);
    const entry = chainEntry((last?.seq ?? 0) + 1, last?.hash ?? GENESIS_HASH, { ...input, formatVersion: 2 });
    this.ledger.push(entry);
    if (options.idempotencyKey !== undefined) this.ledgerKeys.set(options.idempotencyKey, entry.seq);
    const s = options.settlement;
    if (s) {
      if (s.reservationId) this.reservations.delete(s.reservationId);
      if (s.amount > 0) await this.addSpend(s.agentId, s.day, s.amount, s.key);
    }
    return { ...entry };
  }

  async listLedger(options: LedgerQuery = {}): Promise<LedgerEntry[]> {
    const after = options.afterSeq ?? 0;
    const before = options.beforeSeq ?? Number.POSITIVE_INFINITY;
    const rows = this.ledger.filter(
      (e) =>
        e.seq > after &&
        e.seq < before &&
        (!options.fromTs || e.ts >= options.fromTs) &&
        (!options.beforeTs || e.ts < options.beforeTs) &&
        (options.agentId === undefined || e.agentId === options.agentId) &&
        (options.model === undefined || e.model === options.model) &&
        (options.verdict === undefined || e.verdict === options.verdict) &&
        (options.minCost === undefined || e.cost >= options.minCost) &&
        (options.maxCost === undefined || e.cost <= options.maxCost),
    );
    if (options.order === "desc") rows.reverse();
    return (options.limit ? rows.slice(0, options.limit) : rows).map((e) => ({ ...e }));
  }

  async reconcileSpend(day: string): Promise<SpendDivergence[]> {
    const ledger = new Map<string, MicroUsd>();
    for (const e of this.ledger) {
      if (e.agentId !== null && e.ts.startsWith(day)) ledger.set(e.agentId, (ledger.get(e.agentId) ?? 0) + e.cost);
    }
    const spent = new Map<string, MicroUsd>();
    const suffix = `:${day}`;
    for (const [key, amount] of this.spend) {
      if (key.endsWith(suffix)) spent.set(key.slice(0, -suffix.length), amount);
    }
    const out: SpendDivergence[] = [];
    for (const agentId of new Set([...ledger.keys(), ...spent.keys()])) {
      const s = spent.get(agentId) ?? 0;
      const l = ledger.get(agentId) ?? 0;
      if (s !== l) out.push({ agentId, spent: s, ledger: l });
    }
    return out.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  }

  async ledgerFacets(): Promise<LedgerFacets> {
    const agentIds = new Set<string>();
    const models = new Set<string>();
    for (const e of this.ledger) {
      if (e.agentId !== null) agentIds.add(e.agentId);
      if (e.model !== null) models.add(e.model);
    }
    return { agentIds: [...agentIds].sort(), models: [...models].sort() };
  }

  async aggregateLedger(sinceDay: string): Promise<LedgerAggregate[]> {
    const groups = new Map<string, LedgerAggregate>();
    for (const e of this.ledger) {
      if (e.ts < sinceDay || e.action.startsWith("admin.") || e.action.startsWith("mcp.approval.")) continue;
      const day = e.ts.slice(0, 10);
      const key = JSON.stringify([day, e.agentId, e.verdict, e.reason]);
      const g = groups.get(key) ?? {
        day,
        agentId: e.agentId,
        verdict: e.verdict,
        reason: e.reason,
        count: 0,
        promptTokens: 0,
        completionTokens: 0,
        cost: 0,
      };
      g.count += 1;
      g.promptTokens += e.promptTokens;
      g.completionTokens += e.completionTokens;
      g.cost += e.cost;
      groups.set(key, g);
    }
    return [...groups.values()];
  }

  /** Reserved for tests: lets you simulate a tampering. */
  _tamper(seq: number, patch: Partial<LedgerEntry>): void {
    const entry = this.ledger.find((e) => e.seq === seq);
    if (entry) Object.assign(entry, patch);
  }
}
