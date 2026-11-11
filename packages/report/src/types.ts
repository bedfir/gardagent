export interface AdminAgent {
  id: string;
  name: string;
  allowedModels: string[];
  allowedTools: string[];
  dailyBudgetUsd: number;
  spentTodayUsd: number;
  active: boolean;
}

export interface StatsBucket {
  agentId: string | null;
  name: string | null;
  spentUsd: number;
  allowed: number;
  denied: number;
  deniedByReason: Record<string, number>;
  observedByReason: Record<string, number>;
  promptTokens: number;
  completionTokens: number;
}

export interface StatsDay extends StatsBucket {
  day: string;
  agents: StatsBucket[];
}

export interface StatsResponse {
  days: number;
  from: string;
  to: string;
  totals: Omit<StatsBucket, "agentId" | "name">;
  agents: StatsBucket[];
  byDay: StatsDay[];
}

export interface VerifyResponse {
  valid: boolean;
  checked: number;
  lastHash?: string;
  brokenAtSeq?: number;
  problem?: string;
}

export interface ReportInput {
  agents: AdminAgent[];
  stats: StatsResponse;
  verify: VerifyResponse;
}

export type ReportData = ReportInput;
