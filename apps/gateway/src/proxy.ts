import type { FastifyInstance } from "fastify";
import type { Store } from "@gardagent/core";
import type { GatewayConfig } from "./config.js";
import { openAiError } from "./errors.js";
import { AGENT_UNVERIFIABLE_CODE, AGENT_UNVERIFIABLE_MESSAGE, AgentUnverifiableError, bearer, createGovernance, type Usage } from "./shared.js";
import { parseSseData, SseSplitter } from "./sse.js";

const ACTION = "chat.completions";

interface ProxyDeps {
  config: GatewayConfig;
  store: Store;
  fetch: typeof fetch;
}

function readUsage(body: Record<string, unknown> | null): Usage | null {
  const usage = body?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  return {
    promptTokens: Number(usage.prompt_tokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? 0),
  };
}

export function registerProxy(app: FastifyInstance, deps: ProxyDeps): void {
  const { config } = deps;
  const gov = createGovernance(app, deps);

  app.post("/v1/chat/completions", async (request, reply) => {
    let agent;
    try {
      agent = await gov.authenticate(ACTION, bearer(request), request.ip);
    } catch (error) {
      if (!(error instanceof AgentUnverifiableError)) throw error;
      return reply.code(503).send(openAiError(AGENT_UNVERIFIABLE_MESSAGE, "gardagent_policy", AGENT_UNVERIFIABLE_CODE));
    }
    if (!agent) {
      return reply
        .code(401)
        .send(openAiError("Invalid or missing Gardagent agent key.", "invalid_request_error", "invalid_api_key"));
    }

    const body = request.body as Record<string, unknown> | null;
    const model = typeof body?.model === "string" ? body.model : null;
    if (!body || !model) {
      return reply
        .code(400)
        .send(openAiError("The « model » field is required.", "invalid_request_error", "missing_model"));
    }

    const { ctx, denial } = await gov.admit(ACTION, agent, model, body, reply);
    if (denial) {
      return reply.code(denial.status).send(openAiError(denial.message, "gardagent_policy", denial.reason));
    }

    const stream = body.stream === true;
    const upstreamBody: Record<string, unknown> = { ...body };
    // In streaming mode, ask the provider for a token count so we can bill the budget.
    const clientWantsUsage =
      (body.stream_options as Record<string, unknown> | undefined)?.include_usage === true;
    if (stream && !clientWantsUsage) {
      upstreamBody.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };
    }

    const call = gov.startCall(reply);

    let upstream: Response;
    try {
      upstream = await deps.fetch(`${config.upstreamBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          ...gov.upstreamHeaders(request, ctx),
          "content-type": "application/json",
          authorization: `Bearer ${config.upstreamApiKey}`,
        },
        body: JSON.stringify(upstreamBody),
        signal: call.signal,
      });
    } catch (error) {
      request.log.warn({ err: error }, "Provider unreachable");
      await gov.recordUnreachable(ctx, call);
      return reply
        .code(502)
        .send(openAiError("The model provider is unreachable.", "api_error", "upstream_unreachable"));
    }

    const isEventStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");

    if (!stream || !upstream.ok || !isEventStream || !upstream.body) {
      const text = await upstream.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      await gov.settle(ctx, call, readUsage(parsed), text, upstream.status, upstream.ok ? null : "upstream_error");
      reply.code(upstream.status).header("content-type", upstream.headers.get("content-type") ?? "application/json");
      return reply.send(text);
    }

    // Streaming: relay each event as soon as it is complete.
    reply.hijack();
    reply.raw.writeHead(upstream.status, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const splitter = new SseSplitter();
    const decoder = new TextDecoder();
    let forwarded = "";
    let usage: Usage | null = null;
    let reason: string | null = null;

    const forward = (events: string[]) => {
      for (const event of events) {
        const data = parseSseData(event);
        const eventUsage = readUsage(data);
        if (eventUsage) usage = eventUsage;
        // The usage chunk we asked for ourselves is not forwarded to the client.
        const injectedUsageChunk =
          !clientWantsUsage && eventUsage !== null && Array.isArray(data?.choices) && data.choices.length === 0;
        if (injectedUsageChunk) continue;
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
        await gov.settle(ctx, call, usage, forwarded, upstream.status, reason);
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
