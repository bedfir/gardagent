import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { Transform } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { looksLikeAgentKey, type Store } from "@gardagent/core";
import { AuthFailureLimiter, authSummaryRow, UNAUTHENTICATED_BODY_LIMIT } from "./auth-limiter.js";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_AUTH_FAIL_WINDOW_MS } from "./config.js";
import { ApprovalHub } from "./approvals.js";
import { registerAdmin } from "./admin.js";
import { registerAnthropic } from "./anthropic.js";
import { registerMcp } from "./mcp.js";
import { guardOptions, type GatewayConfig } from "./config.js";
import { registerProxy } from "./proxy.js";
import { DbTimeoutError, ledgerGuardFor } from "./ledger-guard.js";

export interface AppDeps {
  config: GatewayConfig;
  store: Store;
  fetch?: typeof fetch;
  logger?: FastifyServerOptions["logger"];
  /**
   * Directory of the built console (the one containing index.html), served under /console/.
   * Default: the GARDAGENT_CONSOLE_DIR environment variable. Pass null to disable.
   * The console is served only if the directory exists.
   */
  consoleDir?: string | null;
  /** Clock of the authentication failure limiter (tests). Default Date.now. */
  clock?: () => number;
}

function rateLimited(retryAfterSeconds: number) {
  return {
    retryAfterSeconds,
    body: { error: { type: "gardagent_policy", code: "auth_rate_limited", message: "Too many failed authentication attempts from this address; retry later." } },
  };
}

