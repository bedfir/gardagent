/** Amounts in micro-dollars (1 USD = 1,000,000) so we stay in integers. */
export type MicroUsd = number;

export interface Operator {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface Agent {
  id: string;
  name: string;
  /** SHA-256 fingerprint of the agent key; the key itself is never stored. */
  keyHash: string;
  /** Allowed models. A "*" entry allows all models. */
  allowedModels: string[];
  /** Allowed MCP tools, as "<server>/<tool>"; "<server>/*" and "*" are wildcards. Empty = none. */
  allowedTools: string[];
  /** Allowed MCP tools whose invocation waits for a human decision (same format as allowedTools). */
  approvalTools: string[];
  /** Daily spending cap (UTC). 0 = unlimited. */
  dailyBudget: MicroUsd;
  /** Rolling 60-second admission cap; absent or zero means unlimited. */
  requestsPerMinute?: number;
  /** Active request cap; absent or zero means unlimited. */
  maxConcurrentRequests?: number;
  active: boolean;
}

export type Verdict = "allowed" | "denied";

export type ToolAccessClass = "read" | "write";

/** What the gateway asks to write into the ledger. */
export interface LedgerInput {
  /** Absent on historical entries; new store writes use version 2. */
  formatVersion?: number;
  policyRev?: string;
  operatorId?: string;
  approvalRef?: string;
  ts: string;
  agentId: string | null;
  action: string;
  model: string | null;
  verdict: Verdict;
  reason: string | null;
  upstreamStatus: number | null;
  promptTokens: number;
  completionTokens: number;
  cost: MicroUsd;
  /** Fingerprint of the request body: proves what was sent without keeping the data. */
  requestHash: string | null;
  responseHash: string | null;
  /**
   * True when the row went through the local spool because the database was unavailable (written late, its `ts`
   * is the time of the original call). Part of the hash only when true, so rows written before this field existed
   * keep their hash.
   */
  degraded?: boolean;
}

/**
 * Budget settlement applied in the same transaction as a ledger row (a call finished while the database was down).
 * `key` makes the spend increment idempotent; `day` is the budget day of the original request.
 */
export interface LedgerSettlement {
  key: string;
  agentId: string;
  day: string;
  amount: MicroUsd;
  /** Reservation left behind by the call: dropped in the same transaction. */
  reservationId?: string | null;
}

/** What a reservation remembers about its call, so that an orphaned one can still leave a ledger row. */
export interface ReservationMeta {
  policyRev?: string;
  action: string;
  model: string | null;
  requestHash: string | null;
}

/** Ledger reason of the row written when housekeeping purges the reservation of a call that never finished. */
export const INTERRUPTED_REASON = "interrupted_no_response";

/** Action used for the interrupted row of a reservation that holds no metadata (created before it was stored). */
export const INTERRUPTED_FALLBACK_ACTION = "unknown";

export interface AppendLedgerOptions {
  signal?: AbortSignal;
  /**
   * Stable id of the row (one per spool line). A second append with the same key commits nothing and returns the
   * row written by the first one: replaying a spool any number of times writes each line exactly once.
   */
  idempotencyKey?: string;
  settlement?: LedgerSettlement;
}

/** Ledger row, chained to the previous one. */
export interface LedgerEntry extends LedgerInput {
  seq: number;
  prevHash: string;
  hash: string;
}

/** Fields that can be updated on an agent. */
export interface AgentPatch {
  name?: string;
  allowedModels?: string[];
  allowedTools?: string[];
  approvalTools?: string[];
  dailyBudget?: MicroUsd;
  /** Rolling 60-second admission cap; absent or zero means unlimited. */
  requestsPerMinute?: number;
  /** Active request cap; absent or zero means unlimited. */
  maxConcurrentRequests?: number;
  active?: boolean;
}

/** Ledger rows grouped by UTC day, agent, verdict and reason (excluding "admin.*" actions). */
export interface LedgerAggregate {
  day: string;
  agentId: string | null;
  verdict: Verdict;
  reason: string | null;
  count: number;
  promptTokens: number;
  completionTokens: number;
  cost: MicroUsd;
}

export interface LedgerQuery {
  /** Rows whose timestamp is greater than or equal (ISO 8601 text, lexicographic comparison). */
  fromTs?: string;
  /** Rows whose timestamp is strictly lower. */
  beforeTs?: string;
  /** Rows whose seq is strictly greater. */
  afterSeq?: number;
  /** Rows whose seq is strictly lower. */
  beforeSeq?: number;
  limit?: number;
  /** Read order; "asc" by default. */
  order?: "asc" | "desc";
  /** Rows of this agent id (exact match). */
  agentId?: string;
  /** Rows of this model (exact match on the model field). */
  model?: string;
  /** Rows with this verdict. */
  verdict?: Verdict;
  /** Rows whose cost is greater than or equal (micro-USD, inclusive). */
  minCost?: MicroUsd;
  /** Rows whose cost is lower than or equal (micro-USD, inclusive). */
  maxCost?: MicroUsd;
}

/** One agent whose spend counter and ledger disagree for a day (micro-USD). */
export interface SpendDivergence {
  agentId: string;
  /** Amount in `agent_spend`. */
  spent: MicroUsd;
  /** Sum of the cost of the agent's ledger rows for the day. */
  ledger: MicroUsd;
}

/** Another agent already has this key hash (the hash column is unique). */
export class KeyHashCollisionError extends Error {
  constructor() {
    super("Agent key hash already in use");
    this.name = "KeyHashCollisionError";
  }
}

/** Distinct values present in the ledger, used to populate filter selectors. */
export interface LedgerFacets {
  /** Agent ids that appear on at least one row. */
  agentIds: string[];
  /** Models that appear on at least one row (null models excluded). */
  models: string[];
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/**
 * Human validation request for an MCP tool call. `argsSummary` (500 characters max) is the only
 * readable trace of the arguments: it lives in this table and never goes into the ledger.
 */
export interface Approval {
  policyRev?: string;
  operatorId?: string;
  id: string;
  createdAt: string;
  agentId: string;
  server: string;
  tool: string;
  argsHash: string;
  argsSummary: string;
  status: ApprovalStatus;
  decidedAt: string | null;
  reason: string | null;
  /** Whether the tool was classified as read or write when the request was created. */
  accessClass: ToolAccessClass;
}

export interface Store {
  createOperator(operator: Operator, tokenHash: string, audit: LedgerInput): Promise<void>;
  listOperators(): Promise<Operator[]>;
  findOperator(tokenHash: string): Promise<Operator | null>;
  revokeOperator(id: string, at: string, audit: LedgerInput): Promise<boolean>;
  getPolicyRevision(id: string): Promise<string | null>;
  /** Cheap availability probe (SELECT 1); rejects when the database is unreachable. Optional: absent for in-memory. */
  ping?(): Promise<void>;
  findAgentByKeyHash(keyHash: string): Promise<Agent | null>;
  createAgent(agent: Agent, audit?: LedgerInput): Promise<void>;
  getAgent(id: string): Promise<Agent | null>;
  /** Applies the supplied fields; returns the updated agent, or null if it does not exist. */
  updateAgent(id: string, patch: AgentPatch, audit?: LedgerInput): Promise<Agent | null>;
  /**
   * Replaces the stored key hash of an agent (same id, policy and history); returns the updated agent, or null if it
   * does not exist. Throws KeyHashCollisionError when another agent already has this hash.
   * With `audit`, that ledger row is written in the same transaction: if it cannot be written, the key is unchanged
   * and the call throws. Nothing is written when the agent does not exist or the hash collides.
   */
  rotateAgentKey(id: string, keyHash: string, audit?: LedgerInput): Promise<Agent | null>;
  listAgents(): Promise<Agent[]>;
  getSpent(agentId: string, day: string): Promise<MicroUsd>;
  /** With `idempotencyKey`, the amount is added at most once for that key. */
  addSpend(agentId: string, day: string, amount: MicroUsd, idempotencyKey?: string): Promise<void>;
  /**
   * Atomically reserves `amount` for an agent and day: succeeds only if live reservations + spend + amount
   * stay within `budget`. Returns the reservation id, or null if the budget would be exceeded.
   * Reservations older than `ttlMs` are ignored (crash safety).
   */
  reserve(agentId: string, day: string, amount: MicroUsd, budget: MicroUsd, ttlMs: number, meta?: ReservationMeta): Promise<string | null>;
  /** Replaces a reservation with the real cost (atomically); the spend is added even if the reservation expired. */
  settleReservation(reservationId: string, agentId: string, day: string, actual: MicroUsd, idempotencyKey?: string): Promise<void>;
  /** Drops a reservation without spending anything. */
  releaseReservation(reservationId: string): Promise<void>;
  /** Sum of live (non-expired) reservations. */
  getReserved(agentId: string, day: string, ttlMs: number): Promise<MicroUsd>;
  /**
   * Adds a ledger row serialised and returns the chained row. When `signal` is aborted before the row is committed,
   * the store must not commit it (the caller gave up and keeps the row elsewhere, e.g. in the spool).
   */
  appendLedger(input: LedgerInput, options?: AppendLedgerOptions): Promise<LedgerEntry>;
  /**
   * Housekeeping: purges reservations older than `reservationTtlMs` (orphans of crashed or outage-hit calls; the
   * same age after which they stop counting, so a live in-flight reservation is never touched) and idempotency
   * keys older than 30 days. Each purged reservation leaves an `interrupted_no_response` ledger row carrying the
   * reserved amount as cost, and the same amount is added to the agent's spend, in one atomic step keyed by the
   * reservation id (exactly once, whatever the number of runs or instances). If the row cannot be written the
   * reservation stays for the next run. Returns what was removed.
   */
  housekeeping(reservationTtlMs: number): Promise<{ reservations: number; keys: number }>;
  /** Ledger aggregate since `sinceDay` (YYYY-MM-DD, UTC) inclusive, "admin.*" actions excluded. */
  aggregateLedger(sinceDay: string): Promise<LedgerAggregate[]>;
  /** Ledger rows, ascending by seq by default; afterSeq and beforeSeq are exclusive bounds. */
  listLedger(options?: LedgerQuery): Promise<LedgerEntry[]>;
  /** Current committed head, or the genesis anchor for an empty ledger. */
  ledgerHead(): Promise<{ sequence: number; head_hash: string }>;
  /**
   * Agents whose `agent_spend` for `day` (YYYY-MM-DD, UTC) differs from the sum of their ledger cost on that day.
   * Only divergent agents are returned, sorted by agent id. Read-only: nothing is repaired.
   */
  reconcileSpend(day: string): Promise<SpendDivergence[]>;
  /** Distinct agent ids and models present in the ledger, sorted. */
  ledgerFacets(): Promise<LedgerFacets>;
  createApproval(approval: Approval, audit?: LedgerInput): Promise<void>;
  getApproval(id: string): Promise<Approval | null>;
  /** Decides a request still pending; returns null if it does not exist or is no longer pending. */
  decideApproval(id: string, status: Exclude<ApprovalStatus, "pending">, reason: string | null, decidedAt: string, operatorId?: string, audit?: LedgerInput): Promise<Approval | null>;
  /** Most recent requests first, filtered by status when provided. */
  listApprovals(options?: { status?: ApprovalStatus; limit?: number }): Promise<Approval[]>;
}
