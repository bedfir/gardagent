# End-to-end validation round 5, follow-up of the unexplained points (v0.2-9), 2026-10-22

Historical report for the build named below, not current v1 behavior. See
[v1 readiness](v1-readiness.md) for current evidence and gaps and [reference.md](reference.md)
for implemented behavior. Historical observations and unresolved limits are retained.

Read-only investigation on the test server (`<test-server>`, test only), main code `2eba5d4`, enforce mode. No product
code and no existing file was changed. Scripts live outside the repo (`<home>/verif/`, server `~/verif/`). No secret was printed.
Point 4 was run for `closed stop` only; `closed pause` was not run (token budget).

## 1. Criterion (g): "31 other HTTP errors"

What I did. The round 5 log only keeps counts, so the original 31 cannot be broken down after the fact. I re-ran only the restart
test (`ONLY=g`, once) with a copy of `run.mjs` that also records start/end time, status, error code and 503 body of every request,
and cuts the timeline into phases. Same code path, same 4 workers, same restarts (gateway `restart?t=10`, then PostgreSQL).

Observed (this re-run, not round 5): 314 requests, 53 acknowledged (200), 0 missing from ledger, 248 connection failures,
13 "other HTTP errors", chain valid (1 445 entries). Gateway restart call returned after about 8 s (stop) plus 2 408 ms until healthy;
PostgreSQL restart: usable again after 2 165 ms.

| Phase | 200 | 503 | Connection error |
|---|---|---|---|
| before gateway restart | 9 | 0 | 1 (`UND_ERR_SOCKET terminated`, in flight at stop) |
| gateway stopping/restarting | 4 | 3 | 247 (`ECONNREFUSED`) |
| gateway up, before PostgreSQL restart | 6 | 0 | 0 |
| PostgreSQL restarting | 1 | 10 | 0 |
| after PostgreSQL back | 33 | 0 | 0 |

All 13 other errors are 503, from two distinct sources: 3 with the generic body `{"error":"Service Unavailable","statusCode":503}` at
+0.9 to +2.2 s after the stop signal (consistent with the framework answering 503 on keep-alive connections while the server closes;
I did not confirm it in the framework), and 10 with `ledger_unavailable` (fail closed), all within 1.0 s from +24.2 s. No 502, no
Caddy involved (the harness talks to the gateway directly). None of the 13 non-200 and none of the 248 connection failures has a ledger row for
its request hash. Of the 53 acknowledged calls, 52 are normal rows and 1 is `degraded=true`, which is by design (row written late from the
spool, `ledger-guard.ts`): a call in flight when PostgreSQL stopped. Ledger rows equal acknowledged calls (53 = 53).

Verdict: partly explained. The classes of "other errors" are now known (503, two sources) and no acknowledged request was lost. The exact
figure 31 of round 5 is not recoverable and was not reproduced (13 here; the number depends on how long the two restarts take and on the
provider speed). Uncertain: the framework origin of the 3 generic 503s; round 5's own split.

## 2. Criterion (c): one token-count mismatch

Cause found, from the ledger and the gateway log; it is a pairing artefact of the harness, not a gateway accounting error.

* The harness matches each successful call with the ledger rows sharing the same `agentId|requestHash`, first in first out
  (`run.mjs`, evaluation of (a)(b)(c)). The 60 latency calls of the round send an identical body, so they share one hash.
* Round 5 ledger, agent `pilot-zero`, that hash: 60 rows. Row 55 (seq 1312, 08:33:45) is `upstream_unreachable`, upstream status empty,
  0 prompt and 0 completion tokens. Gateway log: request `req-4v` aborted by the 120 s upstream timeout, answered 502, responseTime 120 026 ms.
  The harness records only 200 answers, so that call is absent from its list, which has 59 entries (the report says `pairs=59`).
* FIFO pairing then puts the 56th successful call (provider usage 14/8) against ledger row 55 (0/0): one mismatch; every later pair is
  shifted by one row but all identical (14/8), so no second mismatch. That gives exactly 1 mismatch of 94. The cost ratio 1.042 contains the same
  shift (one ledger row costing 0 against 5 micro-USD).
* Rows with a different count exist (row 14 is 14/7, one completion token fewer) but it comes before the failure and is paired correctly.
* Earlier rounds had 0 because no call had hit the 120 s upstream timeout.

