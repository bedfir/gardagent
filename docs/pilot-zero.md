# End-to-end validation harness ("pilot zero")

The setup and criteria below describe the harness; dated rounds are historical
observations, not current acceptance results. See [v1 readiness](v1-readiness.md)
for current evidence and gaps. Only humans run real-provider scenarios.

## Goal

The end-to-end validation (historically called "pilot zero") checks that Gardagent behaves as documented when it runs with
real traffic, as in production, against the written acceptance criteria below. Real traffic means (1) developer agents
(OpenCode) going through the gateway every night, and (2) a test harness that exercises the criteria against the real
gateway, the real PostgreSQL and the real provider (OpenCode Go, EU-region models). Real model spend for a round is capped
at 1 USD. The harness lives in `tools/pilot-zero` and its environment variables keep the `PZ_` prefix.

## Setup

- Gateway and PostgreSQL: `docker compose up -d` (project `gardagent`, network `gardagent_default`, port 8080).
  After any code change rebuild without the cache (`docker compose build --no-cache gateway`) and check that
  `curl -s localhost:8080/health` contains `"mode"`.
- Agents (created through the admin API, keys stored outside git in `~/.ga-oc/secrets/`, mode 600):
  `opencode-dev` (models kimi-k2.7-code and glm-5.2, 2 USD/day) for developer traffic, `pilot-zero` (0.05 USD/day)
  for the harness. The harness creates its own short-lived agents (`pilot-zero-cap-*`, `pilot-zero-chaos-*`,
  `pilot-zero-mcp-*`).
- MCP: the reference server `@modelcontextprotocol/server-everything` in streamable HTTP mode, container
  `ga-mcp-everything` (no secret), declared in `.env` as
  `GARDAGENT_MCP_SERVERS={"everything":{"url":"http://ga-mcp-everything:3001/mcp","headers":{},"readTools":["echo"]}}`.
- The provider requires an `x-opencode-session` header; the gateway forwards it, the harness sends it on both paths.
- Run a round: `sh tools/pilot-zero/run-round.sh` (about 6 minutes). It runs `run.mjs` (criteria a-g, i) in
  `node:22-alpine` on the compose network, then `backup-restore.sh` (h) and `latency-stub.sh` (e, p95 gate).
  `run.mjs` needs the Docker socket to restart the gateway and PostgreSQL during traffic.

### Running the harness on a fresh `deploy/` install

`run-round.sh` reads the key of the long-lived `pilot-zero` agent from `$PZ_KEY_FILE` (default `~/.ga-oc/secrets/pilot-zero.key`).
On a new installation that agent does not exist yet: create it once with the admin API (the budget is mandatory since 0.3.0), store the
returned `ga_...` key in that file (mode 600, outside git, never printed), then run the round with the production-like variables from the
header of `run-round.sh`:

```sh
curl -X POST https://<GARDAGENT_DOMAIN>/admin/agents -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"pilot-zero","allowedModels":["mimo-v2.6-flash"],"dailyBudgetUsd":0.05}'
export PZ_ENV_FILE=deploy/.env PZ_COMPOSE_FILE=deploy/docker-compose.prod.yml PZ_NETWORK=deploy_backend PZ_HARNESS_NETWORK=deploy_edge \
  PZ_GATEWAY_IMAGE=deploy-gateway GW_CONTAINER=deploy-gateway-1 PG_CONTAINER=deploy-postgres-1 PZ_PAIRS=60 PZ_F_SAMPLES=5
sh tools/pilot-zero/run-round.sh
```

The harness prints its results only when it finishes (about 12 to 15 minutes with the defaults) and creates then deactivates its own
`pilot-zero-*` agents.

### Developer traffic through Gardagent (dogfooding)

OpenCode config with the `gardagent` provider (`@ai-sdk/openai-compatible`, baseURL `http://gateway:8080/v1`, agent
key inside): `<home>/.ga-oc/config-gw/opencode/opencode.json` (outside git, mode 600; its `permission` block is a
copy of the one in `<home>/.ga-oc/config`). Launch every OpenCode task like this:

