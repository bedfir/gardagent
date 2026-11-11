// End-to-end validation harness: runs acceptance criteria (a)-(g) and (i) from docs/pilot-zero.md
// against a real Gardagent gateway and the real provider. Plain Node ESM, no dependencies.
// Secrets come from the environment only and are never printed.
import { createHash } from "node:crypto";
import http from "node:http";
import { writeFileSync } from "node:fs";
import { pairForCriterionC, streamVerdict } from "./pairing.mjs";
import { transportCause, gatewayErrorCode, failureBreakdown, restartInvariants } from "./restart.mjs";

const E = process.env;
const need = (n) => {
  if (!E[n]) throw new Error(`Missing environment variable ${n}`);
  return E[n];
};
const GW = (E.GW ?? "http://gateway:8080").replace(/\/+$/, "");
const ADMIN = need("GARDAGENT_ADMIN_TOKEN");
const UPSTREAM = need("UPSTREAM_BASE_URL").replace(/\/+$/, "") + "/v1/chat/completions";
const UPSTREAM_KEY = need("UPSTREAM_API_KEY");
const PRICES = JSON.parse(need("GARDAGENT_PRICES"));
const MODEL = E.PZ_MODEL ?? "mimo-v2.6-flash";
const PZ_KEY = need("PZ_KEY"); // key of the long-lived "pilot-zero" agent
const GW_CONTAINER = E.GW_CONTAINER ?? "gardagent-gateway-1";
const PG_CONTAINER = E.PG_CONTAINER ?? "gardagent-postgres-1";
const CHAOS_SECONDS = Number(E.CHAOS_SECONDS ?? 75);
const ONLY = E.ONLY ? E.ONLY.split(",") : null;
// The OpenCode Go provider rejects requests without a session header; sent on both paths (the gateway forwards it).
const SESSION = `pilot-zero-${Date.now().toString(36)}`;

