import { looksLikeAgentKey } from "./keys.js";
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

const REDACT_KEYS = [
  "password", "passwd", "secret", "token", "api_key", "apikey", "authorization",
  "cookie", "credential", "private_key", "access_key", "session",
];

/** Sanitize the complete value before any summary truncation; never mutate the call arguments. */
function redactArgs(args: unknown, extraKeys: readonly string[]): unknown {
  const keys = [...REDACT_KEYS, ...extraKeys.map((key) => key.trim().toLowerCase()).filter(Boolean)];
  const seen = new WeakSet<object>();
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      // Userinfo is the only secret for which we retain the surrounding string.
      // Authority ends at /, ? or #. Literal @ characters before its last @
      // belong to userinfo; percent-encoded separators remain part of that field.
      // WHATWG URL parsing strips ASCII tabs/newlines anywhere and trims C0/space.
      // Inspect that normalized candidate before extracting an authority.
      // Spaces do not end the authority: URL parsers accept and percent-encode them in userinfo.
      // Prose after a path-less URL may be over-redacted; that is preferred to a leak.
      const normalized = value.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
      let hasUserinfo = false;
      const redactedUrl = normalized.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/gi, (_url, scheme: string, authority: string) => {
        const separator = authority.lastIndexOf("@");
        if (separator < 0) return scheme + authority;
        hasUserinfo = true;
        return `${scheme}[redacted]@${authority.slice(separator + 1)}`;
      });
      const sanitized = hasUserinfo ? redactedUrl : value;
      // JWT segment lengths vary, and alg none permits an empty signature.
      // Prefer redacting JWT lookalikes over leaking a token.
      // Bound both sides so ordinary identifiers cannot contain a matching key.
      // Provider keys have substantial bodies; short prefix lookalikes stay visible.
      const knownSecret = /(?<![a-zA-Z0-9_-])(?:sk-(?:ant-)?[a-zA-Z0-9_-]{20,}|(?:ghp_|gho_)[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}|AKIA[0-9A-Z]{16}|xox[abpr]-[0-9]{10,13}-[0-9]{10,13}(?:-[0-9]{10,13})?-[a-zA-Z0-9]{20,}|eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]*|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)(?![a-zA-Z0-9_-])/;
      const agentKeys = sanitized.match(/(?<![a-zA-Z0-9_-])ga_[a-zA-Z0-9_-]{32}(?![a-zA-Z0-9_-])/g) ?? [];
      if (knownSecret.test(sanitized) || agentKeys.some(looksLikeAgentKey)) return "[redacted]";
      return sanitized;
    }
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "…";
    seen.add(value);
    const result: unknown = Array.isArray(value)
      ? value.map(visit)
      : Object.fromEntries(Object.entries(value).map(([key, child]) => [
          key, keys.some((part) => key.toLowerCase().includes(part)) ? "[redacted]" : visit(child),
        ]));
    seen.delete(value);
    return result;
  };
  return visit(args);
}

/** Human-readable, redacted tool arguments; strings truncated, 500 characters max by default. */
export function summarizeArgs(args: unknown, max = 500, extraKeys: readonly string[] = []): string {
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
  args = redactArgs(args, extraKeys);
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
