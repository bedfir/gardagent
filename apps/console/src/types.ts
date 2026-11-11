/** Shapes returned by the gateway /admin routes. */
export interface Agent {
  id: string;
  name: string;
  allowedModels: string[];
  allowedTools: string[];
  approvalTools: string[];
  dailyBudgetUsd: number;
  /** Today's spend (UTC) in dollars. */
  spentTodayUsd: number;
  /** Budget held by in-flight requests, in dollars. */
  reservedTodayUsd: number;
  active: boolean;
}

export interface StatsBucket {
  spentUsd: number;
  allowed: number;
  denied: number;
  deniedByReason: Record<string, number>;
  observedByReason: Record<string, number>;
  promptTokens: number;
  completionTokens: number;
}

export interface StatsAgent extends StatsBucket {
  agentId: string | null;
  name: string | null;
}

export interface StatsDay extends StatsBucket {
  day: string;
  agents: StatsAgent[];
}

export interface Stats {
  days: number;
  from: string;
  to: string;
  totals: StatsBucket;
  agents: StatsAgent[];
  byDay: StatsDay[];
}

export interface LedgerEntry {
  seq: number;
  ts: string;
  agentId: string | null;
  action: string;
  model: string | null;
  verdict: "allowed" | "denied";
  reason: string | null;
  upstreamStatus: number | null;
  promptTokens: number;
  completionTokens: number;
  /** Micro-dollars. */
  cost: number;
  requestHash: string | null;
  responseHash: string | null;
  prevHash: string;
  hash: string;
}

export interface VerifyResult {
  valid: boolean;
  checked: number;
  lastHash?: string;
  brokenAtSeq?: number;
  problem?: string;
}

/** Agents whose spend counter differs from their ledger cost for the current UTC day. */
export interface SpendCheck {
  day: string;
  divergences: { agentId: string; name: string | null; spentUsd: number; ledgerUsd: number }[];
}

export interface CreatedAgent {
  agent: Agent;
  key: string;
}

export interface Approval {
  id: string;
  createdAt: string;
  agentId: string;
  server: string;
  tool: string;
  argsHash: string;
  argsSummary: string;
  status: "pending" | "approved" | "rejected" | "expired";
  decidedAt: string | null;
  reason: string | null;
  accessClass: "read" | "write";
}

export interface LedgerFacets {
  /** Agents present in the ledger; `name` is null for an id that is not (or no longer) registered. */
  agents: { id: string; name: string | null }[];
  models: string[];
}