```sh
docker run --rm --network gardagent_default \
  -v <home>/.ga-oc/data:/root/.local/share \
  -v <home>/.ga-oc/config-gw:/root/.config \
  -v "$WORKDIR":/work -w /work ga-opencode:1.19.3 \
  sh -c "opencode run --dir /work '<task text>'"
```

Check usage with `GET /admin/stats` (agent `opencode-dev`). Verified on 2026-10-21: "create hello.txt containing hi"
produced ledger entries for `opencode-dev` (kimi-k2.7-code, 6119 and 6031 prompt tokens, cost 0.0059 and 0.0060 USD).

## Acceptance criteria

| Id | Criterion | Measure |
|----|-----------|---------|
| a | Ledger chain valid after every test | `/admin/ledger/verify` returns `valid: true` after each test step |
| b | Zero missing ledger entries | every acknowledged successful request (matched by agent and request hash) appears in the ledger |
| c | Cost accuracy | per-request, ledger cost within +/-10% of the cost computed from the provider's returned token usage and the price table |
| d | Budget never exceeded | with a tiny daily budget and 20 concurrent plus 10 sequential real streaming requests, ledger spend stays under the budget, some requests are refused (429), no reservation is left over |
| e | Gateway overhead | p95 overhead under 100 ms, measured against a stub upstream (at least 300 pairs, `latency-stub.sh`). This isolates the gateway's own cost. The comparison against the real provider stays in the harness as an informational measurement (median, reported, never pass/fail) because provider jitter (seconds) makes it meaningless as a gate |
| f | Streaming identical | 6 prompts at temperature 0, each sent N times directly and N times through the gateway (N = `PZ_F_SAMPLES`, default 5, 1 to 25, alternating direct/gateway). The outcome of a sample is its content plus finish_reason. A side has a majority outcome when strictly more than half of its N samples (failed calls count against) share it. No direct majority: the provider is not deterministic on that prompt and the prompt is left out. Otherwise the prompt passes if both majority outcomes are equal; a gateway side without a majority, or a different one, fails. The gateway streams must end with `[DONE]` on a majority of samples. The criterion passes if at least 3 prompts are determined, all of them pass, and all of them end with `[DONE]`. The report lists the outcome counts and every sample of a failing prompt. Logic and tests: `tools/pilot-zero/pairing.mjs`, `pairing.selftest.mjs`. Cost: 6 x 2 x N streaming calls (60 with the default), instead of 18 with the former single pair |
| g | Restarts | restarting the gateway, then PostgreSQL, during traffic: every acknowledged (HTTP 200) request is in the ledger, failures are classified by cause/status/code, the chain stays valid, no reservations remain and spend matches ledger costs; the gateway serves again by itself within 60 s. The strict reservation check may fail before TTL cleanup; see [M01](design/M01.md). |
| h | Backup and restore | `pg_dump` then restore (same logic as `deploy/backup.sh` / `restore.sh`, into a scratch database served by a second gateway) yields a valid ledger with the same head hash |
| i | MCP | real server behind `/mcp/everything`: allowed read tool (`echo`), denied tool (`get-env`), approval-required tool (`get-sum`) approved and rejected through the admin API; all ledgered |

## Round 1 - 2026-10-21

Environment: gateway rebuilt with `--no-cache` (commit 361299d, `/health` returns `"mode":"enforce"`), model
`mimo-v2.6-flash` for the harness. Real spend of the whole night (developer test plus all rounds), from the gateway
ledger: about 0.0157 USD. Ledger at the end: 365 entries, chain valid.

