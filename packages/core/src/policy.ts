import type { Agent, MicroUsd } from "./types.js";

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: "agent_disabled" | "model_not_allowed" | "budget_exceeded"; message: string };

export interface PolicyRequest {
  model: string;
  spentToday: MicroUsd;
}

/** Rules applied before every provider call. */
export function evaluate(agent: Agent, request: PolicyRequest): Decision {
  if (!agent.active) {
    return { allowed: false, reason: "agent_disabled", message: `Agent ${agent.name} is disabled.` };
  }
  const modelOk = agent.allowedModels.includes("*") || agent.allowedModels.includes(request.model);
  if (!modelOk) {
    return {
      allowed: false,
      reason: "model_not_allowed",
      message: `Model ${request.model} is not allowed for agent ${agent.name}.`,
    };
  }
  if (agent.dailyBudget > 0 && request.spentToday >= agent.dailyBudget) {
    return {
      allowed: false,
      reason: "budget_exceeded",
      message: `Daily budget reached for agent ${agent.name}.`,
    };
  }
  return { allowed: true };
}

/** An MCP tool is allowed by exact name, by "<server>/*" or by "*". */
export function toolMatches(patterns: string[], server: string, tool: string): boolean {
  return patterns.some((t) => t === "*" || t === `${server}/*` || t === `${server}/${tool}`);
}

/** Match a tool name against a list of exact names or glob patterns containing '*'. */
export function toolNameMatches(patterns: string[], tool: string): boolean {
  return patterns.some((p) => {
    if (p === tool) return true;
    if (!p.includes("*")) return false;
    const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return re.test(tool);
  });
}

export function toolAllowed(agent: Agent, server: string, tool: string): boolean {
  return toolMatches(agent.allowedTools, server, tool);
}

/** Human-readable summary of a tool call's arguments: short keys and values, strings truncated, 500 characters max. */
export function summarizeArgs(args: unknown, max = 500): string {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const value = (v: unknown): string => {
    if (typeof v === "string") return JSON.stringify(cut(v, 80));
    if (v === null || typeof v !== "object") return String(v);
    try {
      return cut(JSON.stringify(v), 80);
    } catch {
      return "…";
    }
  };
  if (args === undefined || args === null) return "";
  const text =
    typeof args === "object" && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>)
          .map(([k, v]) => `${cut(k, 40)}=${value(v)}`)
          .join(", ")
      : value(args);
  return cut(text, max);
}

/** Format of an allowed-tools entry: "*", "server/*" or "server/tool". */
export function validToolPattern(value: string): boolean {
  return value === "*" || /^[^\s/*]+\/(\*|[^\s/]+)$/.test(value);
}

/** UTC day as YYYY-MM-DD, key for the budget counters. */
export function budgetDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
