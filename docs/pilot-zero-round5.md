# End-to-end validation, round 5 and real outage scenarios (v0.2-8), 2026-10-22

Test server (`<test-server>`, test only, no real data). Build under test: main at `2eba5d4`
(ledger filters), deployed by rsync (excluding `deploy/.env`, `.git`, `node_modules`, `dist`, backups, `.pnpm-store`;
no `--delete`), `docker compose build --no-cache gateway`, `up -d`. No product code was modified. All figures below
were observed on the server on 2026-10-22 (07:50 to 08:50 UTC); nothing is copied from earlier rounds.

## 1. Deployment

* `/health` after deployment: `{"status":"ok","mode":"enforce","database":"up","spoolBacklog":0,"ledger":{"status":"ok","dbOutagePolicy":"fail-closed","spool":{"backlog":0,"bytes":0,"maxBytes":67108864,"writable":true}}}`.
* New code present: `GET /` answers `302` to `/console/`; indexes `ledger_agent_seq_idx` and `ledger_model_seq_idx` exist
  (before: `ledger_hash_key`, `ledger_pkey`, `ledger_agent_ts_idx`, `ledger_ts_idx`).
* Index creation on the existing test-server ledger (1 104 rows): the gateway ran the migration at start; from `docker compose up -d`
  (T0) to both indexes visible: 2 385 ms, of which 1 522 ms is the container start (the `up` call itself). The index
  creation cannot be isolated from that figure. Measured separately on a copy of the table (1 104 rows, `CREATE INDEX` on
  `(agent_id, seq)` and `(model, seq)`): 7.9 ms and 4.5 ms. Conclusion: negligible at this size; it was not measured on a large ledger.

## 2. Baseline (before any outage)

* `/admin/ledger/verify`: `valid: true`, 1 104 entries.
* Spend vs ledger, UTC day 2026-10-22: no mismatch (2 agents had activity at that moment).
* Reservations: 0. Spool: 0 lines.
* Old days (reported, not repaired, out of scope): only 2026-10-21 differs. 41 agents, `agent_spend` total 37 671 micro-USD,
  ledger sum 117 451 micro-USD: `agent_spend` under-counts by 79 780 micro-USD (0.0798 USD, 67.9 % of the ledger sum).
  Unchanged at the end of the mission.

## 3. Real outage scenarios (`tools/pilot-zero/stream-outage-latency.sh`, run on the server, one at a time)

Each run: 4 streams (2 OpenAI, 2 Anthropic, 4.5 s) plus 22 plain probes (one every 400 ms), 26 proxied requests in total,
against the local stub upstream (no provider call, no cost), observe mode. After each run, 75 s wait (housekeeping is 60 s),
then verify, spend-vs-ledger for the day, reservations, spool.

| # | Scenario | Cut at | Proxied requests answered 200 / 503 | Added delay at end of the 4 streams | Plain probes during outage | Spool lines at end of traffic, after restart | Ledger rows for the 26 requests (rows / distinct hashes) | verify after housekeeping | spend = ledger (day) | Reservations |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | open, stop | 1.0 s | 26 / 0 | 3, 3, 3, 4 ms | all 200, 7 to 43 ms | 24, 0 | 26 / 26 | valid, 1 132 rows | yes, no mismatch | 0 |
| 2 | open, stop | 4.1 s | 26 / 0 | 7, 9, 14, 17 ms | all 200; two at 614 and 654 ms (p10, p11, first calls after the cut was noticed) | 12, 0 | 26 / 26 | valid, 1 160 | yes | 0 |
| 3 | open, pause | 1.5 s | 26 / 0 | 4, 5, 6, 7 ms | all 200; two at 626 and 642 ms (first ones after the cut: the 600 ms call bound) | 22, 0 | 26 / 26 | valid, 1 188 | yes | 0 |
| 4 | closed, stop | 1.5 s | 8 / 18 | 4, 4, 4, 7 ms | 18 of 18 refused 503; first two 608 and 607 ms, then 2 to 6 ms | 4, 0 | 8 / 8 (the 8 acknowledged) | valid, 1 198 | yes | 0 |
| 5 | closed, pause | 1.5 s | 7 / 19 | 3, 3, 3, 6 ms | 19 of 19 refused 503; first two 606 and 611 ms, then 2 to 7 ms | 4, 0 | 7 / 7 (the 7 acknowledged) | valid, 1 207 | yes | 0 |

Details and what was and was not proven:

* Every run: spool replayed to 0 lines after PostgreSQL returned, `valid: true` right after the restart as well, container
  never restarted (`restarts=0`, `exit=0`), no duplicate (rows = distinct request hashes). Each run also writes two admin rows
  (`admin.agent.create`, `admin.agent.update`) that are not proxied requests (28 rows in total for the test agent in run 1,
  27 at the time the script counted, before the deactivation row).
