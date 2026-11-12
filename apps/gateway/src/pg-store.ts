import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrateDatabase } from "./migrations.js";
import { chainEntry, GENESIS_HASH, KeyHashCollisionError, INTERRUPTED_FALLBACK_ACTION, INTERRUPTED_REASON, type Agent, type AgentPatch, type AppendLedgerOptions, type Approval, type ApprovalStatus, type LedgerAggregate, type LedgerEntry, type LedgerFacets, type LedgerInput, type LedgerQuery, type MicroUsd, type ReservationMeta, type SpendDivergence, type Store, type ToolAccessClass } from "@gardagent/core";

/** Advisory lock that serialises ledger writes across instances. */
const LEDGER_LOCK = 72_617_001;


interface AgentRow {
  id: string;
  name: string;
  key_hash: string;
  allowed_models: string[];
  allowed_tools: string[] | null;
  approval_tools: string[] | null;
  daily_budget: string;
  active: boolean;
}

interface LedgerRow {
  format_version: number | null;
  policy_rev: string | null;
  operator_id: string | null;
  approval_ref: string | null;
  seq: string;
  ts: string;
  agent_id: string | null;
  action: string;
  model: string | null;
  verdict: "allowed" | "denied";
  reason: string | null;
  upstream_status: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost: string;
  request_hash: string | null;
  response_hash: string | null;
  degraded?: boolean;
  prev_hash: string;
  hash: string;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    keyHash: row.key_hash,
    allowedModels: row.allowed_models,
    allowedTools: row.allowed_tools ?? [],
    approvalTools: row.approval_tools ?? [],
    dailyBudget: Number(row.daily_budget),
    active: row.active,
  };
}

interface ApprovalRow {
  id: string;
  created_at: string;
  agent_id: string;
  server: string;
  tool: string;
  args_hash: string;
  args_summary: string;
  status: ApprovalStatus;
  decided_at: string | null;
  reason: string | null;
  access_class: ToolAccessClass;
}

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    createdAt: r.created_at,
    agentId: r.agent_id,
    server: r.server,
    tool: r.tool,
    argsHash: r.args_hash,
    argsSummary: r.args_summary,
    status: r.status,
    decidedAt: r.decided_at,
    reason: r.reason,
    accessClass: r.access_class,
  };
}

/** Adds a spend amount at most once per key (no key: always). Runs on a pool or on the client of a transaction. */
async function addSpendOnce(db: Pick<pg.Pool, "query">, agentId: string, day: string, amount: MicroUsd, key?: string): Promise<void> {
  if (key === undefined) {
    await db.query(
      `INSERT INTO agent_spend (agent_id, day, amount) VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, day) DO UPDATE SET amount = agent_spend.amount + EXCLUDED.amount`,
      [agentId, day, amount],
    );
    return;
  }
  await db.query(
    `WITH fresh AS (INSERT INTO spend_settlements (key) VALUES ($4) ON CONFLICT DO NOTHING RETURNING key)
     INSERT INTO agent_spend (agent_id, day, amount) SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM fresh)
     ON CONFLICT (agent_id, day) DO UPDATE SET amount = agent_spend.amount + EXCLUDED.amount`,
    [agentId, day, amount, key],
  );
}

