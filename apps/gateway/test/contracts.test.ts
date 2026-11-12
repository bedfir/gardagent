import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { GENESIS_HASH, verifyChain, type LedgerEntry } from "@gardagent/core";
import { adminHeaders, jsonResponse, nextPending, setupWith, type FetchCall } from "./helpers.js";

/**
 * Contract tests: the golden fixtures in test/fixtures/contracts/ are produced by the real code paths (this file
 * generates them) and committed. They are only ever added to. See docs/compatibility.md and docs/ledger-format.md.
 *
 * Generation: GARDAGENT_UPDATE_FIXTURES=1 rewrites all five files. The only other case that writes them is the very
 * first run, when none of the five exists (the implementer cannot run node, so the runner's first gate run creates
 * the baseline and the runner commits it). If only some are missing the run fails: that is a deleted fixture.
 * A reviewer must reject a change that deletes or regenerates them without a documented format change.
 */
const DIR = fileURLToPath(new URL("../../../test/fixtures/contracts/", import.meta.url));
const FILES = {
  ledger: "ledger-v1.json",
  openai: "model-openai.json",
  anthropic: "model-anthropic.json",
  mcp: "mcp.json",
  admin: "admin-api.json",
} as const;

interface Sample {
  method: string;
  route: string;
  request: unknown;
  status: number;
  response: unknown;
}
type Samples = Record<string, Sample>;

interface Generated {
  ledger: { formatVersion: 1; head: string; entries: LedgerEntry[] };
  openai: Samples;
  anthropic: Samples;
  mcp: Samples;
  admin: Samples;
}

const KEY_PLACEHOLDER = `ga_${"x".repeat(32)}`;

/** Agent keys returned by the gateway are random test values; the fixtures keep only the format. */
function redact(value: unknown): unknown {
  if (typeof value === "string") return /^ga_[A-Za-z0-9_-]{20,}$/.test(value) ? KEY_PLACEHOLDER : value;
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

const completion = {
  id: "chatcmpl-contract",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
};
const message = {
  id: "msg_contract",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
  model: "claude-contract",
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 50 },
};
const mcpResult = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } };
const rpc = (method: string, params: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, params });

function responder(call: FetchCall): Response {
  if (call.url.endsWith("/v1/chat/completions")) return jsonResponse(completion);
  if (call.url.endsWith("/v1/messages")) return jsonResponse(message);
  return jsonResponse(mcpResult);
}