* Open mode: all 26 requests served and each one is in the ledger exactly once (13 `chat.completions` + 13 `messages`),
  proven through the spool (24, 12 and 22 spooled lines; the others were written live before the cut).
* Closed mode: refusals are HTTP 503. The 503 body (`ledger_unavailable`) was not captured in these runs (it was seen in the
  agent-cache run, section 4). That nothing was forwarded in closed mode is supported only indirectly: ledger rows equal the
  200 answers (8 and 7) and the 503 requests have no row; the stub's received-request count was not read. Not directly measured.
* Closed mode refusals cannot be ledgered (the ledger is the thing that is down): the 18 and 19 refusals leave no trace
  except the gateway error logs. This is by design but is an audit limit worth knowing.
* The cost of the stub traffic is 0 (model `m` has no price), so "spend equals ledger" is a weak check for these runs; it is
  meaningful for the day as a whole because the same day also holds the real-provider traffic of round 5 (27 596 micro-USD at the end, equal on both sides).
* Anomaly: in run 2 the script printed `cut command returned after -157 ms`. The postgres stop itself worked (spool 12 lines);
  the negative value indicates a wall-clock step (or that the cut timestamp was taken before the timing sleep ended). Timing
  helper only, not a product issue; not investigated.
* The scripts used for the post-run checks (`check.sh`, `olddays.sh`, `scn.sh`, `cache.sh`) live in the server home, not in the repository.

## 4. Agent cache during a real outage (v0.2-4)

`fail-open` only applies in observe mode (`failOpenActive`), so this test uses the same temporary override as the outage script
(observe, fail-open, local stub upstream). Test agent created through the admin API, key never printed, deactivated at the end.
Cache TTL default 30 s, outage grace 120 s.

| Step | Observed |
|---|---|
| Healthy request | 200 |
| Unknown key, healthy | 401 `invalid_api_key` |
| PostgreSQL stopped; known key, 3 requests within seconds | 200, 200, 200 (rows ledgered `degraded = true`), `/health` `degraded`, `database: down` |
| Unknown key during the outage | 503 `ledger_unavailable` (refused; not 401) |
| Known key at +50 s (past the 30 s TTL, inside TTL + 120 s) | 200 |
| Known key at +160 s (past TTL + grace = 150 s) | 503 `ledger_unavailable` |
| PostgreSQL started | `/health` 200 `database: up`, `spoolBacklog: 0`; known key 200 |
| `PATCH /admin/agents/<id> {active:false}` then the very next request | observe mode: 200, ledger row with `reason = observed:agent_disabled` (the agent is seen as disabled at once; observe mode serves and records) |
| Same disable in enforce mode (separate agent, model not allowed so nothing is forwarded) | before: 403 `model_not_allowed`; after PATCH, the very next request: 403 `agent_disabled` |

