import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { policyRevision, canonicalJson, sha256, summarizeArgs, toolAllowed, toolMatches, toolNameMatches, type Approval, type Store, type ToolAccessClass } from "@gardagent/core";
import { REQUESTED, type ApprovalHub } from "./approvals.js";
import type { GatewayConfig } from "./config.js";
import { AGENT_UNVERIFIABLE_CODE, AGENT_UNVERIFIABLE_MESSAGE, AgentUnverifiableError, bearer, createGovernance } from "./shared.js";
import { SseSplitter, parseSseData } from "./sse.js";

export const MCP_REQUESTS = ["initialize", "ping", "tools/list", "tools/call"] as const;
export const MCP_NOTIFICATIONS = ["notifications/initialized", "notifications/cancelled"] as const;
export const MCP_SERVER_NOTIFICATIONS = ["notifications/progress", "notifications/message", "notifications/cancelled", "notifications/tools/list_changed", "notifications/prompts/list_changed", "notifications/resources/list_changed", "notifications/resources/updated"] as const;
const ACTION = "mcp.tools/call";
/** MCP headers relayed in both directions. */
const SESSION = "mcp-session-id";
const PROTOCOL = "mcp-protocol-version";

interface McpDeps {
  config: GatewayConfig;
  store: Store;
  approvals: ApprovalHub;
  fetch: typeof fetch;
}

type Id = string | number | null;

const rpcError = (id: Id, code: number, message: string, data?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data ? { data } : {}) },
});

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return (Array.isArray(v) ? v[0] : v) || undefined;
}