| Id | Result | Evidence |
|----|--------|----------|
| a | PASS | chain valid after each of 7 checkpoints (traffic, latency, stream, budget, chaos, mcp, final) |
| b | PASS | 84 gateway requests answered, 0 missing from the ledger |
| c | PASS | 59 matched calls, token counts identical, ledger 0.001085 USD vs 0.001059 USD from provider usage (ratio 1.025) |
| d | PASS | budget 0.0008 USD, ledger spend 0.000729 USD (91%), 11 admitted, 19 refused (429), 0 leftover reservation |
| e | PASS (stub), see note | stub: direct p95 26.2 ms, gateway p95 53.9 ms, overhead p95 27.7 ms (an earlier run gave 65.2 ms), median 24 ms. Real provider: 24 pairs, median difference -489 ms, p95 difference +381 ms (provider jitter) |
| f | PASS | 6/6 deterministic pairs identical (content and finish_reason), all gateway streams end with `[DONE]`. First attempt with max_tokens 40 failed because the reasoning model sometimes spent all tokens on reasoning (provider non-determinism), not a gateway difference |
| g | FAIL | restart sequence worked for the gateway (back in 2.3 s) but PostgreSQL restart killed the gateway process permanently (bug 1). 330 requests, 77 acknowledged and all present in the ledger, 249 connection failures during the outage, chain valid |
| h | PASS | 353 entries restored, valid, same head hash |
| i | PASS | 11/11 checks (tools/list 16 tools; allowed, denied, approved, rejected; approval requested and decided rows; rejected call never forwarded) |

Note on (e): the criterion cannot be proven against the real provider with 24 pairs; the stub measurement is the
gate and the real-provider median is a sanity check.

### Bugs and risks found (not fixed tonight)

1. **Gateway dies when PostgreSQL restarts (blocking, criterion g).** `docker logs gardagent-gateway-1` shows
   `error: terminating connection due to administrator command` thrown as an unhandled `'error'` event; the process
   exits with code 1. `apps/gateway/src/pg-store.ts:184` creates `new pg.Pool(...)` without `pool.on("error", ...)`.
   In addition `docker-compose.yml` has no `restart:` policy (inspect shows `restart=no`), so the outage lasts until a
   human starts the container. Fix: add the pool error handler (log, no exit) and `restart: unless-stopped`
   (also check `deploy/docker-compose.prod.yml`).
2. **Ledger write failures are swallowed.** `record()` in `apps/gateway/src/shared.ts` catches and only logs; if the
   database is unavailable at settlement time a client can get a 200 without a ledger entry. Not observed in round 1
   (0 acknowledged requests missing) but the code path exists; it should be failed loudly or queued.
3. **`deploy/restore.sh` verification step only checks that the HTTP call succeeds**, not that the answer contains
   `"valid":true`.
4. **Aborted streams are recorded with zero tokens and zero cost** (ledger seq 9, `client_aborted`, agent
   opencode-dev) although the provider may have billed prompt tokens. Cost is under-recorded for aborted calls.
5. **Usage chunk:** the provider always sends a final usage-only chunk; the gateway drops it when the client did not
   ask for `stream_options.include_usage`, so the chunk count differs from a direct call by one. Content is identical.
6. **Stale Docker image:** the running container was built on 2026-10-20 14:39 and lacked observe mode although
   `docker compose up -d --build gateway` reported all layers cached. The `--no-cache` build fixed it; the root cause
   was not isolated (no wrong build context or tag was found: same project, same context, same tag). Always verify
   `/health` contains `"mode"` after a build.

## Round 2 — 2026-10-21

Gateway rebuilt with `docker compose build --no-cache gateway` from commit 6725e04 (`/health` shows `"mode"`),
then `sh tools/pilot-zero/run-round.sh`. Unit suite: 258 passed (15 files, with PostgreSQL).

Fixes tested in this round: pool error handler and `/health` 503 when the database is down (bug 1); `restart:
unless-stopped` on gateway and postgres; ledger retry (3 attempts) then append-only spool
(`GARDAGENT_LEDGER_SPOOL`, volume `ledger_spool`) replayed in order, fail closed with 503 while the ledger is
unavailable (bug 2); `restore.sh` requires `"valid":true` (bug 3, covered by review only, not run live); aborted
streams without usage recorded at the reserved estimate, reason `client_aborted_estimated` (bug 4). Bug 5 left as is.

