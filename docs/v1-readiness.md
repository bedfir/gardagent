# v1 readiness

Evidence inventory, 2026-11-12. This is the local development branch, not a release
announcement or an assertion that all exit criteria have passed. Package versions
remain 0.3.0. Paths below identify implemented checks; their existence does not
prove execution. No Node, pnpm, Docker, browser, provider or registry checks were
run for M14. The runner must attach its final gate and reviewer results to this
revision. Historical reports are evidence only for their stated builds.

| # | Exit criterion | Evidence in this repository | Remaining gap or limit |
| --- | --- | --- | --- |
| 1 | Safe upgrades: fresh install, populated 0.3.0 adoption, rerun, transactional failure and restore; unchanged hashes and spend | `apps/gateway/src/migrations.ts`; `apps/gateway/test/migrations.test.ts` tests fresh/concurrent startup, populated adoption, stable legacy rows/hash/spend and trigger identities, reruns, failure rollback, incomplete schemas and newer-version refusal. [Upgrade and restore guide](upgrade-0.3-to-1.0.md), [migration locking/timing](migration-timing.md). | PostgreSQL tests require `TEST_DATABASE_URL`. The migration suite does not perform a dump/restore cycle. `tools/pilot-zero/backup-restore.sh` and the [0.3.0 report](validation-0.3.0.md) cover earlier restore behavior, not a demonstrated 0.3-to-v1 rehearsal. A fresh rehearsal with matched database/spool/executable and preserved spend is still required; versioned migration timing is unmeasured. |
| 2 | MCP: explicit methods/transports/notifications, governed and journaled or refused without forwarding | [Implemented matrix](mcp-matrix.md), `apps/gateway/src/mcp.ts`, `apps/gateway/test/mcp.test.ts`: method refusal, local ping, notifications, filtered listings/capabilities, JSON/SSE screening, malformed framing and observe behavior. | Streamable HTTP POST only. GET/DELETE are refused. Declared server notifications are covered by the parent response hash; suppressed messages have separate rows. Observe mode intentionally forwards policy violations with evidence. Outage refusals needing the database cannot be journaled. Final runner result pending. |
| 3 | Per-agent rate limits: concurrency safety, isolation, HTTP 429 and Retry-After | [Rate-limit contract](rate-limits.md), `apps/gateway/src/rate-limiter.ts`, `apps/gateway/test/rate-limiter.test.ts`; persistence and policy round trips in `apps/gateway/test/migrations.test.ts`. | **HTTP status gap:** `apps/gateway/src/mcp.ts` returns HTTP 200 with JSON-RPC `-32004` for rate-limited requests; only model requests and MCP notifications return HTTP 429. This criterion is not fully met. Single gateway process; counters reset on restart. Concurrency Retry-After is a one-second hint. Limits default to unlimited; operators must configure them. Final runner result pending. |
| 4 | Third-party ledger verification: written format, consistent export, external checkpoints, standalone verifier | [Ledger format](ledger-format.md), [export protocol](reference.md#ledger-export-and-external-checkpoints), [offline CLI](verify.md); `apps/gateway/test/ledger-checkpoints.test.ts` covers concurrent appends, boundaries, truncation and replacement; `packages/verify/test/verify.test.ts` covers independent hashing, mixed versions, complete exports, checkpoints, malformed input and CLI outcomes. | Tail truncation and full rewrites are detectable only relative to a checkpoint retained outside the database. Entries after that anchor are unprotected by it. Checkpoints are unsigned and provenance must be established separately; CLI memory grows with file size. Final runner result pending. |
| 5 | Recorded mandate: immutable admission revision, correlated approvals, authenticated deciding/changing operator | [Mandate contract](mandate.md); `apps/gateway/test/mandate.test.ts` exercises memory/PostgreSQL stores, revocation, distinct operators, policy changes during approval and atomic evidence rollback; migration tests preserve historical hashes/spend. | Named tokens prove possession, not human identity. Bootstrap remains available. Historical attribution cannot be reconstructed. Global mode and server read/write classification are outside policy snapshots. Final runner result pending. |
| 6 | Anthropic: human-only opt-in real-provider harness and usage × configured-rate cost check | `tools/anthropic/verify.mjs`, [harness instructions](../tools/anthropic/README.md), `apps/gateway/test/anthropic.test.ts` synthetic plain/streaming usage and exact micro-USD accounting assertions. | Real-provider execution is pending and is never run by agents or CI. Status remains **format-compatible**, not provider-verified. Cache creation/read usage is charged at the configured ordinary input rate, not distinct provider billing rates. |
| 7 | Console in a real browser in CI: login, approval, filters and integrity | `e2e/console.spec.ts`, `e2e/gateway-lifecycle.spec.ts`, [browser instructions](../e2e/README.md), `.github/workflows/ci.yml` Chromium job with pinned Playwright image and failure artifacts. | Tests use a real gateway with MemoryStore and fake upstream, not PostgreSQL or a provider. Historical runner failures/fixes are documented in `docs/design/M11.md` and `docs/design/M12.md`; no final successful browser result is supplied to M14. A passing runner/browser result is required. |
| 8 | Restart diagnostics: classify failures and assert invariants; synchronize unstable MCP tests on events | `tools/pilot-zero/restart.mjs`, `apps/gateway/test/pilot-zero-restart.test.ts`, `apps/gateway/test/mcp.test.ts`; [M01 design](design/M01.md) and [historical 0.3.0 limits](validation-0.3.0.md#4-limits). | The 29 unclassified 0.3.0 errors cannot be recovered. No new live restart round was run here. The strict orphan check can fail before the reservation TTL has elapsed; normal settlement and journaling remain distinct steps, unlike atomic spool replay. Final runner result pending. |
| 9 | First run under ten minutes with local model/no provider key, authentication on; three runnable examples | Root [README](../README.md#local-quickstart), `docker-compose.local.yml`, [OpenAI](../examples/openai/README.md), [Anthropic](../examples/anthropic/README.md), [MCP approval](../examples/mcp/README.md); `apps/gateway/test/quickstart.test.ts` checks documented routes/configuration and example commands. | Under ten minutes remains an unmeasured target on a clean machine. CPU speed, build and downloads can exceed it. Anthropic example uses a synthetic fixture; local accounting rates are zero. Static drift tests do not establish successful Compose or SDK execution. |
| 10 | Written API, ledger and schema compatibility policy with contract tests | [Compatibility policy](compatibility.md), `apps/gateway/test/contracts.test.ts`, immutable version 1 samples in `test/fixtures/contracts/`, `packages/core/test/ledger.test.ts` version 2 checks, `apps/gateway/test/migrations.test.ts` schema checks. | Policy applies from 1.0; current packages remain 0.3.0. Tests cover selected contracts, not every possible HTTP input. No separate version 2 golden fixture file exists; version 2 is exercised in generated test entries and mixed-chain tests. Final runner result pending. |
| 11 | Signed images, SBOM, provenance and verification instructions | `.github/workflows/release.yml`: pinned actions, keyless signature over OCI index digest, BuildKit SPDX SBOM and SLSA provenance; [verification and first-release checklist](verify-release.md). | Statically inspected only. No publication, signature or registry evidence was exercised here. First tagged release must be checked by a human. Old images gain no evidence retroactively; builds are not bit-for-bit reproducible. |

## Human-only work before a v1 release decision

- Run the explicitly opted-in real-Anthropic harness and record its model,
  configured rates, plain/streaming results and limits without retaining credentials.
  Keep the format-compatible label until that scoped result exists.
- Authorize and perform any push/publication. Creating the v1.0 tag is a human
  action; agents deliver only local `v1-dev` through the runner.
- Check the first signed release end to end on a clean verification machine using
  [verify-release.md](verify-release.md): exact identity/digest, negative checks,
  provenance source/revision, attestation subjects, SBOM and smoke test. Retain proof
  independently of the registry.
- Time the authenticated quickstart on a clean machine, recording hardware,
  platform, network/download conditions and total time; execute all three examples.
- Find independent users, collect their upgrade/first-run results and unresolved
  issues. Independent use and a human release decision are required; neither is
  established by the test-server reports.

## Local handoff and review

The runner owns installation, typecheck, PostgreSQL tests, build, browser execution,
commits and merge to local `v1-dev`. Require its results for the final revision;
do not convert pending checks into passes based on earlier mission notes. The
reviewer should first inspect the restore gaps and backup/spool pairing, then MCP
observe exceptions, checkpoint limits and the evidence table above.

Static M14 inventory found all five workspaces (`apps/console`, `apps/gateway`,
`packages/core`, `packages/report`, `packages/verify`) already represented under
`pnpm-lock.yaml` importers, including `packages/verify: {}`. No lockfile edit was
necessary in this checkout. Only a runner frozen install followed by a clean-tree
check can establish that installation leaves the lockfile unchanged. No new
dependency was requested. One mechanical documentation-index task is delegated in
`.team/small-tasks/`; its applied result needs reviewer inspection.