function toEntry(row: LedgerRow): LedgerEntry {
  return {
    ...(row.format_version != null ? { formatVersion: row.format_version } : {}),
    ...(row.policy_rev != null ? { policyRev: row.policy_rev } : {}),
    ...(row.operator_id != null ? { operatorId: row.operator_id } : {}),
    ...(row.approval_ref != null ? { approvalRef: row.approval_ref } : {}),
    seq: Number(row.seq),
    ts: row.ts,
    agentId: row.agent_id,
    action: row.action,
    model: row.model,
    verdict: row.verdict,
    reason: row.reason,
    upstreamStatus: row.upstream_status,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cost: Number(row.cost),
    requestHash: row.request_hash,
    responseHash: row.response_hash,
    // Only when true: the hash of rows written before the field existed covers no `degraded` key.
    ...(row.degraded === true ? { degraded: true } : {}),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

function defaultPoolLog(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.message : error);
}

/** Chains and inserts one ledger row. The caller holds the ledger lock inside a transaction. */
async function insertChained(client: Pick<pg.Pool, "query">, input: LedgerInput): Promise<LedgerEntry> {
  const { rows } = await client.query<{ seq: string; hash: string }>("SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1");
  const last = rows[0];
  const entry = chainEntry(last ? Number(last.seq) + 1 : 1, last?.hash ?? GENESIS_HASH, { ...input, formatVersion: 2 });
  await client.query(
    `INSERT INTO ledger (seq, ts, agent_id, action, model, verdict, reason, upstream_status,
       prompt_tokens, completion_tokens, cost, request_hash, response_hash, prev_hash, hash, degraded, format_version, policy_rev, operator_id, approval_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      entry.seq,
      entry.ts,
      entry.agentId,
      entry.action,
      entry.model,
      entry.verdict,
      entry.reason,
      entry.upstreamStatus,
      entry.promptTokens,
      entry.completionTokens,
      entry.cost,
      entry.requestHash,
      entry.responseHash,
      entry.prevHash,
      entry.hash,
      entry.degraded === true,
      entry.formatVersion,
      entry.policyRev ?? null,
      entry.operatorId ?? null,
      entry.approvalRef ?? null,
    ],
  );
  return entry;
}

/** Orphans purged by one housekeeping run at most (the next run takes the rest). */
const MAX_PURGE_PER_RUN = 1000;

/** Default wait for a pooled connection, in milliseconds. */
export const DEFAULT_DB_CONNECT_TIMEOUT_MS = 2000;

export class PgStore implements Store {
  constructor(private readonly pool: pg.Pool) {}

  /** `connectTimeoutMs`: how long a request waits for a pooled connection (GARDAGENT_DB_CONNECT_TIMEOUT_MS). */
  static connect(
    databaseUrl: string,
    log: (message: string, error: unknown) => void = defaultPoolLog,
    options: { connectTimeoutMs?: number } = {},
  ): PgStore {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMillis: options.connectTimeoutMs ?? DEFAULT_DB_CONNECT_TIMEOUT_MS,
      keepAlive: true,
    });
    // An idle client can be killed (database restart): without a listener this 'error' event crashes the process.
    pool.on("error", (error) => log("PostgreSQL pool error (the pool reconnects on demand)", error));
    // The same holds for a client checked out between two queries of a transaction (seen when PostgreSQL is stopped
    // while a request is in flight: the pool listener is detached during checkout, the process died).
    pool.on("connect", (client) => client.on("error", (error) => log("PostgreSQL client error (connection lost)", error)));
    return new PgStore(pool);
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async migrate(): Promise<void> {
    await migrateDatabase(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async findAgentByKeyHash(keyHash: string): Promise<Agent | null> {
    const { rows } = await this.pool.query<AgentRow>("SELECT * FROM agents WHERE key_hash = $1", [keyHash]);
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async createAgent(agent: Agent): Promise<void> {
    await this.pool.query(
      "INSERT INTO agents (id, name, key_hash, allowed_models, allowed_tools, approval_tools, daily_budget, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [agent.id, agent.name, agent.keyHash, agent.allowedModels, agent.allowedTools, agent.approvalTools, agent.dailyBudget, agent.active],
    );
  }

  async getAgent(id: string): Promise<Agent | null> {
    const { rows } = await this.pool.query<AgentRow>("SELECT * FROM agents WHERE id = $1", [id]);
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async updateAgent(id: string, patch: AgentPatch): Promise<Agent | null> {
    // Column names are literals; all values are passed as parameters.
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.allowedModels !== undefined) set("allowed_models", patch.allowedModels);
    if (patch.allowedTools !== undefined) set("allowed_tools", patch.allowedTools);
    if (patch.approvalTools !== undefined) set("approval_tools", patch.approvalTools);
    if (patch.dailyBudget !== undefined) set("daily_budget", patch.dailyBudget);
    if (patch.active !== undefined) set("active", patch.active);
    if (sets.length === 0) return this.getAgent(id);
    values.push(id);
    const { rows } = await this.pool.query<AgentRow>(
      `UPDATE agents SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async rotateAgentKey(id: string, keyHash: string, audit?: LedgerInput): Promise<Agent | null> {
    if (!audit) return this.rotateKeyOnly(this.pool, id, keyHash);
    // One transaction for the key and its audit row: if the audit insert fails, the old key stays valid.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [LEDGER_LOCK]);
      const agent = await this.rotateKeyOnly(client, id, keyHash);
      if (!agent) {
        await client.query("ROLLBACK");
        return null;
      }
      await insertChained(client, audit);
      await client.query("COMMIT");
      return agent;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async rotateKeyOnly(db: Pick<pg.Pool, "query">, id: string, keyHash: string): Promise<Agent | null> {
    try {
      const { rows } = await db.query<AgentRow>("UPDATE agents SET key_hash = $1 WHERE id = $2 RETURNING *", [keyHash, id]);
      return rows[0] ? toAgent(rows[0]) : null;
    } catch (e) {
      // 23505 = unique_violation; the id is never updated, so the only unique column at stake is key_hash.
      if ((e as { code?: string }).code === "23505") throw new KeyHashCollisionError();
      throw e;
    }
  }

  async aggregateLedger(sinceDay: string): Promise<LedgerAggregate[]> {
    const { rows } = await this.pool.query<{
      day: string;
      agent_id: string | null;
      verdict: "allowed" | "denied";
      reason: string | null;
      count: string;
      prompt_tokens: string;
      completion_tokens: string;
      cost: string;
    }>(
      `SELECT substr(ts, 1, 10) AS day, agent_id, verdict, reason, COUNT(*) AS count,
              SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens, SUM(cost) AS cost
         FROM ledger
        WHERE ts >= $1 AND action NOT LIKE 'admin.%' AND action NOT LIKE 'mcp.approval.%'
        GROUP BY 1, 2, 3, 4`,
      [sinceDay],
    );
    return rows.map((r) => ({
      day: r.day,
      agentId: r.agent_id,
      verdict: r.verdict,
      reason: r.reason,
      count: Number(r.count),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      cost: Number(r.cost),
    }));
  }

  async createApproval(a: Approval): Promise<void> {
    await this.pool.query(
      `INSERT INTO approvals (id, created_at, agent_id, server, tool, args_hash, args_summary, status, decided_at, reason, access_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [a.id, a.createdAt, a.agentId, a.server, a.tool, a.argsHash, a.argsSummary, a.status, a.decidedAt, a.reason, a.accessClass],
    );
  }

  async getApproval(id: string): Promise<Approval | null> {
    const { rows } = await this.pool.query<ApprovalRow>("SELECT * FROM approvals WHERE id = $1", [id]);
    return rows[0] ? toApproval(rows[0]) : null;
  }

  async decideApproval(id: string, status: Exclude<ApprovalStatus, "pending">, reason: string | null, decidedAt: string): Promise<Approval | null> {
    // Atomic: only one decision wins, subsequent ones touch no row.
    const { rows } = await this.pool.query<ApprovalRow>(
      "UPDATE approvals SET status = $2, reason = $3, decided_at = $4 WHERE id = $1 AND status = 'pending' RETURNING *",
      [id, status, reason, decidedAt],
    );
    return rows[0] ? toApproval(rows[0]) : null;
  }

  async listApprovals(options: { status?: ApprovalStatus; limit?: number } = {}): Promise<Approval[]> {
    const { rows } = await this.pool.query<ApprovalRow>(
      "SELECT * FROM approvals WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC, id LIMIT $2",
      [options.status ?? null, options.limit ?? 100],
    );
    return rows.map(toApproval);
  }

  async listAgents(): Promise<Agent[]> {
    const { rows } = await this.pool.query<AgentRow>("SELECT * FROM agents ORDER BY created_at");
    return rows.map(toAgent);
  }

  async getSpent(agentId: string, day: string): Promise<MicroUsd> {
    const { rows } = await this.pool.query<{ amount: string }>(
      "SELECT amount FROM agent_spend WHERE agent_id = $1 AND day = $2",
      [agentId, day],
    );
    return rows[0] ? Number(rows[0].amount) : 0;
  }

  async addSpend(agentId: string, day: string, amount: MicroUsd, idempotencyKey?: string): Promise<void> {
    await addSpendOnce(this.pool, agentId, day, amount, idempotencyKey);
  }

  /** Row lock on the agent_spend row serialises reservations of one agent and day. */
  async reserve(agentId: string, day: string, amount: MicroUsd, budget: MicroUsd, ttlMs: number, meta?: ReservationMeta): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO agent_spend (agent_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING", [agentId, day]);
      const spent = await client.query<{ amount: string }>(
        "SELECT amount FROM agent_spend WHERE agent_id = $1 AND day = $2 FOR UPDATE",
        [agentId, day],
      );
      // Expired reservations are ignored, not deleted: housekeeping purges them and writes their ledger row.
      const reserved = await client.query<{ total: string }>(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM agent_reservations WHERE agent_id = $1 AND day = $2 AND created_at >= now() - ($3 * interval '1 millisecond')",
        [agentId, day, ttlMs],
      );
      if (Number(spent.rows[0]?.amount ?? 0) + Number(reserved.rows[0]?.total ?? 0) + amount > budget) {
        await client.query("ROLLBACK");
        return null;
      }
      const id = randomUUID();
      await client.query(
        "INSERT INTO agent_reservations (id, agent_id, day, amount, action, model, request_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [id, agentId, day, amount, meta?.action ?? null, meta?.model ?? null, meta?.requestHash ?? null],
      );
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async settleReservation(reservationId: string, agentId: string, day: string, actual: MicroUsd, idempotencyKey?: string): Promise<void> {
    if (idempotencyKey !== undefined) {
      await this.pool.query(
        `WITH gone AS (DELETE FROM agent_reservations WHERE id = $1),
              fresh AS (INSERT INTO spend_settlements (key) VALUES ($5) ON CONFLICT DO NOTHING RETURNING key)
         INSERT INTO agent_spend (agent_id, day, amount) SELECT $2, $3, $4 WHERE EXISTS (SELECT 1 FROM fresh)
         ON CONFLICT (agent_id, day) DO UPDATE SET amount = agent_spend.amount + EXCLUDED.amount`,
        [reservationId, agentId, day, actual, idempotencyKey],
      );
      return;
    }
    await this.pool.query(
      `WITH gone AS (DELETE FROM agent_reservations WHERE id = $1)
       INSERT INTO agent_spend (agent_id, day, amount) VALUES ($2, $3, $4)
       ON CONFLICT (agent_id, day) DO UPDATE SET amount = agent_spend.amount + EXCLUDED.amount`,
      [reservationId, agentId, day, actual],
    );
  }

  async releaseReservation(reservationId: string): Promise<void> {
    await this.pool.query("DELETE FROM agent_reservations WHERE id = $1", [reservationId]);
  }

  async getReserved(agentId: string, day: string, ttlMs: number): Promise<MicroUsd> {
    const { rows } = await this.pool.query<{ total: string }>(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM agent_reservations WHERE agent_id = $1 AND day = $2 AND created_at >= now() - ($3 * interval '1 millisecond')",
      [agentId, day, ttlMs],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async housekeeping(reservationTtlMs: number): Promise<{ reservations: number; keys: number }> {
    let reservations = 0;
    // One transaction per orphan: the ledger row, the spend and the reservation deletion commit together or not at
    // all. Under the ledger lock, a second run or a second instance finds the reservation gone (or its key known)
    // and writes nothing. A database error leaves the reservation for the next run.
    for (let i = 0; i < MAX_PURGE_PER_RUN; i += 1) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [LEDGER_LOCK]);
        const { rows } = await client.query<{ id: string; agent_id: string; day: string; amount: string; action: string | null; model: string | null; request_hash: string | null }>(
          `SELECT id, agent_id, day, amount, action, model, request_hash FROM agent_reservations
            WHERE created_at < now() - ($1 * interval '1 millisecond') ORDER BY created_at, id LIMIT 1`,
          [reservationTtlMs],
        );
        const r = rows[0];
        if (!r) {
          await client.query("ROLLBACK");
          break;
        }
        const key = `interrupted:${r.id}`;
        const known = await client.query("SELECT 1 FROM ledger_idempotency WHERE key = $1", [key]);
        if (known.rows.length === 0) {
          const entry = await insertChained(client, {
            ts: new Date().toISOString(),
            agentId: r.agent_id,
            action: r.action ?? INTERRUPTED_FALLBACK_ACTION,
            model: r.model,
            verdict: "allowed",
            reason: INTERRUPTED_REASON,
            upstreamStatus: null,
            promptTokens: 0,
            completionTokens: 0,
            cost: Number(r.amount),
            requestHash: r.request_hash,
            responseHash: null,
          });
          await client.query("INSERT INTO ledger_idempotency (key, seq) VALUES ($1, $2)", [key, entry.seq]);
          // Same budget semantics as client_aborted_estimated: the reserved estimate becomes spend.
          if (Number(r.amount) > 0) await addSpendOnce(client, r.agent_id, r.day, Number(r.amount), key);
        }
        await client.query("DELETE FROM agent_reservations WHERE id = $1", [r.id]);
        await client.query("COMMIT");
        reservations += 1;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    const old = await this.pool.query("DELETE FROM ledger_idempotency WHERE created_at < now() - interval '30 days'");
    await this.pool.query("DELETE FROM spend_settlements WHERE created_at < now() - interval '30 days'");
    return { reservations, keys: old.rowCount ?? 0 };
  }

  async appendLedger(input: LedgerInput, options: AppendLedgerOptions = {}): Promise<LedgerEntry> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [LEDGER_LOCK]);
      // Idempotency, checked under the ledger lock: a first attempt still in flight (client timeout) holds the lock,
      // so this one waits for its COMMIT or ROLLBACK and then sees the key or not. No duplicate is possible.
      if (options.idempotencyKey !== undefined) {
        const known = await client.query<LedgerRow>(
          "SELECT l.* FROM ledger_idempotency k JOIN ledger l ON l.seq = k.seq WHERE k.key = $1",
          [options.idempotencyKey],
        );
        if (known.rows[0]) {
          await client.query("ROLLBACK");
          return toEntry(known.rows[0]);
        }
      }
      const entry = await insertChained(client, input);
      if (options.idempotencyKey !== undefined) {
        await client.query("INSERT INTO ledger_idempotency (key, seq) VALUES ($1, $2)", [options.idempotencyKey, entry.seq]);
      }
      // Budget settlement of a call that finished during an outage: same transaction, so ledger and spend never diverge.
      const s = options.settlement;
      if (s) {
        if (s.reservationId) await client.query("DELETE FROM agent_reservations WHERE id = $1", [s.reservationId]);
        if (s.amount > 0) await addSpendOnce(client, s.agentId, s.day, s.amount, s.key);
      }
      // The caller gave up (timeout) and keeps this row in the spool: committing now would duplicate it.
      if (options.signal?.aborted) throw new Error("ledger append abandoned by the caller");
      await client.query("COMMIT");
      return entry;
    } catch (error) {
      // Do not wait on a dead connection to roll back; the server rolls back when the session ends.
      broken = options.signal?.aborted === true;
      if (!broken) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release(broken ? true : undefined);
    }
  }

  async listLedger(options: LedgerQuery = {}): Promise<LedgerEntry[]> {
    // Sort direction comes from a closed list, never from input; every user value is a bound parameter.
    // Conditions are added only for the filters that are set (a static "$n IS NULL OR ..." form would keep the
    // planner from using the indexes). Each condition text is a constant; only the placeholder number varies.
    const direction = options.order === "desc" ? "DESC" : "ASC";
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (condition: (placeholder: string) => string, value: unknown) => {
      params.push(value);
      where.push(condition(`$${params.length}`));
    };
    add((p) => `seq > ${p}`, options.afterSeq ?? 0);
    add((p) => `seq < ${p}`, options.beforeSeq ?? Number.MAX_SAFE_INTEGER);
    if (options.fromTs) add((p) => `ts >= ${p}::text`, options.fromTs);
    if (options.beforeTs) add((p) => `ts < ${p}::text`, options.beforeTs);
    if (options.agentId !== undefined) add((p) => `agent_id = ${p}::text`, options.agentId);
    if (options.model !== undefined) add((p) => `model = ${p}::text`, options.model);
    if (options.verdict !== undefined) add((p) => `verdict = ${p}::text`, options.verdict);
    if (options.minCost !== undefined) add((p) => `cost >= ${p}::bigint`, options.minCost);
    if (options.maxCost !== undefined) add((p) => `cost <= ${p}::bigint`, options.maxCost);
    params.push(options.limit ?? 1000);
    const { rows } = await this.pool.query<LedgerRow>(
      `SELECT * FROM ledger WHERE ${where.join(" AND ")} ORDER BY seq ${direction} LIMIT $${params.length}`,
      params,
    );
    return rows.map(toEntry);
  }

  async reconcileSpend(day: string): Promise<SpendDivergence[]> {
    const next = new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
    // One pass: spend counters and ledger sums of the day, joined on the agent. Ledger ts is ISO text (UTC).
    const { rows } = await this.pool.query<{ agent_id: string; spent: string; ledger: string }>(
      `SELECT COALESCE(s.agent_id, l.agent_id) AS agent_id, COALESCE(s.amount, 0) AS spent, COALESCE(l.cost, 0) AS ledger
         FROM (SELECT agent_id, amount FROM agent_spend WHERE day = $1) s
         FULL OUTER JOIN (SELECT agent_id, SUM(cost) AS cost FROM ledger WHERE agent_id IS NOT NULL AND ts >= $1 AND ts < $2 GROUP BY agent_id) l
           ON l.agent_id = s.agent_id
        WHERE COALESCE(s.amount, 0) <> COALESCE(l.cost, 0)
        ORDER BY 1`,
      [day, next],
    );
    return rows.map((r) => ({ agentId: r.agent_id, spent: Number(r.spent), ledger: Number(r.ledger) }));
  }

  async ledgerFacets(): Promise<LedgerFacets> {
    const [agents, models] = await Promise.all([
      this.pool.query<{ v: string }>("SELECT DISTINCT agent_id AS v FROM ledger WHERE agent_id IS NOT NULL ORDER BY v"),
      this.pool.query<{ v: string }>("SELECT DISTINCT model AS v FROM ledger WHERE model IS NOT NULL ORDER BY v"),
    ]);
    return { agentIds: agents.rows.map((r) => r.v), models: models.rows.map((r) => r.v) };
  }
}
