import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseForwardHeaders } from "../src/config.js";
import { USER_AGENT } from "../src/shared.js";
import { createAgent, jsonResponse, setupWith, type FetchCall } from "./helpers.js";

const openai = { id: "c1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const anthropic = { id: "m1", type: "message", content: [], usage: { input_tokens: 1, output_tokens: 1 } };
const body = { model: "gpt-4o-mini", max_tokens: 8, messages: [{ role: "user", content: "x" }] };

type Ctx = ReturnType<typeof setupWith>;

// Both endpoints share the same logic: each case is run on both.
const endpoints = [
  {
    name: "chat/completions",
    send: (app: Ctx["app"], key: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${key}`, ...headers },
        payload: body,
      }),
    reply: openai,
  },
  {
    name: "messages",
    send: (app: Ctx["app"], key: string, headers: Record<string, string> = {}) =>
      app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": key, ...headers }, payload: body }),
    reply: anthropic,
  },
];

describe.each(endpoints)("headers to the provider: $name", ({ send, reply }) => {
  const make = (overrides: Parameters<typeof setupWith>[0] = {}) => setupWith(overrides, () => jsonResponse(reply));
  const last = (calls: FetchCall[]) => calls.at(-1)!.headers;

  it("relays x-opencode-session when the client provides it", async () => {
    const { app, calls } = make();
    const { key } = await createAgent(app);
    await send(app, key, { "x-opencode-session": "ma-session" });
    expect(last(calls)["x-opencode-session"]).toBe("ma-session");
  });

  it("generates a stable session per agent and per day, different between two agents", async () => {
    const { app, calls } = make();
    const a = await createAgent(app, { name: "a", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true });
    const b = await createAgent(app, { name: "b", allowedModels: ["*"], dailyBudgetUsd: 0, unlimited: true });
    await send(app, a.key);
    await send(app, a.key);
    await send(app, b.key);
    const [a1, a2, b1] = calls.map((c) => c.headers["x-opencode-session"]);
    expect(a1).toBe(`gardagent-${a.agent.id}-${new Date().toISOString().slice(0, 10)}`);
    expect(a2).toBe(a1);
    expect(b1).toContain(b.agent.id);
    expect(b1).not.toBe(a1);
  });

  it("always sends the gateway User-Agent, never the client's", async () => {
    const { app, calls } = make();
    const { key } = await createAgent(app);
    await send(app, key, { "user-agent": "agent-du-client/9" });
    expect(last(calls)["user-agent"]).toBe(USER_AGENT);
    const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string }).version;
    expect(USER_AGENT).toBe(`Gardagent/${version}`);
  });

  it("never relays forbidden headers, even if listed", async () => {
    const forbidden = ["authorization", "x-api-key", "cookie", "host", "content-length", "connection", "transfer-encoding", "user-agent"];
    const { app, calls } = make({ forwardHeaders: [...forbidden, "x-extra"] });
    const { key } = await createAgent(app);
    await send(app, key, { cookie: "s=1", "x-extra": "oui", connection: "keep-alive", "user-agent": "client" });
    const headers = last(calls);
    expect(headers["x-extra"]).toBe("oui");
    expect(headers.cookie).toBeUndefined();
    expect(headers["transfer-encoding"]).toBeUndefined();
    expect(headers["user-agent"]).toBe(USER_AGENT);
    // Authentication to the provider is the gateway's, never the client's.
    expect([undefined, "Bearer sk-upstream-test"]).toContain(headers.authorization);
    expect(headers["x-api-key"] ?? "sk-ant-upstream-test").toBe("sk-ant-upstream-test");
    expect(JSON.stringify(headers)).not.toContain(key);
    expect(headers.host).toBeUndefined();
  });

  it("relays other headers from the list, ignoring the client's case", async () => {
    const { app, calls } = make({ forwardHeaders: ["x-opencode-session", "x-trace-id"] });
    const { key } = await createAgent(app);
    await send(app, key, { "X-Trace-Id": "t-1" });
    expect(last(calls)["x-trace-id"]).toBe("t-1");
  });

  it("empty list: no header relayed or generated", async () => {
    const { app, calls } = make({ forwardHeaders: [] });
    const { key } = await createAgent(app);
    await send(app, key, { "x-opencode-session": "ignored", "x-trace-id": "t" });
    const headers = last(calls);
    expect(headers["x-opencode-session"]).toBeUndefined();
    expect(headers["x-trace-id"]).toBeUndefined();
    expect(headers["user-agent"]).toBe(USER_AGENT);
  });

  it("session absent from the list: nothing is generated", async () => {
    const { app, calls } = make({ forwardHeaders: ["x-trace-id"] });
    const { key } = await createAgent(app);
    await send(app, key);
    expect(last(calls)["x-opencode-session"]).toBeUndefined();
  });
});

describe("UPSTREAM_FORWARD_HEADERS", () => {
  it("defaults to x-opencode-session", () => {
    expect(parseForwardHeaders(undefined)).toEqual(["x-opencode-session"]);
  });
  it("is case and space insensitive, without duplicates", () => {
    expect(parseForwardHeaders(" X-OpenCode-Session , X-Trace-ID,x-trace-id ")).toEqual(["x-opencode-session", "x-trace-id"]);
  });
  it("empty string = empty list", () => {
    expect(parseForwardHeaders("")).toEqual([]);
  });
});