/** Runs the gateway on an in-memory store through the real routes and collects entries and samples. */
async function generate(): Promise<Generated> {
  const { app, store } = setupWith(
    { mcpServers: { gh: { url: "https://mcp.test/gh", headers: {}, readTools: ["search"] } } },
    responder,
  );
  const out: Omit<Generated, "ledger"> = { openai: {}, anthropic: {}, mcp: {}, admin: {} };

  async function call(
    bucket: Samples,
    name: string,
    method: "GET" | "POST" | "PATCH",
    route: string,
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) {
    const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    bucket[name] = { method, route, request: payload ?? null, status: res.statusCode, response: redact(res.json()) };
    return res;
  }
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

  // Admin API: agents.
  const created = await call(out.admin, "createAgent", "POST", "/admin/agents", "/admin/agents", adminHeaders, {
    name: "contract-bot",
    allowedModels: ["gpt-4o-mini", "claude-contract"],
    allowedTools: ["gh/*"],
    approvalTools: ["gh/search"],
    dailyBudgetUsd: 5,
  });
  const { agent, key } = created.json() as { agent: { id: string }; key: string };
  const limited = (
    await call(out.admin, "createAgentUnlimited", "POST", "/admin/agents", "/admin/agents", adminHeaders, {
      name: "contract-limited",
      allowedModels: ["gpt-4o-mini"],
      allowedTools: ["gh/search"],
      dailyBudgetUsd: 0,
      unlimited: true,
    })
  ).json() as { key: string };
  const tiny = (
    await call(out.admin, "createAgentTinyBudget", "POST", "/admin/agents", "/admin/agents", adminHeaders, {
      name: "contract-tiny",
      allowedModels: ["gpt-4o-mini"],
      dailyBudgetUsd: 0.000001,
    })
  ).json() as { key: string };
  await call(out.admin, "createAgentRejected", "POST", "/admin/agents", "/admin/agents", adminHeaders, { name: "" });
  await call(out.admin, "unauthorized", "GET", "/admin/agents", "/admin/agents", {});

  // OpenAI-format endpoint.
  const chat = (model: string) => ({ model, messages: [{ role: "user", content: "hello" }] });
  const chatUrl = "/v1/chat/completions";
  await call(out.openai, "allowed", "POST", chatUrl, chatUrl, bearer(key), chat("gpt-4o-mini"));
  await call(out.openai, "invalidKey", "POST", chatUrl, chatUrl, bearer("ga_this-key-does-not-exist-at-all"), chat("gpt-4o-mini"));
  await call(out.openai, "missingModel", "POST", chatUrl, chatUrl, bearer(key), { messages: [] });
  await call(out.openai, "modelNotAllowed", "POST", chatUrl, chatUrl, bearer(limited.key), chat("gpt-4o"));
  await call(out.openai, "budgetExceeded", "POST", chatUrl, chatUrl, bearer(tiny.key), chat("gpt-4o-mini"));

  // Anthropic-format endpoint.
  const messagesUrl = "/v1/messages";
  const claude = { model: "claude-contract", max_tokens: 64, messages: [{ role: "user", content: "hello" }] };
  await call(out.anthropic, "allowed", "POST", messagesUrl, messagesUrl, { "x-api-key": key }, claude);
  await call(out.anthropic, "invalidKey", "POST", messagesUrl, messagesUrl, { "x-api-key": "ga_this-key-does-not-exist-at-all" }, claude);
  await call(out.anthropic, "modelNotAllowed", "POST", messagesUrl, messagesUrl, { "x-api-key": limited.key }, claude);

  // MCP: a read tool that needs approval, a refused tool, and the approval decision.
  const mcpUrl = "/mcp/gh";
  const pending = call(out.mcp, "approvedCall", "POST", mcpUrl, mcpUrl, bearer(key), rpc("tools/call", { name: "search", arguments: { q: "contract" } }));
  const approval = await nextPending(store);
  await call(out.admin, "approveApproval", "POST", "/admin/approvals/:id/approve", `/admin/approvals/${approval.id}/approve`, adminHeaders);
  await pending;
  await call(out.mcp, "toolNotAllowed", "POST", mcpUrl, mcpUrl, bearer(limited.key), rpc("tools/call", { name: "delete", arguments: {} }));
  await call(out.mcp, "invalidKey", "POST", mcpUrl, mcpUrl, bearer("ga_this-key-does-not-exist-at-all"), rpc("tools/call", { name: "search" }));
  await call(out.mcp, "batchRefused", "POST", mcpUrl, mcpUrl, bearer(key), [rpc("tools/call", { name: "search" })] as unknown as object);

  // Admin API: the rest.
  await call(out.admin, "listAgents", "GET", "/admin/agents", "/admin/agents", adminHeaders);
  await call(out.admin, "updateAgent", "PATCH", "/admin/agents/:id", `/admin/agents/${agent.id}`, adminHeaders, { dailyBudgetUsd: 10, active: true });
  await call(out.admin, "rotateKey", "POST", "/admin/agents/:id/rotate-key", `/admin/agents/${agent.id}/rotate-key`, adminHeaders);
  await call(out.admin, "spendCheck", "GET", "/admin/spend-check", "/admin/spend-check", adminHeaders);
  await call(out.admin, "listApprovals", "GET", "/admin/approvals", "/admin/approvals?status=approved", adminHeaders);
  await call(out.admin, "facets", "GET", "/admin/ledger/facets", "/admin/ledger/facets", adminHeaders);

  // A row written late from the spool: the same store path the ledger guard uses when it replays a spool line.
  await store.appendLedger({
    ts: new Date().toISOString(),
    agentId: agent.id,
    action: "chat.completions",
    model: "gpt-4o-mini",
    verdict: "allowed",
    reason: null,
    upstreamStatus: 200,
    promptTokens: 10,
    completionTokens: 20,
    cost: 100,
    requestHash: "a".repeat(64),
    responseHash: "b".repeat(64),
    degraded: true,
  });

  await call(out.admin, "verify", "GET", "/admin/ledger/verify", "/admin/ledger/verify", adminHeaders);
  const page = await call(out.admin, "ledger", "GET", "/admin/ledger", "/admin/ledger?limit=1000", adminHeaders);
  const entries = (page.json() as { entries: LedgerEntry[] }).entries;
  await app.close();
  return { ledger: { formatVersion: 1, head: entries.at(-1)!.hash, entries }, ...out };
}