/** Declares a 413 for a request body that exceeds `limit`, as soon as it is known. */
function tooLarge(limit: number): Error & { statusCode: number } {
  return Object.assign(new Error(`Request body too large (limit ${limit} bytes without a valid agent key).`), { statusCode: 413 });
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ? {
      ...(typeof deps.logger === "object" ? deps.logger : {}),
      redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-api-key"]', 'res.headers["set-cookie"]'],
    } : false,
    bodyLimit: 10 * 1024 * 1024,
    // Source address for the failure limiter: X-Forwarded-For is honored only as configured (GARDAGENT_TRUST_PROXY).
    trustProxy: deps.config.trustProxy ?? false,
  });

  const limiterOptions = { limit: deps.config.authFailLimit ?? DEFAULT_AUTH_FAIL_LIMIT, windowMs: deps.config.authFailWindowMs ?? DEFAULT_AUTH_FAIL_WINDOW_MS, now: deps.clock };
  app.decorate("agentAuthLimiter", new AuthFailureLimiter(limiterOptions));
  // Admin failures write no ledger row: no aggregated counts to keep (and nothing ever drains this limiter).
  app.decorate("adminAuthLimiter", new AuthFailureLimiter({ ...limiterOptions, trackSuppressed: false }));
  // Refuse a blocked address before anything is parsed or authenticated.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    const limiter = path === "/admin" || path.startsWith("/admin/") ? app.adminAuthLimiter : path.startsWith("/v1/") || path.startsWith("/mcp/") ? app.agentAuthLimiter : null;
    const wait = limiter?.retryAfterSeconds(request.ip) ?? 0;
    if (wait > 0) {
      const r = rateLimited(wait);
      return reply.code(429).header("Retry-After", String(wait)).send(r.body);
    }
  });
  // A request on /v1 or /mcp without a well-formed agent key is going to be refused: do not read more than a small body for it.
  app.addHook("preParsing", async (request, _reply, payload) => {
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/v1/") && !path.startsWith("/mcp/")) return payload;
    const xApiKey = request.headers["x-api-key"];
    const header = request.headers.authorization;
    const candidates = [Array.isArray(xApiKey) ? xApiKey[0] : xApiKey, header && header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined];
    if (candidates.some((c) => typeof c === "string" && looksLikeAgentKey(c.trim()))) return payload;
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > UNAUTHENTICATED_BODY_LIMIT) throw tooLarge(UNAUTHENTICATED_BODY_LIMIT);
    let seen = 0;
    return payload.pipe(
      new Transform({
        transform(chunk: Buffer, _enc, callback) {
          seen += chunk.length;
          callback(seen > UNAUTHENTICATED_BODY_LIMIT ? tooLarge(UNAUTHENTICATED_BODY_LIMIT) : null, chunk);
        },
      }),
    );
  });

  const guard = ledgerGuardFor(deps.store, app.log, guardOptions(deps.config));
  /** Writes one aggregated row per ended window of failures that were counted without their own row. */
  const flushAuthSummaries = async (force = false) => {
    for (const n of app.agentAuthLimiter.drain(force)) {
      try {
        await guard.append(authSummaryRow(n));
      } catch (error) {
        app.log.error({ err: error }, "Could not write the aggregated invalid_key row");
      }
    }
  };
  const flushTimer = setInterval(() => void flushAuthSummaries(), limiterOptions.windowMs);
  flushTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(flushTimer);
    await flushAuthSummaries(true);
    await guard.stop();
  });
  // Fail closed before any work (and any provider call) while the store is known to be down.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (path === "/" || path === "/health" || path.startsWith("/console")) return;
    if (guard.isReady()) return;
    // Observe + fail-open: LLM and MCP traffic continues while the spool can durably take the proof.
    // Everything else (admin, console data) needs the database.
    if (guard.failOpen && (path.startsWith("/v1/") || path.startsWith("/mcp/")) && (await guard.admissible())) return;
    {
      return reply.code(503).send({ error: { type: "gardagent_policy", code: "ledger_unavailable", message: "The audit ledger is unavailable; request refused (fail closed)." } });
    }
  });
  // An unexpected error while the database is unreachable is a 503, not a 500: the first failing request
  // flips the health flag immediately instead of waiting for the next probe.
  app.setErrorHandler(async (error: Error & { statusCode?: number }, request, reply) => {
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: { type: "invalid_request", message: error.message } });
    }
    // A database timeout already proved the outage: answer at once instead of probing (and waiting) again.
    if (error instanceof DbTimeoutError || !(await guard.probe())) {
      guard.markUnhealthy();
      request.log.error({ err: error }, "Database unreachable: request refused");
      return reply.code(503).send({ error: { type: "gardagent_policy", code: "ledger_unavailable", message: "The audit ledger is unavailable; request refused (fail closed)." } });
    }
    request.log.error({ err: error }, "Unhandled error");
    return reply.code(error.statusCode ?? 500).send({ error: { type: "internal_error", message: "Internal error." } });
  });
  app.get("/health", async (_request, reply) => {
    const databaseUp = await guard.probe();
    const spool = await guard.spoolStatus();
    const spoolBacklog = spool.backlog;
    const status = databaseUp && spoolBacklog === 0 ? "ok" : "degraded";
    // Serving without the database is possible only in fail-open with a writable spool.
    const serving = databaseUp || (guard.failOpen && spool.writable);
    if (!serving) reply.code(503);
    const ledgerStatus = status === "ok" ? "ok" : serving ? "degraded" : "down";
    return {
      status,
      mode: deps.config.mode,
      database: databaseUp ? "up" : "down",
      spoolBacklog,
      ledger: {
        status: ledgerStatus,
        dbOutagePolicy: guard.failOpen ? "fail-open" : "fail-closed",
        spool,
      },
    };
  });
  app.get("/", async (_request, reply) => reply.code(302).header("Location", "/console/").send());
  const approvals = new ApprovalHub(deps.store, deps.config.approvalPollMs);
  registerProxy(app, { config: deps.config, store: deps.store, fetch: deps.fetch ?? fetch });
  registerAnthropic(app, { config: deps.config, store: deps.store, fetch: deps.fetch ?? fetch });
  if (Object.keys(deps.config.mcpServers).length > 0) {
    registerMcp(app, { config: deps.config, store: deps.store, approvals, fetch: deps.fetch ?? fetch });
  }
  registerAdmin(app, { config: deps.config, store: deps.store, approvals });

  const consoleDir = deps.consoleDir === undefined ? process.env.GARDAGENT_CONSOLE_DIR : deps.consoleDir;
  if (consoleDir && existsSync(consoleDir)) {
    app.register(fastifyStatic, { root: resolve(consoleDir), prefix: "/console/" });
    app.get("/console", async (_request, reply) => reply.redirect("/console/"));
  }
  return app;
}

/** Starts the spool replay (at startup and on a timer). Called by main; tests drive the guard directly. */
export async function startLedgerReplay(app: FastifyInstance, store: Store, config: GatewayConfig): Promise<void> {
  await ledgerGuardFor(store, app.log, guardOptions(config)).start();
}
