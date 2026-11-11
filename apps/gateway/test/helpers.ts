import { MemoryStore } from "@gardagent/core";
import { buildApp } from "../src/app.js";
import { DEFAULT_PRICES, type GatewayConfig } from "../src/config.js";

export const config: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  mode: "enforce",
  upstreamBaseUrl: "http://upstream.test",
  upstreamApiKey: "sk-upstream-test",
  anthropicUpstreamBaseUrl: "http://anthropic-upstream.test",
  anthropicUpstreamApiKey: "sk-ant-upstream-test",
  forwardHeaders: ["x-opencode-session"],
  mcpServers: {},
  adminToken: "admin-test-token",
  databaseUrl: null,
  prices: DEFAULT_PRICES,
  fallbackPrice: { input: 10, output: 30 },
  upstreamTimeoutMs: 5000,
  defaultMaxOutputTokens: 1024,
  approvalTimeoutMs: 5000,
  approvalPollMs: 50,
};

export const adminHeaders = { authorization: `Bearer ${config.adminToken}` };

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

export type Responder = (call: FetchCall) => Response | Promise<Response>;

export function fakeFetch(responder: Responder) {
  const calls: FetchCall[] = [];
  const fn = (async (input: any, init?: any) => {
    const call: FetchCall = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** SSE response whose chunks are provided as-is (arbitrary splitting). */
export function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function setup(responder: Responder = () => jsonResponse({})) {
  const store = new MemoryStore();
  const f = fakeFetch(responder);
  const app = buildApp({ config, store, fetch: f.fetch });
  return { app, store, ...f };
}

export async function createAgent(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown> = { name: "bot", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 0, unlimited: true },
) {
  const res = await app.inject({ method: "POST", url: "/admin/agents", headers: adminHeaders, payload: body });
  if (res.statusCode !== 201) throw new Error(`agent creation: ${res.statusCode} ${res.body}`);
  return res.json() as { agent: { id: string }; key: string };
}

/** Yield to I/O until observable state is ready; the deadline only bounds failures. */
export async function waitUntil<T>(read: () => T | Promise<T>, ready: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (ready(value)) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (Date.now() < deadline);
  throw new Error("Observable test state was not reached before the deadline");
}

/** The ledger of a streaming request is written right after the stream closes. */
export async function waitForLedger(store: MemoryStore, count: number) {
  return waitUntil(() => proxyLedger(store), (rows) => rows.length >= count);
}

export async function nextPending(store: MemoryStore) {
  const rows = await waitUntil(() => store.listApprovals({ status: "pending" }), (rows) => rows.length > 0);
  return rows[0]!;
}

/** Same gateway with a modified configuration (e.g. forwarded header list). */
export function setupWith(overrides: Partial<GatewayConfig>, responder: Responder = () => jsonResponse({})) {
  const store = new MemoryStore();
  const f = fakeFetch(responder);
  const app = buildApp({ config: { ...config, ...overrides }, store, fetch: f.fetch });
  return { app, store, ...f };
}

/** Ledger rows coming from model calls: excluding admin actions ("admin.*"). */
export async function proxyLedger(store: MemoryStore) {
  return (await store.listLedger()).filter((e) => !e.action.startsWith("admin."));
}
