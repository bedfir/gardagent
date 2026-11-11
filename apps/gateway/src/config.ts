import type { ModelPrice, PriceTable } from "@gardagent/core";
import { AGENT_CACHE_MAX_ENTRIES, AGENT_CACHE_OUTAGE_GRACE_MS, parseAgentCacheTtlMs, type AgentCacheOptions } from "./agent-cache.js";

export interface McpServer {
  url: string;
  headers: Record<string, string>;
  /** Tool names considered READ-only; all other tools are WRITE. Missing = all WRITE. */
  readTools?: string[];
}

/** GARDAGENT_MCP_SERVERS : JSON { "<name>": { "url": "https://…/mcp", "headers": { … } } }. */
export function parseMcpServers(value: string | undefined): Record<string, McpServer> {
  if (!value || !value.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("GARDAGENT_MCP_SERVERS is not valid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("GARDAGENT_MCP_SERVERS must be an object { name: { url, headers } }.");
  }
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const e = entry as { url?: unknown; headers?: unknown; readTools?: unknown } | null;
    if (!e || typeof e.url !== "string" || !/^https?:\/\//.test(e.url)) {
      throw new Error(`GARDAGENT_MCP_SERVERS: server "${name}" URL must start with http:// or https://.`);
    }
    const headers = e.headers ?? {};
    if (typeof headers !== "object" || Array.isArray(headers) || Object.values(headers).some((v) => typeof v !== "string")) {
      throw new Error(`GARDAGENT_MCP_SERVERS: server "${name}" headers must be strings.`);
    }
    if (e.readTools !== undefined && (!Array.isArray(e.readTools) || e.readTools.some((t) => typeof t !== "string" || !t))) {
      throw new Error(`GARDAGENT_MCP_SERVERS: server "${name}" readTools must be a list of non-empty strings.`);
    }
    out[name] = { url: e.url, headers: headers as Record<string, string>, readTools: e.readTools as string[] | undefined };
  }
  return out;
}

export type GatewayMode = "enforce" | "observe";

/** Behavior when the database is down: refuse traffic (default) or keep forwarding with a durable spool. */
export type DbOutagePolicy = "fail-closed" | "fail-open";

export function parseDbOutage(value: string | undefined): DbOutagePolicy {
  const v = (value ?? "fail-closed").trim().toLowerCase();
  if (v === "fail-closed" || v === "fail-open") return v;
  throw new Error(`GARDAGENT_DB_OUTAGE must be "fail-closed" or "fail-open", got "${value}".`);
}

const DEFAULT_SPOOL_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Timeout variables (milliseconds). Defaults: GARDAGENT_DB_CALL_TIMEOUT_MS 600 (request-path database call),
 * GARDAGENT_DB_PROBE_TIMEOUT_MS 800 (health probe), GARDAGENT_DB_CONNECT_TIMEOUT_MS 2000 (wait for a pooled connection).
 */
export function parseTimeoutMs(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 50 || n > 60_000) throw new Error(`${name} must be an integer between 50 and 60000 (milliseconds).`);
  return n;
}

export function parseSpoolMaxBytes(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_SPOOL_MAX_BYTES;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 4096) throw new Error("GARDAGENT_SPOOL_MAX_BYTES must be an integer of at least 4096.");
  return n;
}

/** Minimum length of GARDAGENT_ADMIN_TOKEN (openssl rand -hex 32 gives 64). */
export const MIN_ADMIN_TOKEN_LENGTH = 32;
export const DEFAULT_AUTH_FAIL_LIMIT = 10;
export const DEFAULT_AUTH_FAIL_WINDOW_MS = 60_000;

/** GARDAGENT_AUTH_FAIL_LIMIT: failed authentications per source address and window before a 429; 0 disables. */
export function parseAuthFailLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_AUTH_FAIL_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new Error("GARDAGENT_AUTH_FAIL_LIMIT must be an integer between 0 (disabled) and 100000.");
  return n;
}

/** GARDAGENT_AUTH_FAIL_WINDOW_MS: length of the failure-counting window (1000 to 3600000). */
export function parseAuthFailWindowMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_AUTH_FAIL_WINDOW_MS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1000 || n > 3_600_000) throw new Error("GARDAGENT_AUTH_FAIL_WINDOW_MS must be an integer between 1000 and 3600000 (milliseconds).");
  return n;
}

/**
 * GARDAGENT_TRUST_PROXY: how Fastify derives the client address from X-Forwarded-For. Default false (the socket
 * address is used). Behind a reverse proxy set "true" (only when the proxy is the sole way to reach the gateway and
 * it overwrites X-Forwarded-For, as Caddy does) or the proxy addresses/CIDRs, comma-separated. Hop counts are refused:
 * their meaning is easy to get wrong.
 */
