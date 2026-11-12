# Reference

Detailed behavior of the gateway: provider configuration, MCP governance, enforcement modes, database outage handling,
human approval, the admin API and the console. For a first run, start with the [README](../README.md); for production
deployment, see [self-hosting.md](self-hosting.md). All environment variables are listed in the
[README](../README.md#configuration).

## OpenCode Go configuration

In `.env` (see `.env.example`), base URLs are written without `/v1`: the gateway appends `/v1/chat/completions` and `/v1/messages`.

```bash
UPSTREAM_BASE_URL=https://opencode.ai/inference/go/openai
ANTHROPIC_UPSTREAM_BASE_URL=https://opencode.ai/inference/go/anthropic
UPSTREAM_API_KEY=...        # the provider key, which never leaves the gateway
```

**Headers sent to the provider**, common to both endpoints:

- `x-opencode-session`, required by OpenCode Go (without it: 400 error `MissingSessionID`). If the agent sends it, it is forwarded. Otherwise the gateway generates `gardagent-<agent id>-<YYYY-MM-DD>`, stable for one agent during one UTC day, keeping the provider's routing and cache efficient.
- `User-Agent: Gardagent/<version>`, always. The client's `User-Agent` is not forwarded.
- The list of forwarded headers is configured with `UPSTREAM_FORWARD_HEADERS` (comma-separated, case-insensitive, `x-opencode-session` by default). An empty list forwards and generates nothing.
- `authorization`, `x-api-key`, `cookie`, `host`, `content-length`, `content-type` and hop-by-hop headers are never forwarded, even if listed.

## MCP tools

The gateway can govern MCP servers (Streamable HTTP transport). Servers are declared in `.env`, and their headers (secrets included) are never exposed to agents:

```bash
GARDAGENT_MCP_SERVERS={"github":{"url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer ..."}}}
```

The agent points its MCP client to `http://localhost:8080/mcp/github` with its `ga_…` key as `Authorization: Bearer`. The `Mcp-Session-Id` and `MCP-Protocol-Version` headers are relayed in both directions, as are `text/event-stream` responses. JSON-RPC batches are rejected.

Only `tools/call` is controlled: the tool must appear in the agent's `allowedTools` (`server/tool`, `server/*` or `*`; empty list = no tools), otherwise the gateway answers with a JSON-RPC `-32001` error without calling the server. Every `tools/call` is logged (action `mcp.tools/call`, model `server/tool`, argument fingerprint and never the arguments). `initialize`, `tools/list` and notifications pass through untraced. Without `GARDAGENT_MCP_SERVERS`, the `/mcp` route does not exist.

### Read/write classification

Each server accepts an optional `readTools` list of tool names or glob patterns with `*`. Tools matching `readTools` are READ tools; every other tool is a WRITE tool. Missing `readTools` means every tool is WRITE.

```bash
GARDAGENT_MCP_SERVERS={"erp":{"url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer ..."},"readTools":["read_work_order","get_*"]}}
```

READ tools follow the normal `allowedTools`/`approvalTools` flow. WRITE tools always require human approval before they run, even if the agent's `approvalTools` is empty. In `observe` mode, WRITE tools are forwarded and logged with reason `observed:approval_required`. The ledger stores the access class in the model field as `server/tool#read` or `server/tool#write`.

## Enforcement modes

`GARDAGENT_MODE` controls whether the gateway blocks requests or only records them:

- `enforce` (default): policy violations are rejected with the usual errors.
- `observe`: requests that would be denied are forwarded normally and logged with reason prefixed by `observed:` (for example `observed:model_not_allowed`). Budget reservations still happen but never block, human approvals are skipped, and invalid agent keys are still rejected. Use this mode to measure what the rules would block before enforcing them.

Set the mode in `.env` (see `.env.example`):

```bash
GARDAGENT_MODE=observe
```

`GET /health` returns the active mode in the `mode` field.

### Database outage: fail-closed or fail-open

`GARDAGENT_DB_OUTAGE` sets what happens when PostgreSQL is unreachable:

- `fail-closed` (default): new requests are refused with 503 `ledger_unavailable`; only a request already in flight has its ledger entry written to the spool file and replayed later.
- `fail-open`: honored **only** with `GARDAGENT_MODE=observe`. In `enforce` mode the outage is always fail-closed whatever the setting (the gateway logs a warning at startup). LLM requests (OpenAI and Anthropic formats, streaming included) are forwarded, and each ledger entry is appended to the spool and fsynced **before** the response is acknowledged as complete. Spooled rows also carry the cost, the budget day and a `budgetSettlement: pending` marker (stored next to the row in the spool, not in the ledger) so budgets can be settled later. No database budget reservation is taken during the outage, so the daily cap is not enforced then.

Proof first: if the spool cannot take an entry (directory unwritable, I/O error, or file at `GARDAGENT_SPOOL_MAX_BYTES`, default 64 MiB), the gateway answers 503 instead of passing traffic. During an outage in fail-open: MCP read tools pass, while any tool that needs human approval and any write tool is refused (the approval state lives in the database); admin routes answer 503; agents are recognized from a memory cache of keys seen while the database was up, and unknown keys are refused. When the database returns, the spool is replayed in order into the hash chain, and each line is applied **exactly once**: every spool line has a stable id (generated when it is spooled) and the replay writes the ledger row, the `agent_spend` increment (on the budget day of the original request, not the day of the replay) and the release of the call's orphaned reservation in one transaction, guarded by that id. Replaying the same spool again (crash before the line was removed, an insert that timed out client-side but was committed, a timeout during COMMIT) changes nothing. Rows that went through the spool carry `degraded: true`, sealed in their hash (rows written directly have no such field, so existing hashes are unchanged); they are appended late with the timestamp of the original call, and the chain stays valid. While the database is healthy the gateway also purges budget reservations older than the upstream timeout plus 30 s (never a live one); idempotency keys are kept 30 days.

Interrupted calls: if the gateway process is killed while a call is in flight (restart, crash), the call leaves a budget reservation behind. When the reservation is older than the upstream timeout plus 30 s, housekeeping purges it and, in the same transaction, appends one ledger row for that call: verdict `allowed`, reason `interrupted_no_response`, the agent, the model and request hash that the reservation recorded (null for a reservation created before they were stored), 0 tokens, and **a cost equal to the reserved estimate**. The same amount is added to the agent's daily spend, exactly as for `client_aborted_estimated` (the estimate is a worst case, so the budget stays conservative: the real provider charge, if any, is unknown). The row means "this call was started and never answered: its outcome is unknown"; it is never written for a live in-flight call or one already settled. The reservation id is the idempotency key, so a second run or two gateway instances produce exactly one row per orphan, and if the row cannot be written (database down) the reservation is kept for the next run (within a minute of the database coming back). The row is not marked `degraded` (it did not go through the spool) and the chain stays valid. Housekeeping never purges while the spool still holds lines waiting to be replayed: a call that finished during the outage keeps its reservation until its spooled row settles it, so it is never counted twice. Expired reservations no longer disappear silently on the next reservation of the same agent: they are ignored for the budget and purged only by housekeeping, which leaves the row.

Unverifiable agent during an outage: in fail-open, a key unknown to the agent cache, or whose entry is older than `GARDAGENT_AGENT_CACHE_TTL_MS` plus the grace window, cannot be verified (the gateway must not answer 401 for a key it cannot check). It gets 503 with the code `agent_unverifiable_during_outage` and a message saying that the agent could not be verified while the database is unreachable and to retry later; the genuine ledger refusals keep `ledger_unavailable`. The code appears in `error.code` on `/v1/chat/completions` (OpenAI format), in `error.code` of the Anthropic-format body on `/v1/messages` (`type: api_error`), and in `error.data.code` of the JSON-RPC error on `/mcp/:server`. Limit: **refusals during an outage leave no trace**: this refusal, like any refusal that needs the database, writes no ledger row (the ledger is down and the spool only records calls that were served), so the ledger shows nothing for those requests.

Database timeouts: a database call on the request path (agent lookup, budget read/reservation/settlement, ledger write) is bounded, in both policies. If it does not answer within `GARDAGENT_DB_CALL_TIMEOUT_MS` (default 600 ms), the database is declared unreachable at once: a stream already in flight is closed normally right after that wait (its ledger row goes to the spool, with the cost and day for a later settlement), and later calls of the same outage skip the database altogether. A new request is refused with 503 (fail-closed) or served (fail-open) within the same bound. `GARDAGENT_DB_PROBE_TIMEOUT_MS` (default 800) bounds the health probe and `GARDAGENT_DB_CONNECT_TIMEOUT_MS` (default 2000) the wait for a pooled connection. All three are integers in milliseconds between 50 and 60000. A single call slower than the bound on a healthy but overloaded database flags it down until the next probe (within 2 s): raise the value rather than disable it.

Agent cache and `GARDAGENT_AGENT_CACHE_TTL_MS`: the memory cache of agents used during a fail-open outage is bounded in age and size. With a healthy database every request re-reads the agent, so the cache never authorizes anything then; it only refreshes the entry (a missing or disabled agent is never kept). Any admin change to an agent (`PATCH /admin/agents/:id`: disable/enable, models, tools, approval tools, budget, name) drops its entries synchronously, before the response is sent, so a disable applies at once in that process. During an outage an entry is served only if its last successful database lookup is at most `GARDAGENT_AGENT_CACHE_TTL_MS` (integer ms between 1000 and 600000, default 30000) **plus a fixed 120 s grace window** old; beyond that the agent is unknown and refused. The grace window is not configurable: the TTL alone would refuse an agent whose last lookup was a few seconds before the TTL ran out, as soon as the outage starts, while a longer one would let a stale policy live too long; 2 minutes covers a typical restart or failover, and the worst staleness is TTL + 120 s (150 s by default). The cache holds at most 1000 agent keys, the oldest evicted first. Limit: with several gateway instances, one instance cannot see another one's disable during an outage, which is exactly why the TTL is short and the window bounded; the admin action reaches the other instances only through the database. There is no delete endpoint (the ledger is append-only and references agents: disabling is the removal). `POST /admin/agents/:id/rotate-key` replaces an agent's key and drops its cache entries synchronously, like a PATCH, so the old key stops working at once in that process (see `deploy/rotate-agent-key.md`).

`GET /health` keeps `status`, `mode`, `database` and `spoolBacklog`, and adds `ledger: { status: "ok" | "degraded" | "down", dbOutagePolicy, spool: { backlog, bytes, maxBytes, writable } }`. In fail-open with a writable spool, `/health` answers 200 with `status: "degraded"` (the gateway is serving); otherwise a database outage still gives 503.

## Human approval

An agent can have MCP tools "requiring approval" (`approvalTools`, same format and wildcards as `allowedTools`, empty by default). An allowed `tools/call` that matches is not forwarded: the gateway creates a request (`approvals` table) and keeps the agent's HTTP request open until a decision or `GARDAGENT_APPROVAL_TIMEOUT_MS` (default 120000). If approved, the call is relayed normally; if rejected or expired, the agent gets JSON-RPC error `-32002` and the MCP server is never called. Waiting is woken in memory and, as a fallback, by polling the store every 2 seconds, so a decision taken on another instance is picked up.

Admin routes: `GET /admin/approvals?status=pending`, `POST /admin/approvals/:id/approve`, `POST /admin/approvals/:id/reject` (optional `{"reason": "..."}`); both return 409 if the request was already decided. The ledger records the request (`mcp.approval.requested`), the decision (`mcp.approval.decided`, reason `approved`, `rejected` or `expired`) and then the call, with the arguments hash only. A readable argument summary (500 characters max) is kept in the `approvals` table, never in the ledger.

## Administration

| Route | Role |
| --- | --- |
| `POST /admin/agents` | Create an agent and get its key. `dailyBudgetUsd` is required (a positive amount); an agent without a cap needs `"dailyBudgetUsd": 0, "unlimited": true` (400 otherwise) |
| `GET /admin/agents` | List agents, with today's spend (`spentTodayUsd`) |
| `PATCH /admin/agents/:id` | Update `name`, `allowedModels`, `dailyBudgetUsd` or `active` (404 if the agent does not exist) |
| `POST /admin/agents/:id/rotate-key` | Replace the key of an existing agent (same id, name, policy, budget and history). Returns `{ agent, key }` with the new key **once** and `Cache-Control: no-store`; the old key stops working immediately. Works on a disabled agent (its state is unchanged). Logs an `admin.agent.rotate-key` ledger row that contains neither the key nor its hash. 404 if the agent does not exist |
| `GET /admin/spend-check` | Reconciliation for the current UTC day: the agents whose spend counter (`agent_spend`, what the Agents page shows) differs from the sum of their ledger cost for that day, with both amounts (`spentUsd`, `ledgerUsd`). `divergences` is empty when everything agrees. Read-only |
| `GET /admin/stats?days=7` | Statistics from 1 to 90 days (7 by default), per UTC day and per agent: spend, allowed requests, refusals by reason, tokens |
| `GET /admin/ledger/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD` | Export the ledger to CSV (optional inclusive bounds, UTC days). Accepts the same filters as `GET /admin/ledger` (below) |
| `GET /admin/ledger?afterSeq=0&limit=100` | Read the ledger. Parameters: `afterSeq` and `beforeSeq` (exclusive bounds), `limit` (1000 max), `order=asc\|desc` (ascending by default; `order=desc&limit=100` returns the last 100 rows). Optional filters, combinable with each other, with the dates and with paging (AND): `agent` (agent id), `model` (exact model name), `verdict` (`allowed` or `denied`), `minCost` and `maxCost` (USD, inclusive, for example `0.25`), `from` and `to` (inclusive UTC days, `YYYY-MM-DD`). An invalid value (unknown verdict, negative or non-numeric cost, `minCost` above `maxCost`, a parameter given twice) is a 400; an empty parameter means no filter |
| `GET /admin/ledger/facets` | Agents (`id`, `name`) and models present in the ledger, to populate filter selectors |
| `GET /admin/ledger/export.ndjson` | Export sequence pages bounded by a captured head (see below) |
| `GET /admin/ledger/checkpoint` | Capture a checkpoint for external storage (see below) |
| `POST /admin/ledger/verify` | Verify the chain against an expected checkpoint supplied as the JSON body (see below) |
| `GET /admin/ledger/verify` | Verify the full integrity of the ledger (always the whole chain: filters are ignored) |

All `/admin` routes require `Authorization: Bearer <GARDAGENT_ADMIN_TOKEN>`.

**Admin actions are logged.** Creating an agent (`admin.agent.create`) and every update (`admin.agent.update`, with the list of changed fields in the reason, e.g. `active,dailyBudget`) add a row to the chain, with the affected agent, zero tokens and zero cost, and the fingerprint of the changed content. A patch that changes nothing writes nothing. These rows are excluded from statistics.

**CSV export.** UTF-8 file with BOM (opens directly in Excel), comma separator, CRLF line endings, cost in dollars with a dot decimal separator. Columns: seq, timestamp, agent, action, model, verdict, reason, input_tokens, output_tokens, cost_usd, request_hash, response_hash, entry_hash. Fields containing `,`, `"` or a line break are quoted, and text starting with `=`, `+`, `-` or `@` is prefixed with an apostrophe so a spreadsheet does not execute it as a formula. The ledger is read in 1000-row pages, not loaded as a single block.

```bash
curl -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN" -o ledger.csv \
  "http://localhost:8080/admin/ledger/export.csv?from=2026-10-01&to=2026-10-31"
```

Spend check: the Agents page reads the `agent_spend` counter while the dashboard sums the ledger, so a divergence would otherwise be invisible. `GET /admin/spend-check` compares both for the current UTC day with a single query (the ledger sum counts every row of the agent for that day; admin rows cost 0). Only the current day is checked, and nothing is repaired: the ledger is append-only and is the source of truth, so a divergence on a past day stays visible in the data and is not rewritten. Fixing a counter is a deliberate operator action, not something the gateway does.

## Console

The gateway serves an admin console (Vue 3) at **`/console/`**: with Docker, open http://localhost:8080/console/.
`GET /` redirects to `/console/`.

- **Login**: enter the value of `GARDAGENT_ADMIN_TOKEN`. The token stays in the tab's `sessionStorage`; “Log out” clears it.
- **Dashboard** (first tab): total spend, requests and refusals over 7 or 30 days, bar chart of daily spend stacked by agent (values on hover or touch, equivalent table below), refusals by reason. When the spend counter and the ledger disagree for today (UTC), a discreet banner (“Écart entre la dépense et le journal pour N agent(s) aujourd'hui”) lists the agents with both amounts; nothing is shown otherwise.
- **Ledger**: most recent actions at the top, refreshed every 10 seconds, 100 rows per page (“Load older”). Admin actions appear with a clear label (“Agent created”, “Agent updated: active, budget”). Filters by Agent, Model, Verdict (“All”, “Allowed”, “Denied”) and cost (min. / max., in USD) narrow the list; they are kept in the page URL (`?tab=ledger&verdict=denied&…`) so a filtered view can be shared or reloaded, and “Reset” clears them. The “Export to CSV” button downloads the ledger over a custom range (30 days by default) with the active filters applied.
- **Agents**: list with today's spend against budget (red bar beyond 80%), active/inactive toggle with confirmation before deactivation, editing of allowed models and budget, agent creation, and a “Renouveler la clé” action per agent (with a confirmation step). A key is shown only once, right after creation or rotation.
- **Integrity**: “Verify ledger” recomputes the whole fingerprint chain.

The console is served only if the built folder exists (variable `GARDAGENT_CONSOLE_DIR`, set in the Docker image).

### Console language

The console is available in French and English. The `FR | EN` switch in the header (and on the login screen) changes the language at once and the choice is kept in the browser (`localStorage`, key `gardagent.console.locale`). Without a saved choice, the browser language decides: French if it starts with `fr` or is missing, English otherwise. Texts come from `apps/console/src/i18n/fr.ts` and `en.ts`, which must have the same keys (checked by `vue-tsc` and by a test); data returned by the gateway (agent names, models, ledger values) is never translated. To add a string, add the key to `fr.ts` first, then to `en.ts`.

Development, with a gateway running on port 8080 (Vite proxies `/admin` to it):

```bash
pnpm install
pnpm dev:console      # http://localhost:5173/console/
pnpm --filter @gardagent/console build   # produces apps/console/dist
```


## Budget reservation and pass-through notes

- The budget is reserved atomically before each call and settled after it: an estimated cost (request size / 4 for input, plus `max_tokens`, `max_completion_tokens` or `GARDAGENT_DEFAULT_MAX_OUTPUT_TOKENS`, 1024 by default, for output) is held while the request is in flight, so concurrent or streaming requests cannot exceed the cap. The reservation is replaced by the real cost at the end (or released on error, abort or timeout) and expires on its own if the gateway crashes. `GET /admin/agents` exposes `reservedTodayUsd`. A budget of 0 means unlimited: agent creation requires an explicit positive `dailyBudgetUsd`, or `"dailyBudgetUsd": 0` together with `"unlimited": true` (a missing budget is a 400). `PATCH` still accepts 0; agents created before v0.3.0 keep whatever budget they have. The smallest positive budget is 0.000001 USD (1 micro-USD): a positive `dailyBudgetUsd` that would round to 0 (for example `0.0000001`) is refused with 400, on creation and on `PATCH`, so that a tiny budget can never turn into "no cap".
- On `/v1/messages`, the request body is forwarded as-is: provider-specific parameters are neither filtered nor validated. Cache tokens are counted at the price of ordinary input tokens.

### Ledger export and external checkpoints

All three endpoints require admin authentication. They preserve historical entry
fields and hashes; the checkpoint envelope version is independent of ledger entry
format versions.

- `GET /admin/ledger/checkpoint` returns
  `{ "format": "gardagent-checkpoint-v1", "sequence": 42, "head_hash": "<64 lowercase hex characters>", "created_at": "<ISO timestamp>" }`.
  The sequence and hash come from one committed head read. An empty ledger has
  sequence 0 and the genesis hash (64 zeroes). The timestamp records when the
  envelope was produced; it is not a signed timestamp.
- `GET /admin/ledger/export.ndjson` returns `application/x-ndjson`, with a metadata
  line followed by unmodified ledger entries in ascending sequence order. The first
  line is `{ "type": "metadata", "checkpoint": { ... }, "nextAfterSeq": 1000 }`.
  `limit` is an integer from 1 to 1000 (default 1000). `afterSeq` is exclusive and
  defaults to 0. The first page captures the committed head. To continue, supply
  `afterSeq=nextAfterSeq`, `headSequence=checkpoint.sequence` and
  `headHash=checkpoint.head_hash` from the first page; keep those same head values
  for every page. No entry beyond that head is returned even while writes continue.
  `nextAfterSeq: null` means complete, including an empty ledger or a cursor at the
  head. Each nonempty response ends with a newline. A continuation requires both
  head parameters; malformed bounds return 400 and a missing or changed anchor
  returns 409. No ledger filters apply. Keep the first page's checkpoint as the
  export anchor; later pages regenerate the envelope timestamp. The existing CSV
  endpoint is a separate display export and does not provide this protocol.
- `POST /admin/ledger/verify` accepts the complete checkpoint object directly as
  its JSON body. It verifies the current chain up to a head captured at request
  start and adds `checkpointContained` to the existing verification response.
  For example, `{ "valid": true, "checked": 45, "lastHash": "...",
  "checkpointContained": true }` means that the valid captured chain contains the
  expected sequence and hash. `valid: true, checkpointContained: false` means the
  chain is internally valid but does not contain the expected anchor (including
  truncation below it or replacement with a different valid chain). On an invalid
  chain, membership is reported as false because it could not be established in a
  valid full chain. Malformed or unsupported checkpoints return 400. The original
  `GET /admin/ledger/verify` remains available without an expected checkpoint.

Keep checkpoints **outside the database**, for example in a file on independent
storage or printed. Internal hash verification alone cannot detect tail truncation
or a complete valid rewrite. An externally retained checkpoint makes these changes
detectable relative to its sequence and hash. It does not protect later entries
that were never anchored, and it proves neither authorship nor a human identity.
Export consistency assumes append-only writes; privileged concurrent changes to
existing rows are outside the export consistency guarantee.
