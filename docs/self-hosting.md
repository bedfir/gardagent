# Self-hosting Gardagent

This guide is for operators who run Gardagent on their own Linux host. It complements [`deploy/README.md`](../deploy/README.md),
which documents every file of the deployment kit (Docker Compose stack, Caddy TLS edge, backup and rotation scripts).

## Prerequisites

- A Linux host (Ubuntu 24.04 or 26.04 LTS; the kit was exercised on 26.04 with 2 vCPU, 4 GB RAM, 20 GB disk).
- Docker Engine and Docker Compose from Docker's apt repository. After adding your user to the `docker` group, open a new
  session before continuing. For basic host hardening, see "Server preparation" in `deploy/README.md`.
- Outbound HTTPS access to your model provider.
- A copy of this repository on the host: a `git clone`, or an archive of a release (`git archive --format=tar.gz -o gardagent.tgz <tag>` on a machine that has the repository, then copy and unpack it). The archive contains no `deploy/.env`.

## Install

From the repository root:

```bash
sh deploy/install.sh
```

The script checks Docker and Docker Compose, creates `deploy/.env`, generates `GARDAGENT_ADMIN_TOKEN` and `POSTGRES_PASSWORD`
with `openssl rand -hex 32`, sets mode `600` and never prints the secrets.

Edit `deploy/.env` and set at least `UPSTREAM_API_KEY`, `GARDAGENT_DOMAIN` and `GARDAGENT_TLS`. Write each value raw (no
quotes, even for the JSON variables `GARDAGENT_PRICES` and `GARDAGENT_MCP_SERVERS`) and do not `source` the file in a shell.
Then start the stack and check its health:

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
docker compose -f deploy/docker-compose.prod.yml exec -T gateway wget -qO- http://127.0.0.1:8080/health
```

The gateway publishes no port; only Caddy listens (80 and 443).

## TLS: public domain or private network

| Situation | `GARDAGENT_DOMAIN` | `GARDAGENT_TLS` |
| --- | --- | --- |
| Public DNS name, ports 80/443 reachable | `gardagent.example.com` | `acme` (Let's Encrypt) |
| Private network, no inbound access from the Internet | host name or IP used by clients, or `localhost` | `internal` (Caddy local CA) |

With `internal`, clients must trust the Caddy root certificate:

```bash
docker compose -f deploy/docker-compose.prod.yml cp caddy:/data/caddy/pki/authorities/local/root.crt ./gardagent-root.crt
```

Base URLs then become `https://<GARDAGENT_DOMAIN>/v1` (OpenAI SDK) or `https://<GARDAGENT_DOMAIN>` (Anthropic SDK).

## Restrict administration access

`/admin/*` and `/console/*` answer 403 unless the source address is within `GARDAGENT_ADMIN_ALLOWED_CIDRS` (default: the
private ranges and `127.0.0.1/32`). Narrow it to your administrators' subnet, then run
`docker compose -f deploy/docker-compose.prod.yml up -d`. Agent traffic (`/v1/*`) is not affected. Optional [per-agent admission and concurrency limits](rate-limits.md)
are configured through the agent API; they default to unlimited and reset on restart. If the administrator is outside the allowed ranges, use an SSH
tunnel as described in `deploy/README.md`.

The restriction is enforced by Caddy, not by the gateway application, which does no source-address filtering of its own. The
gateway therefore never publishes a port in `deploy/docker-compose.prod.yml` (only Caddy does). If you run the gateway outside
this stack and it listens beyond loopback without `GARDAGENT_ADMIN_ALLOWED_CIDRS` set, it logs a startup warning: publish its
port on `127.0.0.1` only or put a filtering reverse proxy in front of it. `GARDAGENT_ADMIN_TOKEN` must be at least 32 characters
(the installer generates 64); a shorter value stops the gateway at startup.

## Failed authentication limits

The gateway counts failed authentications per source address, separately for the admin token (`/admin/*`) and for agent keys
(`/v1/*`, `/mcp/*`). After `GARDAGENT_AUTH_FAIL_LIMIT` failures (default 10; `0` disables the limit) inside `GARDAGENT_AUTH_FAIL_WINDOW_MS` (default
60000 ms) the address gets HTTP 429 with a `Retry-After` header until the window ends, before the
request body is read. Other addresses are unaffected; note that a blocked address is blocked for every key, valid or not, until
the window ends. Counters live in the process memory (reset on restart, not shared between instances).

The address is the one Fastify sees. `deploy/docker-compose.prod.yml` sets `GARDAGENT_TRUST_PROXY=true`, which is correct
because Caddy is the only way to reach the gateway and overwrites `X-Forwarded-For`; without it every client would share
Caddy's address and one attacker could lock out everybody. If you run another proxy, set `GARDAGENT_TRUST_PROXY` to its
address or CIDR list (never `true` if the gateway port is reachable directly: the header would be spoofable). The default is
`false` (socket address).

To keep the ledger readable, the first failed agent-key authentication of an address in a window is written as an
`invalid_key` row; the following ones are only counted and written as one `invalid_key_repeated:<count>` row (action
`auth.invalid_key`) when the window ends, on the next failure, or at shutdown. Requests on `/v1/*` and `/mcp/*` that carry no
well-formed agent key may send at most 64 KiB of body (HTTP 413 above); a well-formed but wrong key is still read in full (up to
10 MiB) until the per-address limit above applies.

