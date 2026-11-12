# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- MCP uses explicit method governance, journals non-tool traffic and refusals, filters capability listings, and screens server messages in JSON and SSE responses.

- New ledger entries use format version 2 with hashed optional revision, operator and approval references; historical version 1 entries remain unchanged and unknown versions fail verification. Full-chain verification preserves version ordering across pages and the console labels format errors.

- PostgreSQL startup uses transactional numbered migrations under an advisory lock, adopts databases already complete at the 0.3.0 schema without replaying application DDL, and refuses newer schema versions.

### Added

- Standalone offline ledger verifier with independent hashing, complete M06 export validation, external checkpoint comparisons, and text or JSON output.

- Sequence-paginated NDJSON ledger export with a captured head, external checkpoints, and checkpoint-aware verification; detection of truncation or replacement requires retaining a checkpoint outside the database.

- Named, revocable operator tokens (shown once), immutable policy revisions captured at admission, operator-attributed administration and approval decisions, correlated approval ledger rows, and bilingual mandate metadata in the console. Migration 3 preserves historical ledger hashes and spend.

- Contracts for v1: `docs/compatibility.md` (what is stable and what compatible means), `docs/ledger-format.md` (ledger format version 1 as written by 0.3.0, and the version 2 specification), `docs/mandate.md` (operators, policy revisions, approvals) and `docs/mcp-matrix.md` (target governance of every MCP message). Documentation only: no behaviour change.
- Golden fixtures under `test/fixtures/contracts/` (ledger entries and API samples produced by the real code) and a contract test that fails if a version 1 ledger entry no longer verifies.

### Fixed

- Pilot-zero restart validation now reports failure causes and checks ledger coverage, orphan reservations, and spend consistency.
- Gateway tests synchronize on observable state instead of short fixed delays; MCP migration fixtures use isolated schemas.
- Pilot-zero restart requests time out after 120 seconds so stalled requests are reported.

## [0.3.0] - 2026-11-11

### Upgrade notes (behavior changes)

Read these before upgrading from 0.2.x.

- `GARDAGENT_ADMIN_TOKEN` must be at least 32 characters; the gateway refuses to start with a shorter value.
- Creating an agent requires an explicit budget: `POST /admin/agents` answers 400 unless `dailyBudgetUsd` is positive, or is 0 together with `"unlimited": true`. Scripts that omitted the budget must be updated. Existing agents and `PATCH` are unchanged.
- The root `docker-compose.yml` publishes the gateway on `127.0.0.1:8080` only. Put a reverse proxy in front of it, or use the `deploy/` stack, to reach it from other hosts.
- New environment variables: `GARDAGENT_AUTH_FAIL_LIMIT` (default 10; 0 disables the limit), `GARDAGENT_AUTH_FAIL_WINDOW_MS` (default 60000) and `GARDAGENT_TRUST_PROXY` (default off; `true` in the `deploy/` production stack). Failed authentications from one address now get 429 with `Retry-After`.
- `pnpm report` now writes an English usage report titled "Gardagent usage report" (it used to write a French note); the numbers and command options are unchanged.

### Added

- `GARDAGENT_AUTH_FAIL_LIMIT`, `GARDAGENT_AUTH_FAIL_WINDOW_MS` and `GARDAGENT_TRUST_PROXY` (see Security).
- Console: a "No cap (unlimited)" checkbox on the agent creation form.
- `docs/reference.md` (behavior reference moved out of the README), `docs/self-hosting.md` and a documentation index (`docs/README.md`).
- GitHub project files: YAML issue forms and issue chooser, a pull request template, the Contributor Covenant 2.1 Code of Conduct, and a rewritten `SECURITY.md` built around GitHub private vulnerability reporting.
- A release workflow that publishes the container image to `ghcr.io` on version tags, and a CI build step and high-severity dependency audit.
- Usage report section in the README and `README.fr.md`.

### Changed

