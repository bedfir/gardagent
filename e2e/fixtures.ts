import { test as base, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../packages/core/dist/index.js";
import { buildApp } from "../apps/gateway/dist/app.js";
import type { GatewayConfig } from "../apps/gateway/dist/config.js";
import { fixtureShutdown } from "./gateway-lifecycle";

export const ADMIN_TOKEN = "fake-e2e-admin-token-for-browser-tests";

export const test = base.extend<{
  gateway: { url: string; forwarded: string[] };
}>({
  gateway: async ({}, use) => {
    const forwarded: string[] = [];
    const config: GatewayConfig = {
      port: 0, host: "127.0.0.1", mode: "enforce",
      upstreamBaseUrl: "http://unused.invalid", upstreamApiKey: "fake-upstream-key",
      anthropicUpstreamBaseUrl: "http://unused.invalid", anthropicUpstreamApiKey: "fake-anthropic-key",
      forwardHeaders: [], mcpServers: { local: { url: "http://unused.invalid/mcp", headers: {} } },
      adminToken: ADMIN_TOKEN, databaseUrl: null, prices: {},
      fallbackPrice: { input: 1, output: 1 }, upstreamTimeoutMs: 1000,
      defaultMaxOutputTokens: 100, approvalTimeoutMs: 25_000, approvalPollMs: 20,
    };
    const app = buildApp({
      config, store: new MemoryStore(),
      consoleDir: fileURLToPath(new URL("../apps/console/dist/", import.meta.url)),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.model) {
          return new Response(JSON.stringify({ id: "fake-completion", object: "chat.completion",
            model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100_000, completion_tokens: 100_000, total_tokens: 200_000 } }),
          { headers: { "content-type": "application/json" } });
        }
        forwarded.push(body.params.name);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: "local fixture result" }] } }),
        { headers: { "content-type": "application/json" } });
      },
    });
    const shutdown = fixtureShutdown(app.server, () => app.close());
    try {
      const url = await app.listen({ host: "127.0.0.1", port: 0 });
      await use({ url, forwarded });
    } finally {
      await shutdown();
    }
  },
});

export { expect };
export const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}` };