// ---------- helpers ----------
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const e = Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${e.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const price = (model) => PRICES[model] ?? { input: 10, output: 30 };
const costMicro = (model, pt, ct) => (pt * price(model).input + ct * price(model).output); // micro-USD (USD/M tokens * tokens)

async function admin(path, init = {}) {
  const r = await fetch(GW + path, { ...init, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
// Agents created by this run: all of them are deactivated when the run ends, however it ends.
const createdAgents = [];
let cleanedUp = false;
async function deactivateCreatedAgents() {
  if (cleanedUp) return;
  cleanedUp = true;
  let failed = 0;
  for (const a of createdAgents) {
    let done = false;
    // The gateway may still be restarting after the chaos phase: retry for a while.
    for (let i = 0; i < 20 && !done; i++) {
      try { done = (await admin(`/admin/agents/${a.id}`, { method: "PATCH", body: JSON.stringify({ active: false }) })).status === 200; } catch { /* retry */ }
      if (!done) await sleep(3000);
    }
    if (!done) failed++;
  }
  console.log(`cleanup: ${createdAgents.length - failed}/${createdAgents.length} agents created by this run deactivated${failed ? ` (${failed} FAILED: deactivate them by hand, names: ${createdAgents.map((a) => a.name).join(", ")})` : ""}`);
}
// Failure or interruption: deactivate, then exit. Nothing here prints a key.
for (const [event, code] of [["uncaughtException", 1], ["unhandledRejection", 1], ["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(event, async (e) => {
    if (code === 1) console.error(`harness error: ${e instanceof Error ? e.message : String(e)}`);
    await deactivateCreatedAgents();
    process.exit(code);
  });
}

async function createAgent(name, models, budgetUsd, extra = {}) {
  const r = await admin("/admin/agents", { method: "POST", body: JSON.stringify({ name, allowedModels: models, dailyBudgetUsd: budgetUsd, ...extra }) });
  if (r.status !== 201) throw new Error(`createAgent ${name}: ${r.status}`);
  createdAgents.push({ name, id: r.json.agent.id });
  return { name, id: r.json.agent.id, key: r.json.key };
}
async function ledgerAfter(seq) {
  const out = [];
  for (;;) {
    const r = await admin(`/admin/ledger?afterSeq=${seq}&limit=1000`);
    const rows = r.json?.entries ?? [];
    if (!rows.length) return out;
    out.push(...rows);
    seq = rows.at(-1).seq;
  }
}
async function verify() {
  const r = await admin("/admin/ledger/verify");
  return r.json ?? { valid: false, problem: `HTTP ${r.status}` };
}
const lastSeq = async () => (await admin("/admin/ledger?order=desc&limit=1")).json?.entries?.[0]?.seq ?? 0;

function parseBody(status, text, stream) {
  if (!stream || status !== 200) {
    let j = null;
    try { j = JSON.parse(text); } catch { /* ignore */ }
    return { status, content: j?.choices?.[0]?.message?.content ?? "", usage: j?.usage ?? null, raw: text };
  }
  const events = text.split("\n\n").map((e) => e.trim()).filter(Boolean);
  let content = "";
  let usage = null;
  let done = false;
  let chunks = 0;
  let finish = null;
  let usageChunks = 0;
  for (const ev of events) {
    const data = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (data === "[DONE]") { done = true; continue; }
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    chunks++;
    if (j.usage) usage = j.usage;
    if (j.usage && !(j.choices ?? []).length) usageChunks++;
    finish = j.choices?.[0]?.finish_reason ?? finish;
    content += j.choices?.[0]?.delta?.content ?? "";
  }
  return { status, content, usage, done, chunks, finish, usageChunks, raw: text };
}

const sent = []; // every request made to the gateway chat endpoint
async function viaGateway(agent, body, group = "main") {
  const rec = { agent: agent.name, agentId: agent.id, hash: sha256(canonicalJson(body)), status: 0, group };
  sent.push(rec);
  const t0 = performance.now();
  try {
    const r = await fetch(GW + "/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${agent.key}`, "content-type": "application/json", "x-opencode-session": SESSION }, body: JSON.stringify(body), ...(group === "chaos" ? { signal: AbortSignal.timeout(120000) } : {}) });
    rec.status = r.status;
    const text = await r.text();
    rec.ms = performance.now() - t0;
    const p = parseBody(r.status, text, body.stream === true);
    rec.model = body.model;
    rec.usage = p.usage;
    if (r.status !== 200) rec.gatewayCode = gatewayErrorCode(text);
    return { ...p, ms: rec.ms, rec };
  } catch (e) {
    rec.failure = transportCause(e);
    rec.error = rec.failure;
    return { status: 0, error: rec.error, rec };
  }
}
async function direct(body) {
  const t0 = performance.now();
  const r = await fetch(UPSTREAM, { method: "POST", headers: { authorization: `Bearer ${UPSTREAM_KEY}`, "content-type": "application/json", "x-opencode-session": SESSION }, body: JSON.stringify(body) });
  const text = await r.text();
  return { ...parseBody(r.status, text, body.stream === true), ms: performance.now() - t0 };
}
async function pool(n, tasks) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) { const k = i++; results[k] = await tasks[k](); }
  }));
  return results;
}
function dockerPost(path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: "/var/run/docker.sock", path, method: "POST" }, (x) => { x.resume(); x.on("end", () => resolve(x.statusCode)); });
    r.on("error", reject);
    r.end();
  });
}
// Read raw rows: getReserved intentionally excludes expired reservations.
async function dockerRequest(path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: "/var/run/docker.sock", path, method: "POST",
      headers: { "content-type": "application/json" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode !== 200 && response.statusCode !== 201) return reject(new Error("Docker request failed"));
        resolve(Buffer.concat(chunks));
      });
    });
    r.setTimeout(15000, () => r.destroy(new Error("Docker request timeout")));
    r.on("error", reject);
    r.end(JSON.stringify(body));
  });
}
async function restartAccounting(agentId) {
  if (!/^[a-zA-Z0-9-]+$/.test(agentId)) throw new Error("Invalid restart agent ID");
  const sql = `SELECT json_build_object('reservations', (SELECT count(*) FROM agent_reservations WHERE agent_id='${agentId}'), 'spendMicro', (SELECT COALESCE(sum(amount),0) FROM agent_spend WHERE agent_id='${agentId}'));`;
  const exec = JSON.parse((await dockerRequest(`/containers/${PG_CONTAINER}/exec`, {
    AttachStdout: true, AttachStderr: true,
    Cmd: ["sh", "-c", 'exec psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"', "psql", sql],
  })).toString());
  const raw = await dockerRequest(`/exec/${exec.Id}/start`, { Detach: false, Tty: false });
  const stdout = [];
  // Docker non-TTY output consists of eight-byte frame headers and payloads.
  for (let offset = 0; offset < raw.length;) {
    if (offset + 8 > raw.length) throw new Error("Truncated Docker frame");
    const length = raw.readUInt32BE(offset + 4);
    if (offset + 8 + length > raw.length) throw new Error("Truncated Docker payload");
    if (raw[offset] === 1) stdout.push(raw.subarray(offset + 8, offset + 8 + length));
    else throw new Error("PostgreSQL diagnostic failed");
    offset += 8 + length;
  }
  return JSON.parse(Buffer.concat(stdout).toString().trim());
}
async function waitUntil(fn, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return Date.now() - t0; } catch { /* retry */ }
    await sleep(500);
  }
  return null;
}