- `pnpm report` generates a neutral English "Gardagent usage report" (Summary, Agents, Denied requests by reason, Would have been blocked, Notes, About this report) instead of a French diagnostic note; `describeReason` replaces the exported `translateReason`. Computed figures and command options are unchanged.
- The README was rewritten for developers (quick start, configuration, security model, limitations) and `CONTRIBUTING.md` updated (prerequisites, test setup, definition of done); `README.fr.md` brought in line.
- Package versions are now 0.3.0 in the root and the four workspaces; the gateway `User-Agent` (`Gardagent/<version>`) follows `apps/gateway/package.json`.
- Documentation wording: the "pilot zero" end-to-end validation is now described as an end-to-end validation harness. Only
  text changed: the `tools/pilot-zero` directory, the `docs/pilot-zero*.md` file names, the `PZ_*` environment variables
  and the harness agent names are unchanged. The harness summary banner now reads `=== VALIDATION ROUND SUMMARY ===`.
- Validation reports under `docs/` no longer contain local paths or test-server host names (replaced by placeholders).
- Deployment kit, environment templates and contributing notes use neutral self-hosting wording.
- Package metadata: the root and every workspace `package.json` now declare `"license": "Apache-2.0"` and the repository URL;
  the root description is in English.

### Fixed

- A positive daily budget below 1 micro-USD (for example `dailyBudgetUsd: 0.0000001`) was rounded to 0, which means "no cap", so `POST /admin/agents` created and `PATCH /admin/agents/:id` turned an agent into an unlimited one. Both now refuse any positive budget that rounds to 0 with a 400 (minimum 0.000001 USD; `0` with `unlimited: true` on creation and `PATCH` `0` are unchanged), through one shared validation, and the console forms show the same message in English and French.
- Model names that are properties of `Object.prototype` (`constructor`, `__proto__`, `toString`, ...) gave a NaN cost, so a budget-limited agent allowed on such a name was never stopped. The price lookup now only reads the table's own, well-formed entries; unknown models still use the fallback price, and a cost is never NaN or infinite (non-finite token counts count as zero; an invalid fallback price throws).

### Security