| Criterion | Result | Numbers |
|---|---|---|
| a | PASS | chain valid after each of 7 checks |
| b | PASS | 120 requests answered, 0 missing from ledger |
| c | PASS | ledger cost 0.001272 USD vs provider usage 0.001213 USD, 95 calls, 0 token mismatches (ratio 1.049) |
| d | PASS | budget 0.0008 USD, spend 0.000739 (92%), 11 admitted, 19 refused (429), 0 leftover reservations |
| e | PASS (see note) | real provider, 60 alternating pairs: direct p50/p95 1501/2988 ms, gateway 1590/3304 ms, median overhead 89 ms, p95 difference 316 ms (noise). Stub upstream (20 ms), 300 pairs: median overhead 24.3 ms, p95 overhead 29.3 ms |
| f | PASS | 6/6 identical content and finish_reason, all streams end with [DONE] |
| g | PASS | gateway back in 2215 ms after its own restart; after the PostgreSQL restart the gateway recovered by itself in 581 ms; 334 requests, 109 acknowledged, 0 missing from ledger, 222 connection failures (never acknowledged), 3 other HTTP errors, chain valid (596 entries) |
| h | PASS | 604 entries restored, valid, same head hash |
| i | PASS | 11/11 checks, 16 tools |

Notes. (e): the gate (p95 < 100 ms) is only met on the stub; against the real provider the p95 is dominated by
provider jitter (about 1 s) and cannot be proven, and the median difference of 89 ms is close to the threshold
and within noise. The real-provider run is a sanity check, not proof. (g): the 3 "other HTTP errors" were not
broken down; the 109 acknowledged requests are all in the ledger. Real spend recorded by the gateway in the round:
0.002118 USD. Ledger head after the round: 7c4d4d5082dcb1cac75f8a069a55cb8f206ca20b09c394391f79c5738f2c8bec
(604 entries).

## Round 3 — 2026-10-21

Build under test: main with the read/write classification of MCP tools (`readTools`, write tools always require
human approval, ledger model `<server>/<tool>#read|#write`) merged over the round 2 resilience work; gateway rebuilt
with `--no-cache`. Harness change for (i): the `everything` server is declared with `readTools: ["echo"]`; the
test agent has no `approvalTools`, so the approval of `get-sum` comes from the write rule alone. Ledger checks now
expect `everything/echo#read`, `everything/get-sum#write` and `everything/get-env#write`.

| Criterion | Result | Numbers |
|---|---|---|
| a | PASS | chain valid after each of 7 checks |
| b | PASS | 120 requests answered, 0 missing from ledger |
| c | PASS | ledger cost 0.001218 USD vs provider usage 0.001163 USD, 94 calls, 0 token mismatches (ratio 1.047) |
| d | PASS | budget 0.0008 USD, spend 0.000683 (85%), 10 admitted, 20 refused (429), 0 leftover reservations |
| e | PASS (see note) | real provider, 60 pairs: direct p50/p95 1639/4280 ms, gateway 1702/3928 ms, median overhead 63 ms. Stub, 300 pairs: overhead p95 28.3 ms |
| f | PASS | 6/6 identical content and finish_reason, all streams end with [DONE] |
| g | PASS | gateway back in 2206 ms after its restart, 640 ms after the PostgreSQL restart; 63 acknowledged requests, 0 missing from ledger, chain valid (789 entries) |
| h | PASS | 797 entries restored, valid, same head hash |
| i | PASS | 11/11 checks, 16 tools: read tool passes, denied tool refused, write tool requires approval (approve and reject paths) |

Notes. (e) as in round 2: the real-provider p95 is dominated by provider jitter; the p95 gate is met on the stub.
(h) was first interrupted: the restore step starts a scratch gateway with `docker run --env-file`, which does not
strip quotes, and the quoted `GARDAGENT_MCP_SERVERS` line I had edited made it exit; the quotes were removed and
(h) and the stub run were re-run on their own (same ledger, same head hash). Real spend recorded by the gateway in
the main run: 0.001736 USD. Ledger head after the round: f61989b0f17364dc6048112848547f3385c311e2c7309f879fe1903e5e6fcc74
(797 entries).

## Round 4 — production-like server, 2026-10-21

