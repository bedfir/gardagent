import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Store } from "@gardagent/core";
import type { GatewayConfig } from "./config.js";
import { anthropicError } from "./errors.js";
import { AGENT_UNVERIFIABLE_CODE, AGENT_UNVERIFIABLE_MESSAGE, AgentUnverifiableError, bearer, createGovernance, type Usage } from "./shared.js";
import { parseSseData, SseSplitter } from "./sse.js";

const ACTION = "messages";
const DEFAULT_VERSION = "2023-06-01";

interface AnthropicDeps {
  config: GatewayConfig;
  store: Store;
  fetch: typeof fetch;
}

/** Tokens seen in an Anthropic response; each field is updated only when present. */
class UsageTracker {
  private input = 0;
  private cacheCreation = 0;
  private cacheRead = 0;
  private output = 0;
  private seen = false;

  update(usage: unknown): void {
    if (!usage || typeof usage !== "object") return;
    const u = usage as Record<string, unknown>;
    const take = (value: unknown, apply: (n: number) => void) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        apply(value);
        this.seen = true;
      }
    };
    take(u.input_tokens, (n) => (this.input = n));
    take(u.cache_creation_input_tokens, (n) => (this.cacheCreation = n));
    take(u.cache_read_input_tokens, (n) => (this.cacheRead = n));
    // output_tokens in message_delta is cumulative: the last value replaces the previous one.
    take(u.output_tokens, (n) => (this.output = n));
  }

  result(): Usage | null {
    if (!this.seen) return null;
    return { promptTokens: this.input + this.cacheCreation + this.cacheRead, completionTokens: this.output };
  }
}

function agentKey(request: FastifyRequest): string | null {
  const header = request.headers["x-api-key"];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim() || bearer(request);
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value) || undefined;
}

export function registerAnthropic(app: FastifyInstance, deps: AnthropicDeps): void {
  const { config } = deps;
  const gov = createGovernance(app, deps);

  app.post("/v1/messages", async (request, reply) => {
    let agent;
    try {
      agent = await gov.authenticate(ACTION, agentKey(request), request.ip);
    } catch (error) {
      if (!(error instanceof AgentUnverifiableError)) throw error;
      return reply.code(503).send(anthropicError("api_error", AGENT_UNVERIFIABLE_MESSAGE, AGENT_UNVERIFIABLE_CODE));
    }
    if (!agent) {
      return reply.code(401).send(anthropicError("authentication_error", "Invalid or missing Gardagent agent key."));
    }

    const body = request.body as Record<string, unknown> | null;
    const model = typeof body?.model === "string" ? body.model : null;
    if (!body || !model) {
      return reply.code(400).send(anthropicError("invalid_request_error", "The « model » field is required."));
    }

    const { ctx, denial } = await gov.admit(ACTION, agent, model, body);
    if (denial) {
      const type = denial.status === 429 ? "rate_limit_error" : "permission_error";
      return reply.code(denial.status).send(anthropicError(type, denial.message));
    }

    const stream = body.stream === true;
    const headers: Record<string, string> = {
      ...gov.upstreamHeaders(request, ctx),
      "content-type": "application/json",
      // The real provider key; the agent key is never forwarded.
      "x-api-key": config.anthropicUpstreamApiKey,
      "anthropic-version": headerValue(request, "anthropic-version") ?? DEFAULT_VERSION,
    };
    const beta = headerValue(request, "anthropic-beta");
    if (beta) headers["anthropic-beta"] = beta;

    const call = gov.startCall(reply);

    let upstream: Response;
    try {
      upstream = await deps.fetch(`${config.anthropicUpstreamBaseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: call.signal,
      });
    } catch (error) {
      request.log.warn({ err: error }, "Provider unreachable");
      await gov.recordUnreachable(ctx, call);
      return reply.code(502).send(anthropicError("api_error", "The model provider is unreachable."));
    }

    const isEventStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");

    if (!stream || !upstream.ok || !isEventStream || !upstream.body) {
      const text = await upstream.text();
      const tracker = new UsageTracker();
      try {
        tracker.update((JSON.parse(text) as { usage?: unknown } | null)?.usage);
      } catch {
        // non-JSON body: nothing to count
      }
      await gov.settle(ctx, call, tracker.result(), text, upstream.status, upstream.ok ? null : "upstream_error");
      reply.code(upstream.status).header("content-type", upstream.headers.get("content-type") ?? "application/json");
      return reply.send(text);
    }

    // Streaming: each event is relayed as-is as soon as it is complete.
    reply.hijack();
    reply.raw.writeHead(upstream.status, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const splitter = new SseSplitter();
    const decoder = new TextDecoder();
    const tracker = new UsageTracker();
    let forwarded = "";
    let reason: string | null = null;

    const forward = (events: string[]) => {
      for (const event of events) {
        const data = parseSseData(event);
        if (data?.type === "message_start") tracker.update((data.message as { usage?: unknown } | undefined)?.usage);
        else if (data?.type === "message_delta") tracker.update(data.usage);
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
    } catch (error) {
      reason = call.aborted() ? "client_aborted" : "stream_interrupted";
      request.log.warn({ err: error }, "Stream interrupted");
    } finally {
      // The ledger is written before closing the response: no action can finish without a trace.
      try {
        await gov.settle(ctx, call, tracker.result(), forwarded, upstream.status, reason);
      } catch (error) {
        // No durable proof: the stream is cut instead of being acknowledged as complete.
        request.log.error({ err: error }, "Ledger entry could not be kept: stream aborted");
        reply.raw.destroy();
        return reply;
      }
      reply.raw.end();
    }
    return reply;
  });
}