/** MCP proxy with explicit admission and default refusal. */
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const { config } = deps;
  const gov = createGovernance(app, deps);

  app.route({ method: ["GET", "DELETE"], url: "/mcp/:server", handler: async (_request, reply) =>
    reply.header("allow", "POST").code(405).send(rpcError(null, -32000, "Only POST is supported.")) });

  app.post("/mcp/:server", async (request, reply) => {
    const { server: serverName } = request.params as { server: string };
    const server = Object.hasOwn(config.mcpServers, serverName) ? config.mcpServers[serverName] : undefined;

    let agent;
    try {
      agent = await gov.authenticate("mcp", bearer(request), request.ip);
    } catch (error) {
      if (!(error instanceof AgentUnverifiableError)) throw error;
      return reply.code(503).send(rpcError(null, -32000, AGENT_UNVERIFIABLE_MESSAGE, { code: AGENT_UNVERIFIABLE_CODE }));
    }
    if (!agent) return reply.code(401).send(rpcError(null, -32000, "Invalid or missing Gardagent agent key."));
    if (!server) return reply.code(404).send(rpcError(null, -32000, `Unknown MCP server "${serverName}".`));

    const body = request.body as unknown;
    if (Array.isArray(body)) {
      return reply.code(400).send(rpcError(null, -32600, "JSON-RPC batches are not supported: send one message per request."));
    }
    const msg = body as { jsonrpc?: unknown; method?: unknown; id?: unknown; params?: unknown } | null;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      return reply.code(400).send(rpcError(null, -32600, "Invalid JSON-RPC 2.0 request."));
    }
    const id: Id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;

    const notification = !Object.hasOwn(msg, "id");
    const zero = { upstreamStatus: null, promptTokens: 0, completionTokens: 0, cost: 0, responseHash: null };
    const base = {
      agentId: agent.id, action: `mcp.${String(msg.method ?? "client_response").slice(0, 100)}`,
      model: `${serverName}/-`, policyRev: policyRevision(agent).id,
      requestHash: sha256(canonicalJson(msg.params ?? {})),
    };
    const journal = async (reason: string | null, denied = false) => gov.record({
      ...base, ...zero, verdict: denied ? "denied" : "allowed", reason,
    });
    const objectParams = msg.params === undefined || (msg.params !== null && typeof msg.params === "object" && !Array.isArray(msg.params));
    if (typeof msg.method !== "string" || !msg.method || (!notification && msg.id !== null && typeof msg.id !== "string" && typeof msg.id !== "number") || !objectParams) {
      await journal("mcp_client_response_refused", true);
      return reply.code(400).send(rpcError(id, -32600, "Invalid JSON-RPC request."));
    }
    let observedReason: string | null = null;
    const rate = await gov.rateLimit(agent, reply, base);
    if (rate.denied) return notification ? reply.code(429).send() : reply.code(200).send(rpcError(id, -32004, "Agent request limit reached.", { retryAfter: rate.retryAfter }));
    if (rate.observed) observedReason = "observed:rate_limited";
    const declared = notification
      ? (MCP_NOTIFICATIONS as readonly string[]).includes(msg.method)
      : (MCP_REQUESTS as readonly string[]).includes(msg.method);
    if (!declared) {
      if (config.mode !== "observe") {
        await journal("method_not_governed", true);
        return notification ? reply.code(202).send() : reply.send(rpcError(id, -32601, "Method not governed."));
      }
      observedReason ??= "observed:method_not_governed";
    }
    if (notification && msg.method === "notifications/cancelled" &&
        !["string", "number"].includes(typeof (msg.params as Record<string, unknown> | undefined)?.requestId)) {
      await journal("invalid_params", true);
      return reply.code(202).send();
    }
    let tool: string | null = null;
    let ctxBase: { agentId: string; action: string; model: string; requestHash: string; policyRev: string; approvalRef?: string } = base;
    let toolArgs: unknown;
    let accessClass: ToolAccessClass = "write";
    if (!notification && msg.method === "tools/call") {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string" || !params.name) {
        await journal("invalid_params", true);
        return reply.code(200).send(rpcError(id, -32602, "The « name » parameter of tools/call is required."));
      }
      tool = params.name;
      toolArgs = params.arguments;
      accessClass = toolNameMatches(server.readTools ?? [], tool) ? "read" : "write";
      ctxBase = {
        agentId: agent.id,
        action: ACTION,
        policyRev: policyRevision(agent).id,
        model: `${serverName}/${tool}`,
        // Fingerprint of the arguments: never the arguments themselves in the ledger.
        requestHash: sha256(canonicalJson(params.arguments ?? {})),
      };
      if (!toolAllowed(agent, serverName, tool)) {
        if (config.mode === "observe") {
          observedReason ??= "observed:tool_not_allowed";
        } else {
          await gov.record({
            ...ctxBase,
            model: `${ctxBase.model}#${accessClass}`,
            verdict: "denied",
            reason: "tool_not_allowed",
            upstreamStatus: null,
            promptTokens: 0,
            completionTokens: 0,
            cost: 0,
            responseHash: null,
          });
          return reply
            .code(200)
            .send(rpcError(id, -32001, `Tool "${tool}" on server "${serverName}" is not allowed for agent ${agent.name}.`));
        }
      }
    }

    if (!notification && msg.method === "ping") {
      await journal(observedReason);
      return reply.send({ jsonrpc: "2.0", id, result: {} });
    }

    // Human validation: WRITE tools always require approval; READ tools only if listed in approvalTools.
    const approvalRequired = accessClass === "write" || (tool ? toolMatches(agent.approvalTools, serverName, tool) : false);
    // Database down (observe + fail-open): approval state lives in the database, so any call that needs approval
    // and any write tool is refused. Never let a write through without approval.
    if (tool && ctxBase && approvalRequired && gov.degraded()) {
      await gov.record({
        ...ctxBase,
        model: `${ctxBase.model}#${accessClass}`,
        verdict: "denied",
        reason: "approval_unavailable_db_outage",
        upstreamStatus: null,
        promptTokens: 0,
        completionTokens: 0,
        cost: 0,
        responseHash: null,
      });
      return reply.code(503).send(rpcError(id, -32003, `Tool "${tool}" requires approval and the approval store is unavailable (database outage); refused.`));
    }
    if (tool && ctxBase && observedReason !== "observed:tool_not_allowed" && approvalRequired) {
      if (config.mode === "observe") {
        observedReason ??= "observed:approval_required";
      } else {
      const closed = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) closed.abort();
      });
      const approvalId = randomUUID();
      ctxBase.approvalRef = approvalId;
      const approval: Approval = {
        policyRev: ctxBase.policyRev,
        id: approvalId,
        createdAt: new Date().toISOString(),
        agentId: agent.id,
        server: serverName,
        tool,
        argsHash: ctxBase.requestHash,
        argsSummary: summarizeArgs(toolArgs),
        status: "pending",
        decidedAt: null,
        reason: null,
        accessClass,
      };
      const zero = { upstreamStatus: null, promptTokens: 0, completionTokens: 0, cost: 0, responseHash: null };
      try {
        await deps.store.createApproval(approval, { ts: approval.createdAt, ...ctxBase, model: `${ctxBase.model}#${accessClass}`, ...zero, action: REQUESTED, verdict: "allowed", reason: null });
      } catch (error) {
        request.log.error({ err: error }, "Approval request creation failed");
        return reply.code(500).send(rpcError(id, -32603, "Approval request failed."));
      }
      let final: Approval;
      try {
        final = await deps.approvals.wait(approval.id, config.approvalTimeoutMs, closed.signal);
      } catch (error) {
        request.log.error({ err: error }, "Approval wait interrupted");
        return reply.code(500).send(rpcError(id, -32603, "Approval wait failed."));
      }
      if (final.status !== "approved") {
        const message = final.status === "rejected" ? "Action rejected by a human" : "Approval timeout exceeded";
        return reply.code(200).send(rpcError(id, -32002, message));
      }
      }
    }

    const headers: Record<string, string> = {
      ...server.headers,
      "content-type": "application/json",
      accept: header(request, "accept") ?? "application/json, text/event-stream",
      "user-agent": `Gardagent/mcp`,
    };
    for (const name of [SESSION, PROTOCOL]) {
      const v = header(request, name);
      if (v) headers[name] = v;
    }

    if (!gov.ledgerReady()) {
      return reply.code(503).send(rpcError(id, -32000, "The audit ledger is unavailable; request refused (fail closed)."));
    }
    const call = gov.startCall(reply);
    const record = async (reason: string | null, status: number | null, text: string) => {
      call.done();
      await gov.record({
        ...ctxBase,
        model: tool ? `${ctxBase.model}#${accessClass}` : ctxBase.model,
        verdict: "allowed",
        reason: observedReason ?? reason,
        upstreamStatus: status,
        promptTokens: 0,
        completionTokens: 0,
        cost: 0,
        responseHash: text ? sha256(text) : null,
      });
    };

    let upstream: Response;
    try {
      upstream = await deps.fetch(server.url, { method: "POST", headers, body: JSON.stringify(msg), signal: call.signal });
    } catch (error) {
      request.log.warn({ err: error }, "MCP server unreachable");
      await record("upstream_unreachable", null, "");
      return reply.code(502).send(rpcError(id, -32000, `MCP server "${serverName}" is unreachable.`));
    }

    const admittedAgent = agent;
    let responseReason: string | null = null;
    // Every upstream message is classified before any bytes reach the client.
    const screen = async (message: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      if (message.jsonrpc !== "2.0") {
        responseReason = "invalid_upstream_message";
        return null;
      }
      if (typeof message.method === "string") {
        const allowed = !Object.hasOwn(message, "id") && (MCP_SERVER_NOTIFICATIONS as readonly string[]).includes(message.method);
        if (!allowed) {
          await gov.record({ ...base, ...zero, action: `mcp.${message.method.slice(0, 100)}`,
            requestHash: sha256(canonicalJson(message.params ?? {})),
            verdict: config.mode === "observe" ? "allowed" : "denied",
            reason: `${config.mode === "observe" ? "observed:" : ""}server_request_refused` });
          if (config.mode !== "observe") return null;
        }
        return message;
      }
      if (message.id !== id || !("result" in message || "error" in message)) {
        responseReason = "invalid_upstream_message";
        return null;
      }
      if (msg.method === "initialize" && message.result && typeof message.result === "object") {
        const result = message.result as Record<string, unknown>;
        if (result.capabilities && typeof result.capabilities === "object") {
          const capabilities = result.capabilities as Record<string, unknown>;
          const filtered = Object.fromEntries(Object.entries(capabilities).filter(([name]) => name === "tools"));
          if (Object.keys(filtered).length !== Object.keys(capabilities).length) {
            if (config.mode === "observe") observedReason ??= "observed:method_not_governed";
            else return { ...message, result: { ...result, capabilities: filtered } };
          }
        }
      }
      if (msg.method === "tools/list" && message.result && typeof message.result === "object") {
        const result = message.result as Record<string, unknown>;
        if (Array.isArray(result.tools)) {
          const filtered = result.tools.filter((item: unknown) => item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).name === "string" && toolAllowed(admittedAgent, serverName, (item as { name: string }).name));
          if (filtered.length !== result.tools.length) {
            if (config.mode === "observe") observedReason ??= "observed:tool_not_allowed";
            else return { ...message, result: { ...result, tools: filtered } };
          }
        }
      }
      return message;
    };
    const screenEvent = async (event: string): Promise<string> => {
      const data = parseSseData(event);
      if (!data) { responseReason = "invalid_upstream_message"; return ""; }
      const screened = await screen(data);
      return !screened ? "" : screened === data ? event : `event: message\ndata: ${JSON.stringify(screened)}\n\n`;
    };
    const out: Record<string, string> = {};
    for (const name of [SESSION, PROTOCOL]) {
      const v = upstream.headers.get(name);
      if (v) out[name] = v;
    }
    const contentType = upstream.headers.get("content-type");
    const reason = upstream.ok ? null : "upstream_error";

    if (!(contentType ?? "").includes("text/event-stream") || !upstream.ok || !upstream.body) {
      const raw = await upstream.text();
      let text = raw;
      if (raw) {
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch { responseReason = "invalid_upstream_message"; }
        const screened = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? await screen(parsed as Record<string, unknown>) : null;
        if (!screened) responseReason ??= "invalid_upstream_message";
        text = JSON.stringify(screened ?? rpcError(id, -32603, "Invalid or refused upstream message."));
      }
      await record(responseReason ?? reason, upstream.status, notification ? "" : text);
      reply.code(upstream.status).headers(out);
      reply.header("content-type", "application/json");
      return notification ? reply.code(202).send() : reply.send(text);
    }

    if (notification) {
      await upstream.body.cancel();
      await record("unexpected_notification_stream", upstream.status, "");
      return reply.code(202).send();
    }
    return relayStream(reply, upstream, out, call, screenEvent, async (streamReason, forwarded) =>
      record(responseReason ?? streamReason, upstream.status, forwarded),
    );
  });

  /** Relayed SSE stream event by event; the ledger is written before closing the response. */
  async function relayStream(
    reply: FastifyReply,
    upstream: Response,
    extra: Record<string, string>,
    call: { aborted: () => boolean },
    screenEvent: (event: string) => Promise<string>,
    settle: (reason: string | null, forwarded: string) => Promise<void>,
  ) {
    reply.hijack();
    reply.raw.writeHead(upstream.status, {
      ...extra,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const splitter = new SseSplitter();
    const decoder = new TextDecoder();
    let forwarded = "";
    let reason: string | null = null;
    const forward = async (events: string[]) => {
      for (const event of events) {
        const safe = await screenEvent(event);
        forwarded += safe;
        reply.raw.write(safe);
      }
    };
    try {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        await forward(splitter.push(decoder.decode(chunk, { stream: true })));
      }
      await forward(splitter.push(decoder.decode()));
      const rest = splitter.flush();
      if (rest) {
        await forward([rest]);
      }
    } catch {
      reason = call.aborted() ? "client_aborted" : "stream_interrupted";
    } finally {
      try {
        await settle(reason, forwarded);
      } catch {
        // No durable proof: the stream is cut instead of being acknowledged as complete.
        reply.raw.destroy();
        return reply;
      }
      reply.raw.end();
    }
    return reply;
  }
}