Environment: fresh Ubuntu 26.04 LTS VPS (2 vCPU, 3.8 GB RAM, 2 GB swap, test server, no real data),
Docker 29.9.2 and Compose v5.6.0 from Docker's apt repository (suite `resolute` exists for 26.04). Code shipped with
`git archive` from main at 01761bb, installed only with `deploy/install.sh` and `deploy/docker-compose.prod.yml`.
Hardening: ufw (22, 80, 443), fail2ban sshd, unattended-upgrades, SSH password and root login disabled after a
second key-based login was confirmed. Traffic goes through Caddy: first `GARDAGENT_TLS=internal` on the IP, then
`gateway.example.com` with `acme` (valid Let's Encrypt certificate, `/health` answers without `-k`, `/admin` from the
Internet answers 403, admin works through an SSH tunnel). `GARDAGENT_MODE=enforce`. The harness ran in a container on
the compose `edge` network against the real OpenCode Go provider and the real `@modelcontextprotocol/server-everything`.

Final run (uninterrupted `tools/pilot-zero/run-round.sh`, 60 alternating pairs for (e)):

| Criterion | Result | Numbers |
|---|---|---|
| a | PASS | chain valid after each of 7 checks |
| b | PASS | 120 requests answered, 0 missing from ledger |
| c | PASS | ledger 0.001283 USD vs provider usage 0.001228 USD, 95 calls, 0 token mismatches (ratio 1.045) |
| d | PASS | budget 0.0008 USD, spend 0.000745 (93%), 11 admitted, 19 refused (429), 0 other, 0 leftover reservations |
| e | FAIL on the real provider, PASS on the stub | real, 60 pairs: direct p50/p95 1642/3544 ms, gateway 1853/5196 ms, median overhead +211 ms. Stub, 300 pairs: direct 22.5/24.3 ms, gateway 34.7/42.1 ms, overhead p95 17.8 ms, median 12.2 ms |
| f | PASS | 6/6 identical content and finish_reason, all streams end with [DONE] |
| g | PASS | gateway back in 2287 ms, 2392 ms after the PostgreSQL restart; 56 acknowledged requests, 0 missing from ledger, chain valid (392 entries) |
| h | PASS | `tools/pilot-zero/backup-restore.sh`: 400 entries restored into a scratch database, valid, same head hash. `deploy/backup.sh` then `deploy/restore.sh --yes` on the live database: restore complete, ledger verified |
| i | PASS | 11/11 checks, 16 tools |

Notes. An earlier, identical run on the same server (first harness run, before the script fixes below) gave
(e) real: 60 pairs, direct 1371/21398 ms, gateway 1281/10317 ms, median overhead -90 ms (PASS), (d) FAIL because one of
the 30 concurrent streams ended with a provider-side `upstream_error` (budget respected: 0.000728 of 0.0008 USD; the
rerun of (d) alone and the final run passed), (g) 49 acknowledged, 0 missing. So (e) on the real provider swings
between -90 and +211 ms across runs: the provider jitter (p95 3.5 to 21 s) is larger than the 100 ms gate; only the
stub measurement is reliable, and the gateway adds 12 ms median, 18 ms p95 there. Criterion (e) is therefore defined on the
stub (decision applied after this round: the real-provider figure is informational only). (g): when PostgreSQL stops while no request is in flight, requests failed with HTTP 500 "Connection terminated" (fixed in round 4b: now 503, see below; nothing was forwarded or spent either way),
nothing forwarded, nothing spent) and `/health` reports `degraded`/`database: down`; with a request in flight the
ledger row was written before PostgreSQL stopped in my three attempts, so the spool path (ledger write failing after
the provider answered) was NOT observed in a real run on this server; it remains covered only by
`apps/gateway/test/resilience.test.ts`. `/health` still said `database: up` for about 10 s after PostgreSQL was
stopped (probe interval). Real spend recorded by the gateway over all runs: about 0.01 USD.

Installation findings (all fixed in the repository unless noted):

1. Caddy with an IP address as `GARDAGENT_DOMAIN`: clients connecting by IP send no SNI and the handshake failed with
   "tlsv1 alert internal error". Fixed with `default_sni {$GARDAGENT_DOMAIN:localhost}` in the Caddyfile.
2. `deploy/README.md` health check ran `wget https://$GARDAGENT_DOMAIN/health` inside the gateway container (no TLS
   there). Replaced by `http://127.0.0.1:8080/health` plus the external `curl -k` check.
3. No documented way to reach `/admin` and `/console` from outside; the SSH tunnel method (with `--resolve` or a hosts
   entry, because `https://localhost:8443` has no matching certificate) is now in the README and the self-hosting guide.