- Upgraded `@fastify/static` from 8.3.0 to 10.1.10, which clears the advisories reported by `pnpm audit --prod` (path traversal through non-normalized `..` segments, non-canonical path authorization bypass, and the `glob`/`minimatch` advisories reached through it).
- The root `docker-compose.yml` publishes the gateway on `127.0.0.1:8080` only, and the gateway logs a startup warning when it listens beyond loopback without `GARDAGENT_ADMIN_ALLOWED_CIDRS` set. The allow-list itself is enforced by the Caddy proxy of `deploy/`, not by the application.
- `GARDAGENT_ADMIN_TOKEN` must be at least 32 characters; shorter values are refused at startup (the installer's `openssl rand -hex 32` produces 64).
- Failed authentications (admin token and agent keys) are limited per source address: after `GARDAGENT_AUTH_FAIL_LIMIT` failures (default 10; 0 disables the limit) in `GARDAGENT_AUTH_FAIL_WINDOW_MS` (default 60 s) the address gets 429 with `Retry-After`, before the body is read. `GARDAGENT_TRUST_PROXY` selects how the client address is derived (default off; `true` in the production compose stack, where Caddy is the only entry point).
- The ledger gets one `invalid_key` row per source address and window instead of one per rejected request; the other failures are aggregated in an `invalid_key_repeated:<count>` row. Chain format and hashing are unchanged.
- Requests on `/v1/*` and `/mcp/*` without a well-formed agent key may send at most 64 KiB of body (413 above).
- Agent creation requires an explicit budget: a missing `dailyBudgetUsd` used to create an agent with no cap. `POST /admin/agents` now answers 400 unless `dailyBudgetUsd` is positive, or is 0 together with `"unlimited": true`. The console form has an empty budget field and a "No cap (unlimited)" box. Existing agents are not modified; `PATCH` is unchanged.
- CSV export: spreadsheet-formula neutralisation (`=`, `+`, `-`, `@`, tab, carriage return) now also applies to the `action` column, not only to agent, model and reason.
- The ledger spool file is created with mode 0600 (and its directory with 0700 when the application creates it). Existing files and directories keep their mode.
- `.dockerignore` now excludes every `.env` file (including `deploy/.env`), `deploy/backups`, `.git`, `.github`, `node_modules`, logs and spool files from the Docker build context, so none can end up in an image layer.
- Documented a known limitation: MCP governance and the ledger cover `tools/call` only; `resources/read`, `prompts/get` and the other MCP methods pass through without rules or ledger rows (README known limitations, `docs/industrial-setup.md`). Behavior unchanged.
- The admin authentication-failure limiter no longer accumulates a count per ended window and per eviction (it is never drained); its memory stays bounded. Blocking behavior is unchanged.

### Removed

- `docs/guide-installation-pilote.md` (a French installation guide written for a single-site pilot), replaced by
  `docs/self-hosting.md` (English, for operators). The technical content (install, TLS, admin allow-list, agents, backups,
  removal) was kept.

## [0.2.2] - 2026-10-31

Sections for 0.2.0 (2026-10-22), 0.2.1 (2026-10-22) and 0.2.2 were never written separately; the entries below cover all three.

### Added

- Observe mode can fail open when PostgreSQL is down (`GARDAGENT_DB_OUTAGE=fail-open`, observe mode only): traffic is forwarded and ledger rows are fsynced to the spool first; spool size cap `GARDAGENT_SPOOL_MAX_BYTES`; MCP writes and approvals refused during the outage; `/health` reports `ledger` status.
- `POST /admin/agents/:id/rotate-key`: replaces an agent's key (same id, policy and history), new key returned once, old key refused at once, cache dropped synchronously, audited; "Renouveler la clé" in the console.
- `GET /admin/spend-check` and a console banner: agents whose `agent_spend` differs from their ledger cost for the current UTC day.

### Fixed

- Validation harness: agents it creates are deactivated at the end of every run (failures included), and criterion (c) pairs only with ledger rows whose upstream status is 200.
- A stream in flight when PostgreSQL went away was held back for about 17 s before its end (settlement and ledger write waited for the driver's TCP/pool timeouts, 3 attempts), and the first request after the drop for about 3 s. Request-path database calls are now bounded in both outage policies (`GARDAGENT_DB_CALL_TIMEOUT_MS`, default 600 ms; `GARDAGENT_DB_PROBE_TIMEOUT_MS`; `GARDAGENT_DB_CONNECT_TIMEOUT_MS`), a timeout flags the database down at once, and a ledger write abandoned on timeout is never committed later (no duplicate with the spooled copy).
- A PostgreSQL connection lost while checked out between two queries no longer crashes the gateway process.

## [0.1.0] - 2026-10-21

### Added

- OpenAI-compatible proxy endpoint (`POST /v1/chat/completions`) with streaming support.
- Anthropic-compatible proxy endpoint (`POST /v1/messages`) with streaming support.
- Per-agent `ga_…` keys; the real provider key stays inside the gateway.
- Per-agent model allow-lists.
- Atomic daily budget reservation and settlement.
- Hash-chained append-only ledger for requests, responses and admin actions.
- MCP proxy with tool allow-lists for `tools/call`.
- Human approval flow for sensitive MCP tools.
- Observe-only mode for non-blocking oversight.
- Admin console with dashboard, agent management and ledger viewer.
- CSV export of the ledger.
- Markdown report generator (`pnpm report`): agents, spend and ledger integrity from the admin API.
- Installation kit for self-hosting.
- Hardened deployment kit (TLS via Caddy, admin network allow-list, token rotation).
- Tailscale access option.
- End-to-end validation harness (`tools/pilot-zero`), including a deterministic ledger spool fault test.

### Changed

- Hardening found by the end-to-end validation: fail-closed ledger (requests are refused with 503 while the ledger or database is
  unavailable, including the first request after the database drops, without calling the provider); ledger write
  retries, then append-only spool replayed in order, never losing an entry; `/health` reports `mode`, database state
  and `spoolBacklog`.
- Real-server installation fixes found on an Ubuntu 26.04 VPS (Caddy TLS with IP addresses, health check in the
  self-hosting guide, deployment scripts).
