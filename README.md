Version française : [README.fr.md](README.fr.md)

# Gardagent

[![CI](https://github.com/bedfir/gardagent/actions/workflows/ci.yml/badge.svg)](https://github.com/bedfir/gardagent/actions/workflows/ci.yml)

Gardagent is a self-hosted governance gateway that sits between your AI agents and their model providers and MCP servers,
and applies per-agent identity, rules, budgets and a tamper-evident log to every call.

## Why

AI agents usually share one provider key, and nothing records or limits what each of them does. Gardagent gives each agent
its own key, holds the real provider key itself, enforces which models and tools an agent may use and how much it may spend
per day, and writes every action to a hash-chained, append-only ledger. You change the base URL and the key in the agent's
configuration; the agent's code does not change.

## Features

- **One identity per agent**: each agent has its own `ga_...` key; the real provider key stays inside the gateway.
- **Atomic daily budgets**: the budget is reserved before each call and settled after it, so concurrent and streaming
  requests cannot exceed the cap.
- **Human approval of MCP tools**: tools that write, or that you list, wait for an administrator's decision before they run.
- **Append-only, hash-chained ledger**: every action is recorded with SHA-256 fingerprints (not content); the database
  rejects updates and deletes, and an endpoint verifies the whole chain.
- **`observe` and `enforce` modes**: measure what the rules would block before blocking it.
- **OpenAI and Anthropic compatibility**: `POST /v1/chat/completions` and `POST /v1/messages`, streaming included.
- **MCP proxy**: governs `tools/call` on Streamable HTTP MCP servers, without exposing their credentials to agents.
- **Admin API and console** (Vue 3, French and English): agents, spend, ledger browsing and filtering, CSV export, integrity check.

## Quick start (about 5 minutes)

Requirements: Docker with Compose, `git`, `curl`, and an API key for an OpenAI-compatible provider (or any server that
speaks that API).

**1. Get the code and create your configuration.**

```bash
git clone https://github.com/bedfir/gardagent.git
cd gardagent
cp .env.example .env
# Generate the admin token and the database password:
sed -i "s|^GARDAGENT_ADMIN_TOKEN=.*|GARDAGENT_ADMIN_TOKEN=$(openssl rand -hex 32)|; s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 16)|" .env
```

Then edit `.env` and set `UPSTREAM_BASE_URL` and `UPSTREAM_API_KEY` for your provider. Base URLs are written without
`/v1`: the gateway appends `/v1/chat/completions` and `/v1/messages`. If you do not use the Anthropic endpoint you can
leave `ANTHROPIC_UPSTREAM_BASE_URL` as it is. Add a price for the models you use in `GARDAGENT_PRICES` (USD per million
tokens); unknown models are priced at a deliberately high fallback so that budgets stay conservative.

**2. Start the gateway and PostgreSQL.**

```bash
docker compose up -d --build
curl http://127.0.0.1:8080/health
```

The root `docker-compose.yml` publishes the gateway on `127.0.0.1:8080` only, so `/admin` and `/console` are not
reachable from the network. Do not change that to `8080:8080` on a shared machine; for a networked deployment use the
[`deploy/` kit](deploy/README.md). `/health` must answer `"status":"ok"` and `"database":"up"`.

**3. Create an agent.** A daily budget is mandatory: `dailyBudgetUsd` must be a positive number. An agent with no cap needs
an explicit `"dailyBudgetUsd": 0, "unlimited": true`; without a budget the request is refused with 400.

```bash
export GARDAGENT_ADMIN_TOKEN=$(sed -n 's/^GARDAGENT_ADMIN_TOKEN=//p' .env)

curl -s -X POST http://127.0.0.1:8080/admin/agents \
  -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo-agent","allowedModels":["deepseek-v4.1-flash"],"dailyBudgetUsd":2}'
```

Use a model name your provider serves. The response contains the agent key (`ga_...`) in `key`. **It is shown only
once**; copy it now.

**4. Call the gateway with any OpenAI-compatible client.**

```bash
export GA_KEY=ga_...   # the key from step 3

curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $GA_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"Hello"}]}'
```

With the OpenAI Python SDK, only the base URL and the key change:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="ga_...")
client.chat.completions.create(model="deepseek-v4.1-flash", messages=[{"role": "user", "content": "Hello"}])
```

For the Anthropic SDK use `base_url="http://127.0.0.1:8080"` (the SDK appends `/v1/messages` itself).

**5. Read the ledger and open the console.**

```bash
curl -s "http://127.0.0.1:8080/admin/ledger?order=desc&limit=5" -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN"
curl -s http://127.0.0.1:8080/admin/ledger/verify -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN"
```

`verify` answers `{"valid":true,...}` when the whole chain is intact. Costs in ledger rows are in micro-USD. The console is
at <http://127.0.0.1:8080/console/>: log in with the value of `GARDAGENT_ADMIN_TOKEN`. A request for a model that is not
in `allowedModels` is refused with 403 `model_not_allowed` and the refusal is logged too.

To stop everything: `docker compose down` (add `-v` to also delete the database and the ledger).

### Published image

When a release is published, its image is available from the GitHub Container Registry:

```bash
docker pull ghcr.io/bedfir/gardagent:<version>   # for example 0.3.0, or "latest"
```

This works only after the first release has been published by the release workflow; until then, build from source as
above. The image contains the gateway and the console and needs a PostgreSQL database (`DATABASE_URL`); the Compose files
in this repository build the image from the `Dockerfile` and are the supported way to run it.

### Usage report

`pnpm report` reads the admin API and writes a Markdown usage report: a summary of the period, the agents with their
allowed models, MCP tools, daily budget and spend, denied requests by reason, what observe mode would have blocked, a few
configuration notes (wildcards, missing budgets, budget nearly used, invalid-key traffic, ledger integrity) and a short
scope statement. It only reads data; it changes nothing and never prints the admin token.

```bash
pnpm install && pnpm build
export GARDAGENT_ADMIN_TOKEN=...   # the same token as the gateway
pnpm report --url http://127.0.0.1:8080 --days 7 --out report.md   # --days: 1 to 90
```

## Configuration

Configuration is read from environment variables (in the Compose files, from `.env`). Only `UPSTREAM_BASE_URL`,
`UPSTREAM_API_KEY` and `GARDAGENT_ADMIN_TOKEN` are required. Invalid values stop the gateway at startup with an explicit
message. The detailed behavior of each group is described in [docs/reference.md](docs/reference.md).

| Variable | Default | Description |
| --- | --- | --- |
| `UPSTREAM_BASE_URL` | required | OpenAI-compatible provider URL, without the trailing `/v1`. |
| `UPSTREAM_API_KEY` | required | Provider key; it never leaves the gateway. |
| `ANTHROPIC_UPSTREAM_BASE_URL` | `UPSTREAM_BASE_URL` | Provider URL for `POST /v1/messages`, without `/v1`. |
| `ANTHROPIC_UPSTREAM_API_KEY` | `UPSTREAM_API_KEY` | Provider key for the Anthropic endpoint. |
| `UPSTREAM_FORWARD_HEADERS` | `x-opencode-session` | Comma-separated client headers forwarded to the provider. `authorization`, `x-api-key`, `cookie`, `host`, `content-length`, `content-type` and hop-by-hop headers are never forwarded. |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Maximum duration of a provider call. |
| `GARDAGENT_ADMIN_TOKEN` | required | Token for `/admin/*` and the console. At least 32 characters (`openssl rand -hex 32`); shorter values are refused at startup. |
| `DATABASE_URL` | none | PostgreSQL URL. Without it the gateway uses in-memory storage, lost on shutdown (demos and tests only). The Compose files set it. |
| `GARDAGENT_MODE` | `enforce` | `enforce` blocks policy violations; `observe` forwards them and logs `observed:<reason>`. |
| `GARDAGENT_MCP_SERVERS` | none | JSON object of governed MCP servers: `{"name":{"url":"...","headers":{},"readTools":[]}}`. Without it the `/mcp` route does not exist. |
| `GARDAGENT_PRICES` | built-in indicative table | JSON object of prices in USD per million tokens: `{"model":{"input":0.15,"output":0.6}}`. Models not listed use a fallback of 10 / 30. |
| `GARDAGENT_DEFAULT_MAX_OUTPUT_TOKENS` | `1024` | Output tokens assumed in the budget reservation when a request sets no maximum. |
| `GARDAGENT_APPROVAL_TIMEOUT_MS` | `120000` | How long a tool call waits for a human decision before it expires. |
| `GARDAGENT_DB_OUTAGE` | `fail-closed` | `fail-closed` or `fail-open`. Fail-open is honored only with `GARDAGENT_MODE=observe`. |
| `GARDAGENT_LEDGER_SPOOL` | `/app/spool/ledger.jsonl` | Spool file for ledger rows the database could not take. |
| `GARDAGENT_SPOOL_MAX_BYTES` | `67108864` | Size cap of the spool file (minimum 4096). |
| `GARDAGENT_DB_CALL_TIMEOUT_MS` | `600` | Bound on a database call on the request path (50 to 60000). |
| `GARDAGENT_DB_PROBE_TIMEOUT_MS` | `800` | Bound on the health probe (50 to 60000). |
| `GARDAGENT_DB_CONNECT_TIMEOUT_MS` | `2000` | Bound on the wait for a pooled connection (50 to 60000). |
| `GARDAGENT_AGENT_CACHE_TTL_MS` | `30000` | Lifetime of a cached agent during a fail-open outage (1000 to 600000). |
| `GARDAGENT_AUTH_FAIL_LIMIT` | `10` | Failed authentications per source address and window before HTTP 429; `0` disables the limit. |
| `GARDAGENT_AUTH_FAIL_WINDOW_MS` | `60000` | Length of the failure-counting window (1000 to 3600000). |
| `GARDAGENT_TRUST_PROXY` | `false` | How the client address is derived from `X-Forwarded-For`: `true`, `false`, or a comma-separated list of proxy addresses or CIDRs. Set `true` only when a reverse proxy that overwrites the header is the sole way to reach the gateway. |
| `GARDAGENT_ADMIN_ALLOWED_CIDRS` | none | Not enforced by the application. Used by the Caddy proxy of `deploy/`; when the gateway listens beyond loopback and this is unset, the application only logs a startup warning. |
| `GARDAGENT_CONSOLE_DIR` | set in the image | Directory of the built console; the console is served only if it exists. |
| `PORT` | `8080` | Listening port. |
| `HOST` | `0.0.0.0` | Listening address (inside Docker it must be `0.0.0.0`; the root Compose file publishes the port on `127.0.0.1` only). |
| `POSTGRES_PASSWORD` | required by Compose | Password of the bundled database (Compose only). |

The `deploy/` stack adds `GARDAGENT_DOMAIN`, `GARDAGENT_TLS` and `GARDAGENT_ADMIN_ALLOWED_CIDRS` for its Caddy proxy; see
[deploy/README.md](deploy/README.md).

## Architecture

```text
 agent (OpenAI / Anthropic SDK, MCP client)           administrator
        |  ga_... key                                      |  admin token
        v                                                  v
 +--------------------------------------------------------------------+
 |  Gardagent gateway (Fastify)                                       |
 |  /v1/chat/completions  /v1/messages  /mcp/<server>   /admin  /console
 |    identify agent -> rules (models, tools) -> approval (MCP)       |
 |    -> reserve budget -> forward -> settle budget -> ledger row     |
 +---------+------------------------+------------------+--------------+
           |                        |                  |
           v                        v                  v
     model provider(s)        MCP server(s)        PostgreSQL
     (real key held here)     (headers held here)  agents, budgets, approvals,
                                                    append-only hash-chained ledger
```

The gateway is a single Node.js process. The real provider key and the MCP server headers exist only in its
configuration.

## Security model

What Gardagent is designed to guarantee, for traffic that goes through it:

- Agents never see the provider key or the MCP server credentials; each agent has its own revocable key (disabling an
  agent or rotating its key takes effect at once).
- A request is refused unless the agent is active and the model is in its allow-list; an MCP `tools/call` is refused unless
  the tool is in the agent's `allowedTools`. Write tools wait for human approval.
- Daily budgets are reserved atomically before the call, so concurrent or streaming requests cannot exceed the cap.
- Every governed action, and every administrative change, is recorded in an append-only ledger that the database refuses
  to update or delete, hash-chained so that `GET /admin/ledger/verify` detects a modified or removed row. The ledger stores
  fingerprints of requests and responses, not their content.
- By default, if the ledger cannot be written the request is refused (fail-closed); it is not served without a trace.
- The admin token must be at least 32 characters, and failed authentications are rate-limited per source address.

What it does **not** guarantee:

- It is not a sandbox and does not inspect prompt or tool-argument content (no content filtering, no defense against
  prompt injection). Anything an agent is allowed to do, it can do.
- It only governs traffic that passes through it. An agent that can reach a provider or an MCP server directly can bypass it.
- The chain is tamper-evident, not tamper-proof: someone with administrative access to the database can still alter it, and
  the chain head is not anchored outside the database, so a full rewrite would verify as valid.
- Costs are computed from the usage reported by the provider and the prices you configure; they are not the provider's invoice.
- There is a single shared admin token: no users, roles or per-administrator audit trail.
- The root Compose file serves plain HTTP on loopback. TLS and an administration allow-list come from the `deploy/` stack.
- It is not a functional-safety system and must not be used in a safety loop (see [docs/industrial-setup.md](docs/industrial-setup.md)).

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Known limitations

- MCP governance covers `tools/call` only. Every other JSON-RPC method on `/mcp/<server>` (`resources/read`,
  `resources/list`, `prompts/get`, `initialize`, ...) is relayed with no rule check and no ledger row. Only the Streamable
  HTTP transport is supported, and JSON-RPC batches are rejected.
- There is no per-agent rate limiting; only daily budgets cap an agent. Other protocols (for example A2A) are not supported.
- Schema migrations run at startup, in one transaction, without `CONCURRENTLY`: the gateway serves no traffic while they
  run, and index builds block writes. Measurements on a large ledger are in [docs/migration-timing.md](docs/migration-timing.md).
- The failed-authentication limiter lives in the memory of one process: counters reset on restart and are not shared between
  gateway instances.
- A request carrying a well-formed but wrong agent key is read in full (up to 10 MiB) before it is rejected, until the
  per-address limit applies; requests without a well-formed key are limited to 64 KiB.
- Budget costs are estimated before the call (request size / 4 for input plus the output cap) and settled with the
  provider's reported usage afterwards. On `/v1/messages` the body is forwarded as-is, and cache tokens are counted at the
  price of ordinary input tokens.
- During a database outage, refusals that need the database leave no ledger row, and in `fail-open` mode the daily cap is
  not enforced.
- The admin console has no Content-Security-Policy header, and its default language follows the browser (French or English).
- `docker-compose.tailscale.yml` (private access through Tailscale) has not been tested.
- Gardagent has not been used in production by the maintainers; see Status.

## Documentation

- [docs/README.md](docs/README.md): index of the documentation
- [docs/self-hosting.md](docs/self-hosting.md) and [deploy/README.md](deploy/README.md): running Gardagent on your own host
- [docs/reference.md](docs/reference.md): MCP governance, modes, outage handling, approvals, admin API, console
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [CHANGELOG.md](CHANGELOG.md) and [LICENSE](LICENSE) (Apache License 2.0)

## Status

Gardagent is young software. The test suite is extensive and the gateway has been exercised end to end on a test server
with test traffic (reports in [docs/](docs/README.md)), but it has not been through production use or an independent
security review. Interfaces and configuration may change between releases; read the [CHANGELOG](CHANGELOG.md) before
upgrading. Bug reports, questions and contributions are welcome.