4. `deploy/.env` is a Docker env file: values must be raw. Sourcing it in a shell breaks on quotes, and on
   `GARDAGENT_ADMIN_ALLOWED_CIDRS` (spaces); loading `GARDAGENT_PRICES` through a shell lost the JSON quotes and the
   gateway crashed at startup (`SyntaxError ... JSON.parse`). Documented; `backup-restore.sh` and `latency-stub.sh` no
   longer source the file.
5. The guide said Ubuntu 22.04 and gave no Docker, group or hardening instructions. After `usermod -aG docker` a new
   SSH session is required. Added a "Server preparation" section and Ubuntu 24.04/26.04.
6. `deploy/restore.sh` accepted `--yes` only before the file name, whereas the README says to add it after. Both
   orders work now.
7. `tools/pilot-zero` was hard-wired to the development compose (network, container names, image, `.env`). It is now
   parameterised with `PZ_ENV_FILE`, `PZ_COMPOSE_FILE`, `PZ_NETWORK`, `PZ_HARNESS_NETWORK`, `PZ_GATEWAY_IMAGE`,
   `GW_CONTAINER`, `PG_CONTAINER` (values in the header of `run-round.sh`).
8. Not changed: the SSH daemon is restarted during the first `apt upgrade`, so the connection is refused for a few
   seconds; a harness run takes about 10 minutes and its output appears only at the end of each criterion.

Round 4 note on (e): from round 4b on, (e) is the stub measurement only (gateway overhead, p95 under 100 ms, 300 pairs);
the real-provider comparison in `run.mjs` is informational (median, reported, never pass/fail).

## Round 4b - spool fault test, 2026-10-21

Server and code as in round 4, redeployed at e141bde (`--no-cache` rebuild). Script: `tools/pilot-zero/spool-fault.sh`
(temporary gateway on a scratch database, slow streaming stub upstream on the compose network, deterministic).

Sequence and numbers:

1. Baseline `/health`: 200, `database: up`, `spoolBacklog: 0`.
2. Streaming request through the gateway to a stub that holds the final chunk for 12 s. At t+3 s,
   `docker compose pause postgres` (07:57:02), so the database is unreachable exactly between the upstream response
   and the ledger write.
3. The client received the whole stream anyway (HTTP 200, text and `[DONE]` present, 32.7 s because the gateway
   retried the database before spooling).
4. Still paused: `/health` answered 503, `database: down`, `spoolBacklog: 1`; the spool file held 1 line.
5. `docker compose unpause postgres` (07:57:36). The first `/health` after the unpause (within 2 s) was already
   `ok`, `spoolBacklog: 0`; spool file empty (0 lines).
6. `/admin/ledger/verify`: valid, 2 entries checked. Ledger rows: 1 `chat.completions` (1 distinct request hash), 1
   `admin.agent.create`: the entry is present exactly once, nothing lost, nothing duplicated.

Result: the spool path works in a real run, no fix needed. Residual: a request in flight during the outage holds the
client for the retry time (here about 17 s beyond the stub delay).

Fix for the HTTP 500 seen in round 4 (database stopped outside a request): the error occurred in agent lookup, before
the ledger guard flag flipped (the flag was only refreshed by the 2 s timer and `/health`). Now an `onRequest` hook
refuses with 503 while the guard is not ready, and the error handler probes the database on any server error: if it is
unreachable, the flag flips at once and the answer is 503 `ledger_unavailable` without any provider call. Unit tests:
`apps/gateway/test/resilience.test.ts` ("B2").

## v0.2 item 1 fault test - observe mode, fail-open, 2026-10-21

Test server (test only, no real data), branch `v0.2/observe-fail-open`, image rebuilt with `--no-cache`. Script:
`tools/pilot-zero/failopen-fault.sh open|closed` (run from the repository root on the server). It recreates the real
gateway container with a temporary compose override (`GARDAGENT_MODE=observe`, `GARDAGENT_DB_OUTAGE=fail-open` or
`fail-closed`, upstream = a local stub addressed by IP, so no provider call and no cost; `deploy/.env` is untouched),
sends 40 requests (one every 0.7 s, every second one streaming, unique content), and runs `docker compose stop postgres`
after 10 requests, then `start postgres` once the traffic has ended.