function writeFixtures(g: Generated): void {
  mkdirSync(DIR, { recursive: true });
  const write = (file: string, data: unknown) => writeFileSync(`${DIR}${file}`, `${JSON.stringify(data, null, 2)}\n`);
  write(FILES.ledger, g.ledger);
  write(FILES.openai, g.openai);
  write(FILES.anthropic, g.anthropic);
  write(FILES.mcp, g.mcp);
  write(FILES.admin, g.admin);
}

function readFixture<T>(file: string): T {
  return JSON.parse(readFileSync(`${DIR}${file}`, "utf-8")) as T;
}

/** M05 extends the historical API samples; keep the v1 proof fixture byte-for-byte intact. */
function withMandateFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withMandateFields);
  if (value === null || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const next = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, withMandateFields(v)]));
  if ("allowedModels" in row && "dailyBudgetUsd" in row) next.policyRev = "content-hash";
  if ("argsHash" in row && "status" in row) {
    next.policyRev = "content-hash";
    if (row.status === "approved" || row.status === "rejected") next.operatorId = "bootstrap";
  }
  if ("seq" in row && "hash" in row) {
    const action = String(row.action);
    if (row.agentId && (action !== "admin.agent.rotate-key") && row.degraded !== true) next.policyRev = "content-hash";
    if (action.startsWith("admin.") || action === "mcp.approval.decided") next.operatorId = "bootstrap";
    if (action.startsWith("mcp.approval.") || action === "mcp.tools/call") next.approvalRef = "approval-id";
  }
  return next;
}

/** Structure of a JSON value: keys and primitive types, not values (lists by their first element). */
function shape(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? [] : [shape(value[0])];
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !(key === "formatVersion" && "seq" in value && "hash" in value))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, shape(v)]),
    );
  }
  return typeof value;
}

/** Machine-readable error values (error, code, type, reason strings) with their paths. */
function errorValues(value: unknown, path = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) value.forEach((v, i) => Object.assign(out, errorValues(v, `${path}[${i}]`)));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && ["error", "code", "type", "reason"].includes(k)) out[`${path}.${k}`] = v;
      else Object.assign(out, errorValues(v, `${path}.${k}`));
    }
  }
  return out;
}

/** The hash algorithm exactly as written in docs/ledger-format.md, independent of packages/core. */
function documentedCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(documentedCanonical).join(",")}]`;
  const members = Object.keys(value)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${JSON.stringify(k)}:${documentedCanonical((value as Record<string, unknown>)[k])}`);
  return `{${members.join(",")}}`;
}
function documentedHash(entry: LedgerEntry): string {
  const { hash: _hash, ...hashed } = entry;
  return createHash("sha256").update(documentedCanonical(hashed), "utf8").digest("hex");
}

const V1_FIELDS = [
  "action", "agentId", "completionTokens", "cost", "hash", "model", "prevHash", "promptTokens", "reason",
  "requestHash", "responseHash", "seq", "ts", "upstreamStatus", "verdict",
];

let ledger: Generated["ledger"];

beforeAll(async () => {
  if (process.env.GARDAGENT_UPDATE_FIXTURES === "1") {
    console.warn("contracts: writing golden fixtures in test/fixtures/contracts/ (commit them, then never edit them)");
    writeFixtures(await generate());
  }
  let missing = Object.values(FILES).filter((f) => !existsSync(`${DIR}${f}`));
  if (missing.length === Object.keys(FILES).length) {
    console.warn("contracts: no golden fixtures found, writing the initial baseline (commit it, then never edit it)");
    writeFixtures(await generate());
    missing = [];
  }
  if (missing.length > 0) {
    throw new Error(
      `golden fixtures missing: ${missing.join(", ")}. Generate once with GARDAGENT_UPDATE_FIXTURES=1 and commit them.`,
    );
  }
  ledger = readFixture<Generated["ledger"]>(FILES.ledger);
}, 30_000);