const results = {}; // criterion -> {pass, detail}
const chain = []; // verification after each test
async function checkChain(label) {
  const v = await verify();
  chain.push({ label, valid: v.valid === true, checked: v.checked, problem: v.problem });
}
const record = (k, pass, detail) => { results[k] = { pass, detail }; console.log(`[${k}] ${pass ? "PASS" : "FAIL"}  ${detail}`); };
const want = (k) => !ONLY || ONLY.includes(k);

// ---------- setup ----------
const startSeq = await lastSeq();
const startedAt = new Date().toISOString();
const agents = (await admin("/admin/agents")).json.agents;
const pzInfo = agents.find((a) => a.name === "pilot-zero");
if (!pzInfo) throw new Error("Agent pilot-zero not found.");
if (!pzInfo.allowedModels.includes(MODEL)) {
  await admin(`/admin/agents/${pzInfo.id}`, { method: "PATCH", body: JSON.stringify({ allowedModels: [...pzInfo.allowedModels, MODEL] }) });
}
const pz = { name: "pilot-zero", id: pzInfo.id, key: PZ_KEY };
const tag = Date.now().toString(36);
const base = { model: MODEL, max_tokens: 16, temperature: 0 };
const msg = (t) => [{ role: "user", content: t }];

// ---------- (a)(b)(c): mixed real traffic, with usage cross-check ----------
const ledgerAgentSeqStart = await lastSeq();
if (want("abc") || want("e")) {
  const tasks = [];
  for (let i = 0; i < 24; i++) {
    const stream = i % 2 === 1;
    const body = { ...base, max_tokens: 24, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), messages: msg(`Reply with one short word. Run ${tag} #${i}`) };
    tasks.push(() => viaGateway(pz, body, "traffic"));
  }
  const res = await pool(4, tasks);
  var trafficOk = res.filter((r) => r.status === 200).length;
  var trafficUsage = res.filter((r) => r.status === 200 && r.usage).map((r) => ({ pt: r.usage.prompt_tokens, ct: r.usage.completion_tokens }));
  await checkChain("traffic");
}

