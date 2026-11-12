import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { policyRevision, canonicalJson, sha256, summarizeArgs, toolAllowed, toolMatches, toolNameMatches, type Approval, type Store, type ToolAccessClass } from "@gardagent/core";
import { REQUESTED, type ApprovalHub } from "./approvals.js";
import type { GatewayConfig } from "./config.js";
import { AGENT_UNVERIFIABLE_CODE, AGENT_UNVERIFIABLE_MESSAGE, AgentUnverifiableError, bearer, createGovernance } from "./shared.js";
import { SseSplitter } from "./sse.js";

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

/** MCP proxy (Streamable HTTP transport): only tools/call is governed and logged. */
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const { config } = deps;
  const gov = createGovernance(app, deps);

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

    // Only the tools/call method is governed; the rest passes untraced in the ledger.
    let tool: string | null = null;
    let ctxBase: { agentId: string; action: string; model: string; requestHash: string; policyRev: string; approvalRef?: string } | null = null;
    let toolArgs: unknown;
    let observedReason: string | null = null;
    let accessClass: ToolAccessClass = "write";
    if (msg.method === "tools/call") {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string" || !params.name) {
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
          observedReason = "observed:tool_not_allowed";
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
        observedReason = "observed:approval_required";
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
      if (!ctxBase) return;
      await gov.record({
        ...ctxBase,
        model: `${ctxBase.model}#${accessClass}`,
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

    const out: Record<string, string> = {};
    for (const name of [SESSION, PROTOCOL]) {
      const v = upstream.headers.get(name);
      if (v) out[name] = v;
    }
    const contentType = upstream.headers.get("content-type");
    const reason = upstream.ok ? null : "upstream_error";

    if (!(contentType ?? "").includes("text/event-stream") || !upstream.ok || !upstream.body) {
      const text = await upstream.text();
      await record(reason, upstream.status, text);
      reply.code(upstream.status).headers(out);
      if (contentType) reply.header("content-type", contentType);
      return reply.send(text);
    }

    return relayStream(reply, upstream, out, call, async (streamReason, forwarded) =>
      record(streamReason, upstream.status, forwarded),
    );
  });

  /** Relayed SSE stream event by event; the ledger is written before closing the response. */
  async function relayStream(
    reply: FastifyReply,
    upstream: Response,
    extra: Record<string, string>,
    call: { aborted: () => boolean },
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
    const forward = (events: string[]) => {
      for (const event of events) {
        forwarded += event;
        reply.raw.write(event);
      }
    };
    try {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        forward(splitter.push(decoder.decode(chunk, { stream: true })));
      }
      forward(splitter.push(decoder.decode()));
      const rest = splitter.flush();
      if (rest) {
        forwarded += rest;
        reply.raw.write(rest);
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