Notes: the first run of this test had a bug in my test script (the unknown-key argument was not passed, so it re-sent the
known key and got 200); the table uses the corrected run for the unknown-key rows and the first (full-length, 160 s) run for the +50 s and +160 s rows.
In the corrected run the 50 s and 160 s waits were skipped (short variant), so those two rows come from the first run only.
Refusal of a disabled agent in enforce mode does not exercise the cache (the cache is used only in fail-open). The status
for an unknown key or an expired cache entry during an outage is 503 `ledger_unavailable` (the code throws "agent unknown
during a database outage"), which a client cannot tell from a ledger outage; arguably a 401 or a distinct code would be clearer. Observation only.

## 5. End-to-end validation round 5 (`tools/pilot-zero/run-round.sh`, production-like variables)

Run 08:11 to 08:42 UTC (31 minutes, much slower than earlier rounds because the real provider answered slowly: direct p50
7.8 s). Real provider, model `mimo-v2.6-flash`. Real spend recorded by the gateway during the round: 0.001516 USD; 155 ledger entries added.

| Id | Result | Evidence (measured in this round) |
|---|---|---|
| a | PASS | chain valid after each of 7 checks (traffic, latency, stream, budget, chaos, mcp, final) |
| b | PASS | 120 gateway requests answered, 0 missing from the ledger |
| c | PASS | ledger cost 0.001255 USD vs 0.001205 USD from provider usage, 94 matched calls, ratio 1.042, token-count mismatches: 1 (earlier rounds had 0; the harness does not say which call) |
| d | PASS | budget 0.0008 USD, spend 0.000726 USD (91 %), 11 admitted, 19 refused (429), 0 other, 0 leftover reservations |
| e | PASS on the stub gate | stub, 300 pairs: direct p50/p95 22.6/24.9 ms, gateway 37.4/49.4 ms, overhead median 14.8 ms, p95 24.5 ms (gate p95 < 100 ms). Real provider (informational only): 59 pairs, direct p50/p95 7 848/14 713 ms, gateway 7 347/23 509 ms, median overhead -501 ms; the provider jitter makes it meaningless as a gate |
| f | PASS | 5 usable deterministic pairs of 6 (one pair discarded because the provider itself was not deterministic), 5/5 identical content and finish_reason, 6/6 gateway streams end with `[DONE]` |
| g | PASS | gateway back in 2 342 ms after its restart; usable again by itself 2 646 ms after the PostgreSQL restart; 211 requests, 25 acknowledged (200), 0 missing from ledger, 155 connection failures (never acknowledged), 31 other HTTP errors (not broken down by the harness, as in rounds 2 to 4), chain valid (1 380 entries) |
| h | PASS | backup then restore into a scratch database: 1 388 entries, valid, same head hash |
| i | PASS | real `server-everything` behind `/mcp/everything`: 11/11 checks, 16 tools, 7 ledger rows |

Post-round checks: `/admin/ledger/verify` valid (1 388, later 1 391 after three deactivation rows); `agent_spend` equals ledger sum
for every one of the 14 agents of the day (no mismatch); reservations: 1 right after the round, 0 about two minutes later
(housekeeping); spool 0.

Limits of this round:

* (e) can only be shown on the stub; the real-provider figure is noise (negative median overhead this time).
* (g): 31 "other HTTP errors" are not characterised; only the acknowledged requests are proven present in the ledger.
* (c): 1 token mismatch is unexplained (not investigated, the cost ratio stays inside the +/-10 % gate).
* One reservation was still present immediately after the round and disappeared at the next housekeeping; the cause (a
  request interrupted by the restarts of (g), most likely) was not identified.
* The harness does not deactivate the agents it creates (`pilot-zero-cap-*`, `-chaos-*`, `-mcp-*`): I deactivated the three of this
  round (suffix `mvj9i7hc`). Eight active agents from earlier rounds (`pilot-zero` and the `-mvhs*` ones) were left untouched as they predate this mission.

## 6. Console check through the SSH tunnel

Tunnel `ssh -N -L 18080:172.18.0.2:8080 <test-server>` (container IP checked with `docker inspect`), admin token read on the
server inside a script, never printed. Ledger: 1 388 rows at the time, 84 denied, 748 rows with cost >= 0.0001 USD, maximum cost 843 micro-USD.
List pages are capped at 1 000 rows (`limit=1000`), so the unfiltered and `allowed` lists show 1 000.

| Call | Status | Rows | Expected from the database |
|---|---|---|---|
| `GET /admin/ledger?verdict=denied` | 200 | 84 | 84 |
| `GET /admin/ledger?agent=<busiest agent>` (asc and desc) | 200 | 274 | 274 |
| `GET /admin/ledger?minCost=0.001` | 200 | 0 | 0 (nothing costs 0.001 USD or more) |
| `GET /admin/ledger?minCost=0.0001` | 200 | 748 | 748 |
| `GET /admin/ledger?minCost=abc` | 400 | - | - |
| `GET /admin/ledger/facets` | 200 | 53 agents, 6 models | not cross-checked |
| `GET /admin/ledger/export.csv?verdict=denied` | 200 `text/csv` | 85 lines (header + 84) | 84 |
| `GET /admin/ledger/export.csv?agent=<id>&minCost=0.001` | 200 | 1 line (header only) | 0 |
| `GET /admin/ledger/export.csv?minCost=0.0001` | 200 | 749 lines (header + 748) | 748 |
| `GET /admin/ledger/facets` without token | 401 | - | - |

At the time of this manual run, console pages in a browser, the model filter and combined list filters were not checked. The M11 Chromium suite now covers the built console against a real in-memory gateway: login and wrong-token refusal, agent listing and creation, approval and rejection, ledger filters, integrity results, and French/English switching. See [browser test coverage](../e2e/README.md) for scope and execution limits; historical manual results above are unchanged.

## 7. State left behind

Gateway recreated without any override (`mode: enforce`, fail-closed, `/health` 200), PostgreSQL running and healthy, no leftover
test container (stub and client removed), spool 0, reservations 0, no active test agent created by this mission.

## Bugs

None found in the product during this mission. Observations worth a decision: the 503 `ledger_unavailable` status for an unknown
key or an expired cache entry during an outage (section 4), the lack of any trace of fail-closed refusals (section 3), and the
under-counted `agent_spend` for 2026-10-21 (section 2).