To test the limit yourself, send more than `GARDAGENT_AUTH_FAIL_LIMIT` wrong admin tokens from an address that is allowed to reach `/admin/*`
(for example on the server, with `curl --resolve <GARDAGENT_DOMAIN>:443:127.0.0.1 https://<GARDAGENT_DOMAIN>/admin/agents`). From a
disallowed address Caddy answers 403 before the gateway sees the request, so no failure is counted. The 11th failure gets 429 with
`Retry-After: 60`; wait for the window to end before using the admin token again from the same address.

## Create agents

Create one agent per tool or workload:

```bash
export ADMIN_TOKEN=$(sed -n 's/^GARDAGENT_ADMIN_TOKEN=//p' deploy/.env | head -n 1)

curl -X POST https://<GARDAGENT_DOMAIN>/admin/agents \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"agent-support","allowedModels":["deepseek-v4.1-flash"],"dailyBudgetUsd":2}'
```

The response contains the agent key (`ga_...`). It is shown only once: store it in a password manager.

## Point your tools at the gateway

Change two settings in each tool: the base URL and the API key.

```python
from openai import OpenAI

client = OpenAI(base_url="https://gateway.example.test/v1", api_key="ga_...")
client.chat.completions.create(model="deepseek-v4.1-flash", messages=[{"role": "user", "content": "Hello"}])
```

The Anthropic SDK adds `/v1/messages` itself, so leave `/v1` out of its `base_url`:

```python
from anthropic import Anthropic

client = Anthropic(base_url="https://gateway.example.test", api_key="ga_...")
client.messages.create(model="minimax-m3", max_tokens=256, messages=[{"role": "user", "content": "Hello"}])
```

## Observe mode

To measure policy violations without enforcing those policy limits, start the gateway with `GARDAGENT_MODE=observe` in
`deploy/.env`. Requests that would be denied are forwarded and logged with a reason prefixed by `observed:`. Invalid agent keys
are still rejected in both modes. Malformed MCP framing and durable approval-state outage refusals also remain blocking.

## Routine checks

```bash
docker compose -f deploy/docker-compose.prod.yml ps
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<GARDAGENT_DOMAIN>/admin/ledger/verify
curl -H "Authorization: Bearer $ADMIN_TOKEN" -o ledger.csv \
  "https://<GARDAGENT_DOMAIN>/admin/ledger/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD"
```

To check which version is running, read the package version inside the image (the gateway also sends `User-Agent: Gardagent/<version>` to the provider):

```bash
docker compose -f deploy/docker-compose.prod.yml exec -T gateway grep '"version"' /app/package.json
```

`/admin/ledger/verify` must report a valid chain; if it does not, treat it as an integrity incident and investigate before
continuing. `pnpm report` generates a Markdown usage report (summary, agents and spend, denied requests by reason, notes, ledger integrity) from the admin API; see the README.

## Secrets, backups and removal

- Rotate the admin token with `sh deploy/rotate-admin-token.sh`; rotate an agent key with `POST /admin/agents/:id/rotate-key`
  (see `deploy/rotate-agent-key.md`).
- Back up the database with `sh deploy/backup.sh` (the 14 most recent dumps are kept in `deploy/backups/`); restore with
  `sh deploy/restore.sh`. A nightly cron entry is shown in `deploy/README.md`.
- To remove an installation completely, export or back up the ledger first (removal is irreversible), then run
  `docker compose -f deploy/docker-compose.prod.yml down -v` and `rm -f deploy/.env`.

See [the 0.3.0-to-v1 upgrade guide](upgrade-0.3-to-1.0.md) for matched database/spool backups, named operators,
MCP changes, rate limits and restore. The convenience restore script does not make SQL errors fatal, select
the matching executable or restore the spool; use the explicit isolated recovery procedure for upgrade rehearsal.

## Database upgrades

Stop the gateway and take a database backup before upgrading. Keep the matching executable with the backup.
Startup applies ordered migrations under a PostgreSQL advisory lock, before listening. Each migration and its version
record commit together. A failure reports the migration number and reason; earlier committed versions remain intact.
Fix the reported cause and restart. Do not edit `schema_migrations` to bypass a failure.

A complete 0.3.0 database is adopted as migration version 1; subsequent steps add ledger metadata, policy revisions,
operators and optional rate limits. Existing ledger rows, hashes, spend and the append-only trigger are untouched. Incomplete unversioned schemas are refused rather than repaired. A database newer than the executable is
also refused. For rollback, stop the gateway and restore the pre-upgrade backup with its matching executable; there
are no automatic down migrations. Verify `/admin/ledger/verify` after an upgrade or restore, and compare spend with
the pre-upgrade record. Versioned restarts do not rebuild application indexes or replace triggers.

Only one migration process can proceed at a time. Fresh installations build ordinary indexes inside their migration
transaction; future migrations may also require blocking DDL. Lock waits have no fixed duration. See
[`migration-timing.md`](migration-timing.md) for historical measurements and current limits.