Fail-open run (final run, 12:37 UTC):

1. Baseline `/health`: 200, `ledger.status: ok`, `dbOutagePolicy: fail-open`.
2. PostgreSQL stopped. All 40 requests returned 200 with a complete answer (plain and streaming), including a request
   sent through the public edge `https://gateway.example.com`. The first request after the stop took 3.0 s (bounded
   database calls, then the outage path); the next ones took 8 to 12 ms (plain) and about 210 ms (stub stream).
3. During the outage `/health`: 200, `status: degraded`, `database: down`, `ledger.status: degraded`, `spoolBacklog`
   growing to 31 (31 spool lines on the volume, 15345 bytes, fsynced before each response completed).
4. PostgreSQL started: within one health poll `spoolBacklog: 0`, spool file empty.
5. `/admin/ledger/verify`: `valid: true`, 841 entries checked. Test agent rows: 41 `chat.completions`, 41 distinct
   request hashes (40 loop requests + 1 edge probe): each entry present exactly once (10 written live, 31 replayed).

Fail-closed run (same script, `closed`): 10 requests succeeded before the stop, then 30 of 30 requests returned a real
503 `ledger_unavailable` (also through the edge), `/health` answered 503 with `ledger.status: down`, spool stayed at 0
lines, nothing was forwarded; after the restart `/health` was 200 again and the chain verified (`valid: true`, 853 entries).

Finding fixed during the test: the first run showed a 15 s stall on the first request of the outage, because pg calls
hang on a dead connection. In fail-open, database calls on the request path (agent lookup, spend read, reservation,
settlement) are now bounded to 1.5 s and then treated as an outage. A further 7 to 10 s stall seen in intermediate runs
was the Docker DNS lookup of the stub name while `docker compose stop` was running (harness artifact); the script now
addresses the stub by IP.

Restored afterwards: the script's cleanup recreates the gateway without the override (mode `enforce`, original `.env`),
and the test agent is deactivated. The test gateway keeps running the branch image.

## v0.2-2 - streams in flight and first request during a real PostgreSQL outage, 2026-10-21

Test server (test only, no real data), branch `v0.2/stream-outage-latency`, image rebuilt with `--no-cache`,
`/health` contains `mode`. Script: `tools/pilot-zero/stream-outage-latency.sh open|closed [stop|pause]` (run from the
repository root on the server; knobs `PZ_PROBES`, `PZ_CUT_AFTER_S`, `PZ_GATEWAY_IMAGE`, `PZ_EXTRA_ENV`, see its header).
It recreates the gateway with a temporary compose override (observe mode, chosen outage policy, upstream = a local stub
addressed by IP, so no provider call and no cost; `deploy/.env` untouched), starts 4 streams (2 OpenAI, 2 Anthropic, 4.5 s
each) and cuts PostgreSQL while they run: `stop` = process gone, `pause` = process frozen (connections stay open and never
answer, the worst case for a driver). It reports, per stream, the delay between the stub's last write and the client's
last byte ("added delay"), the latency of plain requests sent during the outage, the spool, the chain verification and
the number of ledger rows per distinct request hash.

### Diagnosis (measured, not assumed)

| Where | Measured | Explained by |
| --- | --- | --- |
| Stream end, fail-closed, PostgreSQL stopped | +20.5 s on all 4 streams (stable over 2 runs) | `settleReservation` waits for a pooled connection (5 s `connectionTimeoutMillis`), then the ledger write makes 3 attempts of 5 s each plus the 100 + 400 ms retry delays: 5 + 3 x 5 + 0.5 = 20.5 s. |
| Stream end, fail-open (previous commit `2d9595a`) | +1.5 s when something else already flagged the outage; 17 s when nothing did | the settlement was bounded to 1.5 s but a timeout did not flag the database down, so the ledger write still made its 3 attempts: 1.5 + 3 x 5 + 0.5 = 17.0 s (the figure reported by the president). |
| Stream end, fail-closed, PostgreSQL frozen | one stream +20 s, the others still blocked after 220 s | no statement or socket timeout at all on an established connection: only the OS TCP timeouts end the wait. |
| First request after the drop, fail-open, frozen | 3.0 s (3017, 3017, 3015, 3010 ms) | agent lookup bounded 1.5 s, then the tolerance check probed the database again for 1.5 s. |
| First request, fail-closed, PostgreSQL stopped | 23 ms (3 ms for the next ones) | refused connection: fast, nothing to fix. |
| Gateway process (found on the way) | the first fail-open/stop run killed the gateway (all 4 streams cut, every later request refused) | `pg` emits `error` on a client checked out between two queries of a transaction; only idle clients had a listener. Not reproduced in the later runs (timing dependent), fixed anyway with a listener on every client. |