describe("contract: ledger format version 1", () => {
  it("the golden entries verify with the current code", () => {
    expect(ledger.formatVersion).toBe(1);
    expect(ledger.entries.length).toBeGreaterThan(10);
    expect(verifyChain(ledger.entries)).toEqual({ valid: true, count: ledger.entries.length, lastHash: ledger.head, lastVersion: 1 });
    expect(ledger.entries[0]!.prevHash).toBe(GENESIS_HASH);
  });

  it("every hash is reproduced by the algorithm written in docs/ledger-format.md", () => {
    for (const entry of ledger.entries) expect(documentedHash(entry)).toBe(entry.hash);
  });

  it("entries have exactly the version 1 fields; degraded appears only when true", () => {
    for (const entry of ledger.entries) {
      const { degraded, ...rest } = entry;
      expect(Object.keys(rest).sort()).toEqual(V1_FIELDS);
      if ("degraded" in entry) expect(degraded).toBe(true);
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(entry.cost)).toBe(true);
    }
  });

  it("covers the paths a verifier has to handle", () => {
    const actions = new Set(ledger.entries.map((e) => e.action));
    for (const action of [
      "chat.completions", "messages", "mcp.tools/call", "mcp.approval.requested", "mcp.approval.decided",
      "admin.agent.create", "admin.agent.update", "admin.agent.rotate-key",
    ]) {
      expect(actions, action).toContain(action);
    }
    expect(ledger.entries.some((e) => e.verdict === "denied")).toBe(true);
    expect(ledger.entries.some((e) => e.agentId === null)).toBe(true);
    expect(ledger.entries.some((e) => e.degraded === true)).toBe(true);
    expect(ledger.entries.some((e) => e.degraded === undefined)).toBe(true);
  });

  it("a modified entry no longer verifies", () => {
    const entries = ledger.entries.map((e) => ({ ...e }));
    entries[3]!.cost += 1;
    expect(verifyChain(entries)).toMatchObject({ valid: false, brokenAtSeq: entries[3]!.seq, problem: "hash_mismatch" });
  });

  it("giving an old entry a default degraded=false breaks it (new fields must stay absent)", () => {
    const entries = ledger.entries.map((e) => ({ ...e }));
    const index = entries.findIndex((e) => e.degraded === undefined);
    entries[index] = { ...entries[index]!, degraded: false };
    expect(verifyChain(entries)).toMatchObject({ valid: false, brokenAtSeq: entries[index]!.seq, problem: "hash_mismatch" });
  });

  it("removing the degraded marker of a late row breaks it", () => {
    const entries = ledger.entries.map((e) => ({ ...e }));
    const index = entries.findIndex((e) => e.degraded === true);
    delete entries[index]!.degraded;
    expect(verifyChain(entries)).toMatchObject({ valid: false, brokenAtSeq: entries[index]!.seq, problem: "hash_mismatch" });
  });

  it("states the documented limit: a truncated tail still verifies, only an external head reveals it", () => {
    const truncated = ledger.entries.slice(0, -2);
    const check = verifyChain(truncated);
    expect(check.valid).toBe(true);
    expect(check.valid && check.lastHash).not.toBe(ledger.head);
  });
});

describe("contract: HTTP API samples", () => {
  let live: Generated;
  beforeAll(async () => {
    live = await generate();
  }, 30_000);

  it.each(["openai", "anthropic", "mcp", "admin"] as const)("%s: status and response shape match the golden samples", (name) => {
    const golden = readFixture<Samples>(FILES[name]);
    expect(Object.keys(live[name]).sort()).toEqual(Object.keys(golden).sort());
    for (const [sample, expected] of Object.entries(golden)) {
      const actual = live[name][sample]!;
      expect({ sample, method: actual.method, route: actual.route, status: actual.status }).toEqual({
        sample,
        method: expected.method,
        route: expected.route,
        status: expected.status,
      });
      expect({ sample, shape: shape(actual.response) }).toEqual({ sample, shape: shape(withMandateFields(expected.response)) });
      if (expected.status >= 400) {
        expect({ sample, errors: errorValues(actual.response) }).toEqual({ sample, errors: errorValues(expected.response) });
      }
    }
  });

  it("the live ledger adds version 2 and admission revision to the historical shape", () => {
    expect(live.ledger.entries.every((entry) => entry.formatVersion === 2)).toBe(true);
    expect(shape(live.ledger.entries.find((e) => e.action === "chat.completions"))).toEqual(
      shape(withMandateFields(ledger.entries.find((e) => e.action === "chat.completions" && e.degraded === undefined))),
    );
  });

  it("keys never reach the fixtures", () => {
    for (const file of Object.values(FILES)) {
      const keys = readFileSync(`${DIR}${file}`, "utf-8").match(/ga_[A-Za-z0-9_-]{20,}/g) ?? [];
      for (const k of keys) expect(k).toBe(KEY_PLACEHOLDER);
    }
  });
});