// ---------- (e) latency overhead: direct vs gateway, interleaved pairs ----------
if (want("e")) {
  const PAIRS = Number(process.env.PZ_PAIRS ?? 60);
  const d = [], g = [];
  const body = { ...base, max_tokens: 8, messages: msg("Reply with the single word OK.") };
  for (let i = 0; i < PAIRS; i++) {
    const order = i % 2 === 0 ? ["d", "g"] : ["g", "d"];
    for (const w of order) {
      if (w === "d") { const r = await direct(body); if (r.status === 200) d.push(r.ms); }
      else { const r = await viaGateway(pz, body, "latency"); if (r.status === 200) g.push(r.ms); }
    }
  }
  const n = Math.min(d.length, g.length);
  const overheadP95 = pct(g, 95) - pct(d, 95);
  const overheadMed = pct(g, 50) - pct(d, 50);
  // Informational only (never pass/fail): provider jitter (seconds) makes this meaningless as a gate.
  // The criterion (e) gate is the stub measurement of latency-stub.sh (p95 overhead < 100 ms, 300 pairs).
  record("e", true, `INFORMATIONAL real-provider comparison, not a gate: pairs=${n} direct p50/p95=${pct(d, 50).toFixed(0)}/${pct(d, 95).toFixed(0)}ms gateway p50/p95=${pct(g, 50).toFixed(0)}/${pct(g, 95).toFixed(0)}ms median overhead=${overheadMed.toFixed(0)}ms (p95 diff ${overheadP95.toFixed(0)}ms is provider jitter). The gate is latency-stub.sh.`);
  await checkChain("latency");
}

// ---------- (f) streaming identical through gateway and direct ----------
if (want("f")) {
  // N samples per side and per prompt, verdict by majority (pairing.mjs): one provider answer that deviates must not
  // decide the criterion. Direct and gateway calls alternate so that a provider drift hits both sides alike.
  const N = Number(process.env.PZ_F_SAMPLES ?? 5);
  if (!Number.isInteger(N) || N < 1 || N > 25) throw new Error("PZ_F_SAMPLES must be an integer between 1 and 25.");
  let det = 0, same = 0, ended = 0, diffs = [], notes = [], prompts = [];
  for (let i = 0; i < 6; i++) {
    const body = { model: MODEL, max_tokens: 300, temperature: 0, stream: true, messages: msg(`Reply with exactly this text and nothing else: PILOT-ZERO-STREAM-${i}`) };
    const ds = [], gs = [];
    for (let k = 0; k < N; k++) {
      ds.push(await direct(body));
      gs.push(await viaGateway(pz, body, "stream"));
    }
    const v = streamVerdict(ds, gs);
    const show = (xs) => xs.map((x) => (x.status === 200 ? `"${String(x.content).slice(0, 24)}"/${x.finish ?? "?"}${x.done === false ? "/no-DONE" : ""}` : `status ${x.status}`)).join(", ");
    prompts.push(`#${i} ${v.verdict} (${v.reason}); direct outcome counts [${v.direct}] of ${N}, gateway [${v.gateway}] of ${N}, gateway [DONE] ${v.ended}/${N}`);
    if (v.verdict === "undetermined") continue; // provider itself not deterministic on this prompt: decides nothing
    det++;
    if (v.endedMajority) ended++;
    const ok = gs.filter((x) => x.status === 200), dok = ds.filter((x) => x.status === 200);
    if (ok[0] && dok[0]) notes.push(`#${i} chunks gw=${ok[0].chunks} direct=${dok[0].chunks} usage-only chunks gw=${ok[0].usageChunks} direct=${dok[0].usageChunks}`);
    if (v.verdict === "identical") same++;
    else diffs.push(`#${i} ${v.reason}; direct: ${show(ds)} | gateway: ${show(gs)}`);
  }
  record("f", det >= 3 && same === det && ended >= det, `samples per side per prompt N=${N}; determined prompts=${det}/6, identical by majority=${same}, gateway streams ending with [DONE] (majority)=${ended}${diffs.length ? " diffs: " + diffs.join("; ") : ""} | per prompt: ${prompts.join(" / ")} | chunking (informational): ${notes.slice(0, 3).join(" / ")}`);
  await checkChain("stream");
}