export function parseTrustProxy(value: string | undefined): boolean | string[] {
  const v = (value ?? "").trim();
  if (v === "" || v.toLowerCase() === "false") return false;
  if (v.toLowerCase() === "true") return true;
  if (/^\d+$/.test(v)) throw new Error('GARDAGENT_TRUST_PROXY must be "true", "false" or a comma-separated list of proxy addresses or CIDRs (hop counts are not supported).');
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

const LOOPBACK_HOST = /^(localhost|::1|\[::1\]|127(\.\d{1,3}){3})$/i;

/**
 * Startup warning when the application listens beyond the loopback interface and no admin source allow-list is
 * configured. The application itself does no network filtering: GARDAGENT_ADMIN_ALLOWED_CIDRS is enforced by the
 * reverse proxy of deploy/ (Caddy). Returns null when there is nothing to warn about.
 */
export function adminExposureWarning(host: string, env: NodeJS.ProcessEnv): string | null {
  if (LOOPBACK_HOST.test(host.trim())) return null;
  if ((env.GARDAGENT_ADMIN_ALLOWED_CIDRS ?? "").trim() !== "") return null;
  return (
    `Listening on ${host} with no GARDAGENT_ADMIN_ALLOWED_CIDRS set: /admin and /console are protected only by the admin token, ` +
    `and the application does not filter source addresses itself. Publish the port on 127.0.0.1 only, or put a reverse proxy in front ` +
    `that restricts /admin/* and /console/* to your administrators' network (see deploy/Caddyfile).`
  );
}

/** Fail-open is effective only in observe mode: in enforce mode an outage is always fail-closed. */
export function failOpenActive(config: Pick<GatewayConfig, "mode" | "dbOutage">): boolean {
  return config.dbOutage === "fail-open" && config.mode === "observe";
}

export interface GatewayConfig {
  port: number;
  host: string;
  /** Enforcement mode: enforce blocks policy violations, observe only logs them. */
  mode: GatewayMode;
  /** OpenAI-compatible provider URL, without the trailing /v1. */
  upstreamBaseUrl: string;
  /** Real provider key, held by the gateway and never by the agents. */
  upstreamApiKey: string;
  /** Anthropic Messages provider URL, without the trailing /v1; defaults to the one above. */
  anthropicUpstreamBaseUrl: string;
  anthropicUpstreamApiKey: string;
  /** Client headers forwarded to the provider (lowercase). Empty = none forwarded, none generated. */
  forwardHeaders: string[];
  /** Governed MCP servers, by name. Empty = /mcp route absent. Headers carry their secrets. */
  mcpServers: Record<string, McpServer>;
  /** Token for the /admin routes. */
  adminToken: string;
  databaseUrl: string | null;
  prices: PriceTable;
  /** Price applied to a model not in the table. */
  fallbackPrice: ModelPrice;
  /** Maximum duration of a provider call, in milliseconds. */
  upstreamTimeoutMs: number;
  /** Output tokens assumed for the budget reservation when the request sets no max_tokens. */
  defaultMaxOutputTokens: number;
  /** Wait time for a human decision on an approval-required MCP tool, in milliseconds. */
  approvalTimeoutMs: number;
  /** Fallback store polling interval (decision coming from another instance); defaults to 2000. */
  approvalPollMs?: number;
  /** Append-only JSON Lines file receiving ledger rows the database could not take (GARDAGENT_LEDGER_SPOOL). */
  ledgerSpoolPath?: string;
  /** GARDAGENT_DB_OUTAGE. Only honored in observe mode (see failOpenActive). Default fail-closed. */
  dbOutage?: DbOutagePolicy;
  /** GARDAGENT_SPOOL_MAX_BYTES: hard cap of the spool file; default 64 MiB. */
  spoolMaxBytes?: number;
  /** GARDAGENT_DB_CALL_TIMEOUT_MS: maximum wait of a database call on the request path; default 600. */
  dbCallTimeoutMs?: number;
  /** GARDAGENT_DB_PROBE_TIMEOUT_MS: maximum wait of the health probe; default 800. */
  dbProbeTimeoutMs?: number;
  /** GARDAGENT_DB_CONNECT_TIMEOUT_MS: maximum wait for a pooled connection; default 2000. */
  dbConnectTimeoutMs?: number;
  /** GARDAGENT_AGENT_CACHE_TTL_MS: lifetime of a cached agent (1000 to 600000); default 30000. */
  agentCacheTtlMs?: number;
  /** GARDAGENT_AUTH_FAIL_LIMIT: failed authentications per source address per window before a 429 (0 = disabled); default 10. */
  authFailLimit?: number;
  /** GARDAGENT_AUTH_FAIL_WINDOW_MS: window of the failure counter; default 60000. */
  authFailWindowMs?: number;
  /** GARDAGENT_TRUST_PROXY: Fastify trustProxy setting; default false. */
  trustProxy?: boolean | string[];
}

/** Extra time past the upstream timeout before an unsettled reservation stops counting. */
export const RESERVATION_MARGIN_MS = 30_000;

/** Indicative prices in USD per million tokens; adjust to your provider's actual price list. */
export const DEFAULT_PRICES: PriceTable = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "mistral-small": { input: 0.1, output: 0.3 },
  "mistral-large": { input: 2, output: 6 },
};