### Fix

* Every request-path database call (agent lookup, spend read, reservation, settlement, release, ledger write) is bounded
  in both policies: `GARDAGENT_DB_CALL_TIMEOUT_MS` (default 600). A timeout flags the database down at once, so every
  later call of the outage skips it: the ledger row goes straight to the spool (fsynced) with the cost and day of the
  pending settlement, as before.
* A timeout is proof enough: no second wait on a probe (fail-open tolerance, error handler). Probe bound
  `GARDAGENT_DB_PROBE_TIMEOUT_MS` (800), pooled connection wait `GARDAGENT_DB_CONNECT_TIMEOUT_MS` (2000).
* A ledger write abandoned on timeout carries an `AbortSignal`; `PgStore` refuses to `COMMIT` once it is aborted, so a
  frozen server that wakes up later cannot insert a second copy of a row that is already in the spool.
* The spool replay is bounded too (it held the spool lock that every spool write waits for).

### Results after the fix (same script, same server, image built from this branch)

Added delay at the end of a stream (stub's last write to client's last byte), 4 streams per run, ms:

| Policy | Cut | Before | After, cut at 1.5 s | After, worst case (cut 0.4 s before the end) |
| --- | --- | --- | --- | --- |
| fail-closed | stop | 20 508 - 20 519 | 4 - 11 | 33 (plus 727 - 754 on three streams) |
| fail-closed | pause | > 220 s (unbounded) | 3 - 12 | 55, 614 - 634 |
| fail-open | stop | 1 504 - 1 513 | 3 - 15 | 11 - 23, 723 on one stream |
| fail-open | pause | 1 504 - 1 531 | 3 - 16 | 604 - 616 |

The worst case is the one where nothing has noticed the outage when the streams end: the first settlement pays the
600 ms bound (or the 500 ms of retry delays on a refused connection) once, in parallel for all streams. It stays under
1 s. First plain request after the cut: 610 - 614 ms with a frozen database (answered 200 in fail-open, 503
`ledger_unavailable` in fail-closed), single-digit ms or 23 ms with a stopped one (before: 3.0 s frozen, fail-open).
Every run: all rows present exactly once (rows = distinct request hashes: 5/5, 8/8, 27/27), spool replayed to 0 lines
after the restart, `/admin/ledger/verify` `valid: true` (e.g. 1 074 entries checked after the last run). Nominal latency
is untouched: the bound only adds a timer per database call on the happy path (unit tests and the 281 existing tests
unchanged); the +12 ms median of the earlier latency round was not re-measured.

Restored afterwards: the script's cleanup recreates the gateway without the override (mode `enforce`, fail-closed,
`deploy/.env` untouched); PostgreSQL is running and healthy; test agents are deactivated.

### Limits and observations for the next missions

* A single call slower than the bound on a healthy, overloaded database flags it down until the next probe (at most 2 s):
  in `enforce`/fail-closed that means 503s for that window. Raise `GARDAGENT_DB_CALL_TIMEOUT_MS` on such a database.
* The abandoned `pg` query of a frozen connection stays pending until the OS closes the socket; the pool (10 clients)
  can be exhausted by a long freeze, which is why requests are bounded above the pool. No `statement_timeout` is set:
  admin exports and `ledger/verify` legitimately run long.
* Reservations of streams that ended during the outage are not released (they expire by TTL) and spooled rows carry
  `budgetSettlement: pending`: settlement after an outage and idempotent replay are the next missions, untouched here.
* Replay is still not idempotent if the process dies between the insert and the removal of the spool line.