// ---------- (d) budget never exceeded, concurrent real streaming ----------
if (want("d")) {
  const BUDGET = 0.0008; // USD
  const cap = await createAgent(`pilot-zero-cap-${tag}`, [MODEL], BUDGET);
  const mk = (i) => ({ model: MODEL, max_tokens: 400, stream: true, stream_options: { include_usage: true }, messages: msg(`Write about 150 words on topic number ${i}: why audit trails matter.`) });
  const wave1 = await pool(20, Array.from({ length: 20 }, (_, i) => () => viaGateway(cap, mk(i), "cap")));
  const wave2 = [];
  for (let i = 20; i < 30; i++) wave2.push(await viaGateway(cap, mk(i), "cap"));
  const all = [...wave1, ...wave2];
  const ok = all.filter((r) => r.status === 200).length;
  const denied = all.filter((r) => r.status === 429).length;
  const other = all.filter((r) => r.status !== 200 && r.status !== 429).map((r) => r.status);
  const spentMicro = (await ledgerAfter(ledgerAgentSeqStart)).filter((e) => e.agentId === cap.id).reduce((s, e) => s + e.cost, 0);
  const ag = (await admin("/admin/agents")).json.agents.find((a) => a.id === cap.id);
  const budgetMicro = BUDGET * 1e6;
  record("d", spentMicro <= budgetMicro && ok > 0 && denied > 0 && other.length === 0 && ag.reservedTodayUsd === 0,
    `budget=${BUDGET} USD, ledger spend=${(spentMicro / 1e6).toFixed(6)} USD (${((spentMicro / budgetMicro) * 100).toFixed(0)}%), admitted=${ok}, refused 429=${denied}, other=${other.length}, leftover reservations=${ag.reservedTodayUsd}`);
  await checkChain("budget");
}

// ---------- (g) gateway and PostgreSQL restarts during traffic ----------
if (want("g")) {
  const chaos = await createAgent(`pilot-zero-chaos-${tag}`, [MODEL], 0.1);
  let stop = false, n = 0;
  const worker = async () => {
    while (!stop) {
      const stream = n % 2 === 1;
      const body = { model: MODEL, max_tokens: 12, temperature: 0, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), messages: msg(`Reply OK. chaos ${tag} #${n++}`) };
      await viaGateway(chaos, body, "chaos");
      await sleep(100);
    }
  };
  const workers = Array.from({ length: 4 }, worker);
  const events = [];
  await sleep(8000);
  events.push(`gateway restart http=${await dockerPost(`/containers/${GW_CONTAINER}/restart?t=10`)}`);
  events.push(`gateway back in ${await waitUntil(async () => (await fetch(GW + "/health")).ok)}ms`);
  await sleep(10000);
  events.push(`postgres restart http=${await dockerPost(`/containers/${PG_CONTAINER}/restart?t=10`)}`);
  const recovered = await waitUntil(async () => (await admin("/admin/ledger/verify")).status === 200, 60000);
  if (recovered === null) { // operator action, so that the rest of the round can run
    await dockerPost(`/containers/${GW_CONTAINER}/start`);
    await waitUntil(async () => (await admin("/admin/ledger/verify")).status === 200, 60000);
  }
  events.push(`gateway usable again by itself after PostgreSQL restart: ${recovered === null ? "NO (not within 60s)" : recovered + "ms"}`);
  await sleep(Math.max(0, CHAOS_SECONDS * 1000 - 35000));
  stop = true;
  await Promise.all(workers);
  await sleep(2000);
  const mine = sent.filter((s) => s.group === "chaos");
  const failures = failureBreakdown(mine);
  let accounting;
  let rows = [];
  let v = { valid: false };
  const observationErrors = [];
  try { accounting = await restartAccounting(chaos.id); }
  catch { observationErrors.push("restart accounting query failed"); }
  try { rows = await ledgerAfter(ledgerAgentSeqStart); }
  catch { observationErrors.push("restart ledger read failed"); }
  try { v = await verify(); }
  catch { observationErrors.push("restart chain verification failed"); }
  const invariants = restartInvariants(mine, rows, chaos.id, v.valid, accounting);
  const diagnostics = { failures, invariants, observationErrors };
  record("g", invariants.pass && observationErrors.length === 0 && recovered !== null,
    `${events.join("; ")}; requests=${mine.length}; diagnostics=${JSON.stringify(diagnostics)}`);
  results.g.diagnostics = diagnostics;
  // Persist restart evidence even if a later criterion cannot finish.
  if (E.RESULTS_FILE) writeFileSync(E.RESULTS_FILE, JSON.stringify({ startedAt, results }, null, 2));
  chain.push({ label: "chaos", valid: v.valid === true, checked: v.checked });
}