/** Comma-separated list, case-insensitive; absent = session header only. */
export function parseForwardHeaders(value: string | undefined): string[] {
  if (value === undefined) return ["x-opencode-session"];
  return [...new Set(value.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean))];
}

export function parseMode(value: string | undefined): GatewayMode {
  const mode = value ?? "enforce";
  if (mode === "enforce" || mode === "observe") return mode;
  throw new Error(`GARDAGENT_MODE must be "enforce" or "observe", got "${mode}".`);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const prices = env.GARDAGENT_PRICES ? (JSON.parse(env.GARDAGENT_PRICES) as PriceTable) : DEFAULT_PRICES;
  const upstreamBaseUrl = required(env, "UPSTREAM_BASE_URL").replace(/\/+$/, "");
  const upstreamApiKey = required(env, "UPSTREAM_API_KEY");
  const mode = parseMode(env.GARDAGENT_MODE);
  const adminToken = required(env, "GARDAGENT_ADMIN_TOKEN");
  if (adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new Error(`GARDAGENT_ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters long (generate one with: openssl rand -hex 32).`);
  }
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    mode,
    upstreamBaseUrl,
    upstreamApiKey,
    anthropicUpstreamBaseUrl: env.ANTHROPIC_UPSTREAM_BASE_URL
      ? env.ANTHROPIC_UPSTREAM_BASE_URL.replace(/\/+$/, "")
      : upstreamBaseUrl,
    anthropicUpstreamApiKey: env.ANTHROPIC_UPSTREAM_API_KEY || upstreamApiKey,
    forwardHeaders: parseForwardHeaders(env.UPSTREAM_FORWARD_HEADERS),
    mcpServers: parseMcpServers(env.GARDAGENT_MCP_SERVERS),
    adminToken,
    databaseUrl: env.DATABASE_URL ?? null,
    prices,
    fallbackPrice: { input: 10, output: 30 },
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS ?? 120_000),
    defaultMaxOutputTokens: Number(env.GARDAGENT_DEFAULT_MAX_OUTPUT_TOKENS ?? 1024),
    approvalTimeoutMs: Number(env.GARDAGENT_APPROVAL_TIMEOUT_MS ?? 120_000),
    ledgerSpoolPath: env.GARDAGENT_LEDGER_SPOOL || "/app/spool/ledger.jsonl",
    dbOutage: parseDbOutage(env.GARDAGENT_DB_OUTAGE),
    spoolMaxBytes: parseSpoolMaxBytes(env.GARDAGENT_SPOOL_MAX_BYTES),
    dbCallTimeoutMs: parseTimeoutMs("GARDAGENT_DB_CALL_TIMEOUT_MS", env.GARDAGENT_DB_CALL_TIMEOUT_MS, 600),
    dbProbeTimeoutMs: parseTimeoutMs("GARDAGENT_DB_PROBE_TIMEOUT_MS", env.GARDAGENT_DB_PROBE_TIMEOUT_MS, 800),
    dbConnectTimeoutMs: parseTimeoutMs("GARDAGENT_DB_CONNECT_TIMEOUT_MS", env.GARDAGENT_DB_CONNECT_TIMEOUT_MS, 2000),
    agentCacheTtlMs: parseAgentCacheTtlMs(env.GARDAGENT_AGENT_CACHE_TTL_MS),
    authFailLimit: parseAuthFailLimit(env.GARDAGENT_AUTH_FAIL_LIMIT),
    authFailWindowMs: parseAuthFailWindowMs(env.GARDAGENT_AUTH_FAIL_WINDOW_MS),
    trustProxy: parseTrustProxy(env.GARDAGENT_TRUST_PROXY),
  };
}

/** Options of the agent cache: configurable TTL, fixed outage grace window and entry cap. */
export function agentCacheOptions(config: Pick<GatewayConfig, "agentCacheTtlMs">): AgentCacheOptions {
  return { ttlMs: config.agentCacheTtlMs, graceMs: AGENT_CACHE_OUTAGE_GRACE_MS, maxEntries: AGENT_CACHE_MAX_ENTRIES };
}

/** Options of the ledger guard derived from the configuration (fail-open only in observe mode). */
export function guardOptions(config: GatewayConfig) {
  return {
    reservationTtlMs: config.upstreamTimeoutMs + RESERVATION_MARGIN_MS,
    spoolPath: config.ledgerSpoolPath,
    failOpen: failOpenActive(config),
    spoolMaxBytes: config.spoolMaxBytes,
    callTimeoutMs: config.dbCallTimeoutMs,
    probeTimeoutMs: config.dbProbeTimeoutMs,
  };
}