Verdict: explained (high confidence, from the data), not reproduced by a new run (it depends on a provider call hanging for 120 s). The provider's own
usage for the call could not be read, since the harness did not keep it; the explanation rests on the ledger sequence and the 0/0 row. Remaining
uncertainty: none on the count; the cause of the 120 s provider hang is outside the gateway. Harness fix (made in v0.2.1, `tools/pilot-zero/pairing.mjs`): pair only against
rows with upstream status 200.

## 3. Reservation present after round 5, gone about two minutes later

By design (`config.ts`, `shared.ts`, `ledger-guard.ts`, `pg-store.ts`):

* Normal path: a reservation is taken at admission and deleted at settlement (same transaction as the spend) or released if the upstream is unreachable.
* A reservation is left behind only if the process dies (or the database is known down at release time). TTL = `UPSTREAM_TIMEOUT_MS` (120 000) +
  `RESERVATION_MARGIN_MS` (30 000) = 150 s. Housekeeping runs at most once per 60 s while the database is healthy and deletes rows older than the TTL
  (log: "Orphan budget reservations purged"). An orphan therefore lives between 150 s and about 210 s. Past 150 s it no longer counts against the budget.

Round 5 reconstruction: the chaos phase ran 08:39:34 to 08:41:22; the gateway container started 08:39:52 (the (g) restart). The purge log line is at
08:42:53 (`reservations:1`), the first 60 s tick after 08:39:50 + 150 s. The check right after the round (08:42:01) saw 1, then 0 two minutes later: fits.

Controlled test (enforce mode, test agent budget 0.05 USD, real provider, max 8 or 300 tokens; agent deactivated):

| Moment | Reservations for the agent |
|---|---|
| in flight (1 s samples) | 1 (8 micro, then 92 micro for the stream), 0 between calls |
| right after A (2 plain, 1 complete stream, 1 stream aborted by the client) | 0 |
| +90 s, +150 s | 0, 0 |
| B: long stream (900 tokens) in flight, gateway `docker restart -t 10` | 1 (260 micro) |
| after the restart, every 10 s | 1 until 17:08:28, 0 at 17:08:38 (purge log 17:08:30; created about 17:05:15, so lifetime about 195 s) |

Clean paths (complete, aborted by client) never leave a reservation (the aborted stream got a ledger row `client_aborted_estimated`). A reservation
survives only a hard stop of the gateway with a stream in flight, then disappears at TTL plus the next tick. The same effect was seen on the global
table after my own (g) re-run (purged 17:01:30). Verdict: explained, expected by design.

Observation (not a bug claim, not investigated further): in test B the killed stream, which the client had already started to receive with a 200
header, has no ledger row, because the process was stopped before it could write one (agent ledger: 4 rows for 5 requests). So a stream cut by a
hard gateway stop leaves no audit trace and no spend. The docs claim "no action can finish without a trace" for controlled paths; this one is an
uncontrolled kill. Worth a decision.

## 4. `closed` mode: nothing forwarded during a database outage

Method: NEW copies under `<home>/verif/so/` of the stub (adds an arrival log, `GET /arrivals`), of the client (prints the send time of
each request) and of `stream-outage-latency.sh` (prints the cut epoch and the stub arrivals). Scenario `closed stop`, run once, observe mode, fail-closed, stub upstream.

| Scenario | Requests sent by the client after the cut | 503 received | Requests that reached the stub after the cut |
|---|---|---|---|
| closed, stop (cut at epoch 1792688961162) | 19 (all 19 plain probes after the cut) | 19 (19 of 19) | 0 |

Detail: 26 requests in total; 7 sent before the cut (3 probes and 4 streams, all 200); the stub saw exactly 7 arrivals (so1, so2, sa2, sa1, p0, p1, p2),
the last 215 ms before the cut, none after. 503 total = 19. After restore: spool 0 lines, `verify` valid (1 459 entries), 8 ledger rows for the
test agent (7 requests plus the agent-create row), container `restarts=0`.

Verdict: explained, expected result observed for `stop`. `closed pause` was NOT run. Caveat: the cut command returned after 318 ms, so
PostgreSQL was fully down slightly after the epoch used; the first probe after the cut (sent +172 ms) was already refused, and no arrival falls in that window.

## State at the end

Gateway recreated without override (enforce, fail-closed), healthy; PostgreSQL healthy; no test container left; spool 0; reservations 0. Test agents created
by this mission (`verif-v029-*`, `stream-outage-*`, `pilot-zero-chaos-mvjsbma2` of the (g) re-run) deactivated. The 8 pilot-zero agents of earlier rounds
are untouched. The re-run of (g) and test B restarted the gateway; the ledger gained rows during these tests (valid).