// ---------- (i) MCP via /mcp/:server ----------
if (want("i")) {
  const mcpAgent = await createAgent(`pilot-zero-mcp-${tag}`, [MODEL], 0.01, { allowedTools: ["everything/echo", "everything/get-sum"], approvalTools: [] });
  const mcpStart = await lastSeq();
  let sid = null, proto = null;
  const rpc = async (m, wait = true) => {
    const headers = { authorization: `Bearer ${mcpAgent.key}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (sid) headers["mcp-session-id"] = sid;
    if (proto) headers["mcp-protocol-version"] = proto;
    const r = await fetch(`${GW}/mcp/everything`, { method: "POST", headers, body: JSON.stringify(m) });
    sid = r.headers.get("mcp-session-id") ?? sid;
    const text = await r.text();
    let json = null;
    if ((r.headers.get("content-type") ?? "").includes("event-stream")) {
      for (const ev of text.split("\n\n")) { const d = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""); try { const j = JSON.parse(d); if (j.id === m.id) json = j; } catch { /* skip */ } }
    } else { try { json = JSON.parse(text); } catch { /* none */ } }
    return { status: r.status, json };
  };
  const notes = [];
  let pass = false;
  try {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pilot-zero", version: "1" } } });
    proto = init.json?.result?.protocolVersion ?? "2025-06-18";
    notes.push(`initialize=${init.status} session=${sid ? "yes" : "no"}`);
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (list.json?.result?.tools ?? []).map((t) => t.name);
    notes.push(`tools=${names.length}`);
    const [okTool, approvalTool, deniedTool] = ["echo", "get-sum", "get-env"];
    if (![okTool, approvalTool, deniedTool].every((t) => names.includes(t))) throw new Error(`expected tools missing; server offers: ${names.join(",")}`);
    const call = (id, name, args) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const allowed = await call(10, okTool, { message: "pilot-zero" });
    const denied = await call(11, deniedTool, {});
    const approve = async (decision, id) => {
      const pending = call(id, approvalTool, { a: 2, b: 3 });
      const found = await waitUntil(async () => {
        const l = (await admin("/admin/approvals?status=pending")).json?.approvals ?? [];
        const a = l.find((x) => x.agentId === mcpAgent.id);
        if (!a) return false;
        const r = await admin(`/admin/approvals/${a.id}/${decision}`, { method: "POST", body: decision === "reject" ? JSON.stringify({ reason: "pilot-zero rejection" }) : "{}" });
        return r.status === 200;
      }, 15000);
      return { found, res: await pending };
    };
    const appr = await approve("approve", 12);
    const rej = await approve("reject", 13);
    const rows = (await ledgerAfter(mcpStart)).filter((e) => e.agentId === mcpAgent.id);
    const has = (action, model, verdict, reason) => rows.some((e) => e.action === action && (!model || e.model === model) && (!verdict || e.verdict === verdict) && (!reason || e.reason === reason));
    const checks = {
      "allowed read tool returns result": allowed.json?.result && !allowed.json?.error,
      "denied tool returns error": !!denied.json?.error,
      "approved call returns result": appr.res.json?.result && !appr.res.json?.error,
      "rejected call returns error": !!rej.res.json?.error,
      "ledger: allowed call": has("mcp.tools/call", "everything/echo#read", "allowed"),
      "ledger: denied call": has("mcp.tools/call", "everything/get-env#write", "denied", "tool_not_allowed"),
      "ledger: 2 approval requests": rows.filter((e) => e.action === "mcp.approval.requested").length === 2,
      "ledger: approval decided approved": has("mcp.approval.decided", null, "allowed", "approved"),
      "ledger: approval decided rejected": has("mcp.approval.decided", null, "denied", "rejected"),
      "ledger: approved call executed": has("mcp.tools/call", "everything/get-sum#write", "allowed"),
      "ledger: rejected call never executed (only one get-sum tools/call row)": rows.filter((e) => e.action === "mcp.tools/call" && e.model === "everything/get-sum#write").length === 1,
    };
    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    pass = failed.length === 0;
    notes.push(failed.length ? `FAILED: ${failed.join("; ")}` : `${Object.keys(checks).length}/${Object.keys(checks).length} checks`);
    notes.push(`ledger rows=${rows.length}`);
  } catch (e) {
    notes.push(`error: ${e.message}`);
  }
  record("i", pass, `real server "everything" (streamable HTTP) behind /mcp/everything; ${notes.join("; ")}`);
  await checkChain("mcp");
}

// ---------- (a)(b)(c) evaluation over everything sent ----------
if (want("abc") || want("e")) {
  const rows = (await ledgerAfter(startSeq)).filter((e) => e.action === "chat.completions");
  const have = new Map();
  for (const e of rows) { const k = `${e.agentId}|${e.requestHash}`; have.set(k, (have.get(k) ?? 0) + 1); }
  const answered = sent.filter((s) => s.status !== 0 && !s.failure && s.group !== "chaos");
  const missing = answered.filter((s) => { const k = `${s.agentId}|${s.hash}`; const c = have.get(k) ?? 0; if (c > 0) { have.set(k, c - 1); return false; } return true; });
  record("b", missing.length === 0 && answered.length > 0, `${answered.length} gateway requests answered, ${missing.length} missing from ledger`);

  // Pair only with ledger rows of calls the upstream answered with 200 (see pairing.mjs).
  const { matched: nUsage, tokenMismatch, ledgerCost, providerCost } = pairForCriterionC(rows, sent.filter((r) => r.group !== "chaos"), costMicro);
  const ratio = ledgerCost / providerCost;
  record("c", ratio >= 0.9 && ratio <= 1.1, `ledger cost=${(ledgerCost / 1e6).toFixed(6)} USD vs cost from provider-returned usage=${(providerCost / 1e6).toFixed(6)} USD over ${nUsage} matched calls, token-count mismatches=${tokenMismatch} (ratio ${ratio.toFixed(3)}; allowed ±10%)`);
}

await checkChain("final");
const allValid = chain.every((c) => c.valid);
record("a", allValid && chain.length > 1, `chain valid after each of ${chain.length} checks (${chain.map((c) => c.label + ":" + (c.valid ? "ok" : "BROKEN")).join(", ")})`);

const endRows = await ledgerAfter(startSeq);
const spend = endRows.reduce((s, e) => s + e.cost, 0) / 1e6;
console.log("\n=== VALIDATION ROUND SUMMARY ===");
for (const k of ["a", "b", "c", "d", "e", "f", "g", "i"]) {
  const r = results[k];
  console.log(`(${k})  ${r ? (r.pass ? "PASS" : "FAIL") : "SKIP"}`);
}
console.log(`ledger entries added: ${endRows.length}; real spend recorded by gateway: ${spend.toFixed(6)} USD; started ${startedAt}`);
if (E.RESULTS_FILE) writeFileSync(E.RESULTS_FILE, JSON.stringify({ startedAt, spendUsd: spend, entries: endRows.length, results }, null, 2));
await deactivateCreatedAgents();
process.exit(Object.values(results).every((r) => r.pass) ? 0 : 1);
