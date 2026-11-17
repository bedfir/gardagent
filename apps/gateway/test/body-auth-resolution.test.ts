import { request as httpRequest } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { DbTimeoutError, ledgerGuardFor } from "../src/ledger-guard.js";
import { guardOptions } from "../src/config.js";
import { createGovernance } from "../src/shared.js";
import { buildApp } from "../src/app.js";
import { UNAUTHENTICATED_BODY_LIMIT } from "../src/auth-limiter.js";
import { adminHeaders, config, createAgent, proxyLedger, setupWith, waitUntil } from "./helpers.js";

const unknown = "ga_" + "u".repeat(40);
const chat = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] };
const apps: ReturnType<typeof setupWith>["app"][] = [];
function setup() {
  const result = setupWith({ authFailLimit: 0, mcpServers: { test: { url: "http://mcp.test", headers: {}, readTools: [] } } });
  apps.push(result.app);
  return result;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe("resolve agent identity before parsing large bodies", () => {
  for (const chunked of [false, true]) {
    for (const disabled of [false, true]) {
      it(`${disabled ? "disabled" : "unknown"} key caps ${chunked ? "chunked" : "declared"} bodies`, async () => {
        const { app, store, calls } = setup();
        let key = unknown;
        if (disabled) {
          const created = await createAgent(app);
          key = created.key;
          expect((await app.inject({ method: "PATCH", url: `/admin/agents/${created.agent.id}`, headers: adminHeaders, payload: { active: false } })).statusCode).toBe(200);
        }
        const lookup = vi.spyOn(store, "findAgentByKeyHash");
        const body = JSON.stringify({ ...chat, padding: "x".repeat(1024 * 1024) });
        const chunks = function* () {
          for (let i = 0; i < body.length; i += 4096) yield Buffer.from(body.slice(i, i + 4096));
        };
        const response = await app.inject({
          method: "POST", url: "/v1/chat/completions",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(chunked ? { "transfer-encoding": "chunked" } : { "content-length": String(Buffer.byteLength(body)) }) },
          payload: Readable.from(chunks()),
        });
        expect(response.statusCode).toBe(413);
        expect(response.json().error.message).toBe(`Request body too large (limit ${UNAUTHENTICATED_BODY_LIMIT} bytes without a valid agent key).`);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(0);
      });
    }
  }

  for (const chunked of [false, true]) {
    it(`propagates a fail-closed lookup timeout for a large ${chunked ? "chunked" : "declared"} body`, async () => {
      // A small declared request exercises the unchanged handler lookup path on main.
      const run = async (large: boolean) => {
        const { app, store, calls } = setup();
        const error = new DbTimeoutError(10);
        const lookup = vi.spyOn(store, "findAgentByKeyHash").mockRejectedValue(error);
        const observed: Error[] = [];
        app.addHook("onError", async (_request, _reply, err) => { observed.push(err); });
        const body = JSON.stringify(large ? { ...chat, padding: "x".repeat(128 * 1024) } : chat);
        const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: {
          authorization: `Bearer ${unknown}`, "content-type": "application/json",
          ...(large && chunked ? { "transfer-encoding": "chunked" } : { "content-length": String(body.length) }),
        }, payload: Readable.from([body]) });
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(observed).toEqual([error]);
        expect(calls).toHaveLength(0);
        return response;
      };
      const baseline = await run(false);
      const response = await run(true);
      expect(baseline.statusCode).toBe(503);
      expect(response.statusCode).toBe(baseline.statusCode);
      expect(response.json()).toEqual(baseline.json());
    });
  }

  it("propagates an unexpected store error unchanged from the gate", async () => {
    const { app, store } = setup();
    const error = new Error("lookup failed");
    const lookup = vi.spyOn(store, "findAgentByKeyHash").mockRejectedValue(error);
    const observed: Error[] = [];
    app.addHook("onError", async (_request, _reply, err) => { observed.push(err); });
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${unknown}` }, payload: { padding: "x".repeat(128 * 1024) } });
    expect(response.statusCode).toBe(500);
    expect(observed).toEqual([error]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("marks accounting before a failed invalid_key audit and does not count again on handler processing", async () => {
    const { app, store } = setup();
    const error = new Error("audit failed");
    const append = vi.spyOn(ledgerGuardFor(store, app.log, guardOptions(config)), "append").mockRejectedValueOnce(error);
    const failures = vi.spyOn(app.agentAuthLimiter, "recordFailure");
    let captured: FastifyRequest | undefined;
    const observed: Error[] = [];
    app.addHook("onError", async (request, _reply, err) => { captured = request; observed.push(err); });
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: {
      authorization: `Bearer ${unknown}`, "content-type": "application/json", "transfer-encoding": "chunked",
    }, payload: Readable.from([JSON.stringify(chat)]) });
    expect(response.statusCode).toBe(500);
    expect(observed).toEqual([error]);
    expect(captured?.agentAuthFailureRecorded).toBe(true);
    expect(failures).toHaveBeenCalledTimes(1);
    // Explicitly exercise the handler authentication entry with the same request after failure.
    const auth = createGovernance(app, { config, store });
    expect(await auth.authenticateRequest(captured!)).toBeNull();
    expect(failures).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("allows an active agent to send 5 MiB", async () => {
    const { app, store } = setup();
    const { key } = await createAgent(app);
    const lookup = vi.spyOn(store, "findAgentByKeyHash");
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: { ...chat, padding: "x".repeat(5 * 1024 * 1024) } });
    expect(response.statusCode).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  for (const url of ["/v1/chat/completions", "/v1/messages", "/mcp/test"]) {
    it(`looks up small bodies once and large bodies twice for ${url}`, async () => {
      const { app, store } = setup();
      const lookup = vi.spyOn(store, "findAgentByKeyHash");
      app.addHook("preParsing", async (request, _reply, payload) => {
        if (request.url === url) {
          expect(lookup).toHaveBeenCalledTimes(Number(request.headers["content-length"]) > UNAUTHENTICATED_BODY_LIMIT ? 1 : 0);
        }
        return payload;
      });
      const { key } = await createAgent(app);
      lookup.mockClear();
      const response = await app.inject({ method: "POST", url, headers: url === "/v1/messages" ? { "x-api-key": key } : { authorization: `Bearer ${key}` }, payload: url.startsWith("/mcp/") ? { jsonrpc: "2.0", id: 1, method: "ping" } : chat });
      expect(response.statusCode).toBe(200);
      expect(lookup).toHaveBeenCalledTimes(1);
      lookup.mockClear();
      const large = await app.inject({ method: "POST", url,
        headers: url === "/v1/messages" ? { "x-api-key": key } : { authorization: `Bearer ${key}` },
        payload: { ...(url.startsWith("/mcp/") ? { jsonrpc: "2.0", id: 1, method: "ping" } : chat), padding: "x".repeat(128 * 1024) },
      });
      expect(large.statusCode).toBe(200);
      expect(lookup).toHaveBeenCalledTimes(2);
    });
  }

  for (const url of ["/v1/chat/completions", "/v1/messages", "/mcp/test"]) {
    it(`uses the endpoint's selected credential for the body cap on ${url}`, async () => {
      const { app, calls } = setup();
      const { key } = await createAgent(app);
      // A valid secondary credential must not lift the cap for an invalid primary credential.
      const headers = url === "/v1/messages"
        ? { "x-api-key": unknown, authorization: `Bearer ${key}` }
        : { "x-api-key": key, authorization: `Bearer ${unknown}` };
      const response = await app.inject({ method: "POST", url, headers, payload: { padding: "x".repeat(1024 * 1024) } });
      expect(response.statusCode).toBe(413);
      expect(calls).toHaveLength(0);
    });
  }

  it("rate limits a blocked address before lookup or body parsing", async () => {
    const { app, store } = setupWith({ authFailLimit: 1 });
    apps.push(app);
    const headers = { authorization: `Bearer ${unknown}` };
    expect((await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: chat })).statusCode).toBe(401);
    const lookup = vi.spyOn(store, "findAgentByKeyHash");
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { padding: "x".repeat(1024 * 1024) } });
    expect(response.statusCode).toBe(429);
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("records each unknown-key attempt only once, including aggregated failures", async () => {
    const { app, store } = setup();
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${unknown}` }, payload: chat });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { message: "Invalid or missing Gardagent agent key.", type: "invalid_request_error", code: "invalid_api_key" } });
    }
    expect((await proxyLedger(store)).map((row) => row.reason)).toEqual(["invalid_key"]);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    expect((await proxyLedger(store)).map((row) => row.reason)).toEqual(["invalid_key", "invalid_key_repeated:2"]);
  });
  for (const mutation of ["disable", "rotate-key"]) {
    it(`refuses a key after ${mutation} during a paused upload`, async () => {
      const { app, store, calls } = setup();
      const { key, agent } = await createAgent(app);
      const lookup = vi.spyOn(store, "findAgentByKeyHash");
      const source = new PassThrough();
      const pending = app.inject({ method: "POST", url: "/v1/chat/completions", headers: {
        authorization: `Bearer ${key}`, "content-type": "application/json", "transfer-encoding": "chunked",
      }, payload: source }).then((response) => response);
      source.write('{"model":"gpt-4o-mini","padding":"');
      await waitUntil(() => lookup.mock.calls.length, (n) => n === 1);
      const changed = await app.inject(mutation === "disable"
        ? { method: "PATCH", url: `/admin/agents/${agent.id}`, headers: adminHeaders, payload: { active: false } }
        : { method: "POST", url: `/admin/agents/${agent.id}/rotate-key`, headers: adminHeaders });
      expect(changed.statusCode).toBe(200);
      source.end("x".repeat(128 * 1024) + '"}');
      const response = await pending;
      expect(response.statusCode).toBe(mutation === "disable" ? 403 : 401);
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(calls).toHaveLength(0);
    });
  }

  for (const method of ["GET", "DELETE"] as const) {
    it(`${method} MCP preserves method rejection without authentication`, async () => {
      const { app, store } = setup();
      const lookup = vi.spyOn(store, "findAgentByKeyHash");
      const failures = vi.spyOn(app.agentAuthLimiter, "recordFailure");
      const response = await app.inject({ method, url: "/mcp/test", headers: { authorization: `Bearer ${unknown}` } });
      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
      expect(lookup).not.toHaveBeenCalled();
      expect(failures).not.toHaveBeenCalled();
    });
  }

  it("responds before a slow HTTP producer finishes and bounds source reads", async () => {
    const { app } = setup();
    let read = 0;
    app.addHook("onRequest", async (request) => {
      const push = request.raw.push.bind(request.raw);
      vi.spyOn(request.raw, "push").mockImplementation((chunk, encoding) => {
        if (Buffer.isBuffer(chunk)) read += chunk.length;
        return push(chunk, encoding);
      });
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    let status: number | undefined;
    let responded = false;
    let failed = false;
    const client = httpRequest(address + "/v1/chat/completions", { method: "POST", headers: {
      authorization: `Bearer ${unknown}`, "content-type": "application/json",
    } }, (res) => {
      status = res.statusCode;
      responded = true;
      res.resume();
    });
    client.on("error", () => { failed = true; });
    try {
      const deadline = Date.now() + 3000;
      while (!responded && !failed && Date.now() < deadline) {
        client.write(Buffer.alloc(4096, 32));
        await pause(5);
      }
      expect(responded).toBe(true);
      expect(status).toBe(413);
      // Continue offering up to 1 MiB AFTER the response. A draining server must fail this test.
      let stopped = false;
      for (let i = 0; i < 64 && Date.now() < deadline; i++) {
        const accepted = client.write(Buffer.alloc(16 * 1024, 32));
        await pause(5);
        if (failed || client.destroyed || client.socket?.destroyed) { stopped = true; break; }
        if (!accepted) {
          await pause(150);
          if (failed || client.destroyed || client.writableNeedDrain) { stopped = true; break; }
        }
      }
      expect(stopped).toBe(true);
      // Count IncomingMessage.push, before the limiter; allow one 64 KiB transport read,
      // including the chunk that crosses the cap. Client cancellation happens only below.
      expect(read).toBeLessThanOrEqual(UNAUTHENTICATED_BODY_LIMIT + 64 * 1024);
    } finally {
      client.destroy();
    }
  });

  for (const url of ["/v1/messages", "/mcp/test"]) {
    it(`preserves main's small unknown-key response on ${url}`, async () => {
      const { app } = setup();
      const failures = vi.spyOn(app.agentAuthLimiter, "recordFailure");
      const expected = url === "/v1/messages"
        ? { type: "error", error: { type: "authentication_error", message: "Invalid or missing Gardagent agent key." } }
        : { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Invalid or missing Gardagent agent key." } };
      for (const chunked of [false, true]) {
        const response = await app.inject({ method: "POST", url, headers: {
          authorization: `Bearer ${unknown}`, "content-type": "application/json",
          ...(chunked ? { "transfer-encoding": "chunked" } : {}),
        }, payload: chunked ? Readable.from([JSON.stringify(chat)]) : chat });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual(expected);
        expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(response.headers["www-authenticate"]).toBeUndefined();
        expect(response.headers["retry-after"]).toBeUndefined();
      }
      expect(failures).toHaveBeenCalledTimes(2);
    });
  }

  it("counts mixed oversize and small failures once across addresses and windows", async () => {
    const { store } = setup();
    let now = 0;
    const timed = buildApp({ config: { ...config, authFailLimit: 0, authFailWindowMs: 1000 }, store, clock: () => now });
    apps.push(timed);
    const failures = vi.spyOn(timed.agentAuthLimiter, "recordFailure");
    for (const address of ["127.0.0.1", "127.0.0.2", "127.0.0.1"]) {
      for (const kind of ["declared", "chunked", "small"]) {
        const body = JSON.stringify(kind === "small" ? chat : { padding: "x".repeat(128 * 1024) });
        const response = await timed.inject({ method: "POST", url: "/v1/chat/completions", remoteAddress: address,
          headers: { authorization: `Bearer ${unknown}`, "content-type": "application/json",
            ...(kind === "chunked" ? { "transfer-encoding": "chunked" } : { "content-length": String(body.length) }) },
          payload: Readable.from([body]),
        });
        expect(response.statusCode).toBe(kind === "small" ? 401 : 413);
      }
      if (address === "127.0.0.2") now += 1001;
    }
    expect(failures).toHaveBeenCalledTimes(9);
    await timed.close();
    apps.splice(apps.indexOf(timed), 1);
    const reasons = (await proxyLedger(store)).map((row) => row.reason);
    expect(reasons.filter((r) => r === "invalid_key")).toHaveLength(3);
    expect(reasons.filter((r) => r === "invalid_key_repeated:2")).toHaveLength(3);
  });

});
