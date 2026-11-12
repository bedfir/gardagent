# Compatibility policy

This policy applies from version 1.0.0. Until then (0.x) anything may change, but the surfaces listed here are already
treated as the baseline: 0.3.0 is the reference, and a change to any of them needs a line in the changelog. Versions
follow semantic versioning: a breaking change to a stable surface needs a new major version.

"Compatible" is defined per surface below. In every case the test is the same: *a client, a verifier or a database
written against 1.0 keeps working against every later 1.x.* Selected contracts are tested as described in section 9; the tests are not exhaustive.

## 1. HTTP API

**Stable:** the paths, methods and authentication of the endpoints below; the names, types and meaning of request and
response fields; the HTTP status codes and the machine-readable error codes in section 2.

| Surface | Endpoints |
| --- | --- |
| OpenAI-format model endpoint | `POST /v1/chat/completions` |
| Anthropic-format model endpoint | `POST /v1/messages` |
| MCP proxy | `POST /mcp/:server` (what is accepted is defined by [mcp-matrix.md](mcp-matrix.md)) |
| Admin API (bearer operator token) | `POST /admin/agents`, `GET /admin/agents`, `PATCH /admin/agents/:id`, `POST /admin/agents/:id/rotate-key`, `GET /admin/spend-check`, `GET /admin/approvals`, `POST /admin/approvals/:id/approve`, `POST /admin/approvals/:id/reject`, `GET /admin/stats`, `GET /admin/ledger`, `GET /admin/ledger/facets`, `GET /admin/ledger/export.csv`, `GET /admin/ledger/verify` |
| Health | `GET /health` |

The same rules cover `POST /admin/operators`, `GET /admin/operators`, `POST /admin/operators/:id/revoke`,
`GET /admin/policy-revisions/:id`, `GET /admin/ledger/export.ndjson`, `GET /admin/ledger/checkpoint` and
`POST /admin/ledger/verify`. Bootstrap alone manages operator creation/revocation; named tokens authenticate other admin operations.

**Compatible change (allowed in a minor or patch release):**

- adding an endpoint, an optional request field, an optional query parameter, or a response field;
- adding a value to an open set (a new `reason`, a new `action`, a new `type` of error) — clients MUST ignore values and
  fields they do not know;
- making validation more permissive; fixing a response that contradicted this documentation;
- improving a `message` text.

**Breaking change (major release only):** removing or renaming an endpoint, field, query parameter or error code;
changing a type, a unit (amounts are micro-USD integers in the ledger and USD decimals in the admin API) or a default;
making an optional request field required; making validation stricter for input that was accepted; changing a status
code of an existing outcome; changing the meaning of a field.

Response shapes pinned by golden samples in `test/fixtures/contracts/`: `agent` objects (`id`, `name`, `allowedModels`,
`allowedTools`, `approvalTools`, `dailyBudgetUsd`, `spentTodayUsd`, `reservedTodayUsd`, `active`), `key` returned once on
creation and rotation, ledger `entries`, approvals, and the pass-through of the provider response bodies.

## 2. Error codes

Stable, because clients branch on them:

| Where | Stable values |
| --- | --- |
| `error.code` on `/v1/chat/completions` (body `{ "error": { "message", "type", "code" } }`) | `invalid_api_key` (401), `missing_model` (400), `model_not_allowed` (403), `agent_disabled` (403), `budget_exceeded` (429), `ledger_unavailable` (503), `agent_unverifiable_during_outage` (503), `upstream_unreachable` (502), `rate_limited` (429 with `Retry-After`) |
| `error.type` on `/v1/chat/completions` | `invalid_request_error`, `gardagent_policy`, `api_error` |
| `error.type` on `/v1/messages` (body `{ "type": "error", "error": { "type", "message", "code"? } }`) | `authentication_error`, `permission_error`, `rate_limit_error`, `api_error`, `invalid_request_error` |
| JSON-RPC `error.code` on `/mcp/:server` | `-32600` (invalid request), `-32602` (missing tool name), `-32603` (internal), `-32000` (gateway refusal: key, unknown server, ledger, unreachable), `-32001` (tool not allowed), `-32002` (approval rejected or timed out), `-32003` (approval unavailable during outage). `-32601` (refused methods), `-32004` (rate limited, currently HTTP 200 with `Retry-After`) |
| Admin API | the HTTP status (`400`, `401`, `403`, `404`, `409`, and authentication-limit `429`); the body is `{ "error": "<text>" }` |

The `message` / `error` text is **not** stable. Provider errors (`upstream_error`, any status the provider returns) are
relayed unchanged and are the provider's contract, not Gardagent's. Model rate refusals answer HTTP 429 with `Retry-After` and `rate_limited`. MCP requests currently use HTTP 200
with `-32004` and `Retry-After`; notifications use HTTP 429 with an empty body. This status mismatch remains a
[readiness gap](v1-readiness.md), not a claim that the HTTP 429 exit criterion is satisfied.

## 3. Agent key format

Stable: an agent key is the prefix `ga_` followed by at least 16 characters of base64url; it is sent as
`Authorization: Bearer <key>` (or `x-api-key` on `/v1/messages`); the gateway stores only its SHA-256 (hex). Keys issued
by any 1.x keep working on every later 1.x until rotated or disabled. The length and the random source of newly issued
keys MAY change within these constraints. Operator tokens (M05) use the distinct prefix `gaop_`.

## 4. Ledger entry format

Governed by [ledger-format.md](ledger-format.md), which is normative. Stable:

- the field names, types and meaning of every entry field of format version 1 and of any later format version;
- the canonicalisation, the hash input and the chain rule;
- **an entry that verified once verifies forever**: a new release MUST NOT change the hash of an entry already
  written. This is why a new field must be absent from the entry (and from the hash input) when it has no value, and why
  no migration may backfill, rewrite or reorder ledger rows;
- the format version marker: an unmarked entry is version 1.

Compatible: new optional fields under a new format version, new `action` and `reason` values. Breaking: changing how
existing fields are hashed, or making a verifier of an older format version reject entries it accepted. The CSV export
(`seq, timestamp, agent, action, model, verdict, reason, input_tokens, output_tokens, cost_usd, request_hash,
response_hash, entry_hash`) is stable in column names and order; columns may only be appended at the end in a major
release.

## 5. Database schema

The schema is changed only by versioned migrations (M03). Stable from 1.0:

- the tables and columns that exist at 1.0 keep their name, type and meaning within 1.x; the ledger stays append-only
  (a database trigger rejects `UPDATE` and `DELETE`);
- migrations are forward-only, idempotent when re-run, transactional, and applicable to a database created by 0.3.0
  (adoption) and to any database of an earlier 1.x;
- a migration never changes ledger hashes or recorded spend;
- columns and tables may be added in a minor release; a column is dropped or retyped only in a major release.

Not stable: indexes (they may be added, changed or removed), and the layout of tables marked internal in the code
(idempotency keys, settlement keys, reservations). External tools may read `ledger`, `agents` (except `key_hash`
semantics), `approvals` and `agent_spend`; they MUST NOT write to the database.

Downgrade is not supported: a database migrated by 1.x must not be opened by an older binary; the [upgrade guide](upgrade-0.3-to-1.0.md)
requires restoring a matched backup and executable instead.

## 6. Environment variables

Stable: the names, accepted values and meaning of the variables read at start-up, including
`GARDAGENT_ADMIN_TOKEN`, `DATABASE_URL`, `PORT`, `HOST`, `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`,
`ANTHROPIC_UPSTREAM_BASE_URL`, `ANTHROPIC_UPSTREAM_API_KEY`, `UPSTREAM_TIMEOUT_MS`, `UPSTREAM_FORWARD_HEADERS`,
`GARDAGENT_MODE`, `GARDAGENT_PRICES`, `GARDAGENT_MCP_SERVERS`, `GARDAGENT_APPROVAL_TIMEOUT_MS`,
`GARDAGENT_DEFAULT_MAX_OUTPUT_TOKENS`, `GARDAGENT_DB_OUTAGE`, `GARDAGENT_LEDGER_SPOOL`, `GARDAGENT_SPOOL_MAX_BYTES`,
`GARDAGENT_DB_CALL_TIMEOUT_MS`, `GARDAGENT_DB_CONNECT_TIMEOUT_MS`, `GARDAGENT_DB_PROBE_TIMEOUT_MS`,
`GARDAGENT_AGENT_CACHE_TTL_MS`, `GARDAGENT_AUTH_FAIL_LIMIT`, `GARDAGENT_AUTH_FAIL_WINDOW_MS`,
`GARDAGENT_ADMIN_ALLOWED_CIDRS`, `GARDAGENT_TRUST_PROXY`. (`GARDAGENT_CONSOLE_DIR` is used by the container image.)

Compatible: new optional variables with a default that preserves the old behaviour; accepting more values. Breaking:
removing or renaming a variable, changing a default, changing the meaning of a value. A deprecated variable keeps
working, with a warning, for the whole deprecation period.

## 7. Deprecation rule

A stable surface is deprecated by (1) marking it deprecated in this repository's documentation and changelog, (2) where
a runtime signal exists, emitting one (a startup warning for a variable, a `Deprecation` response header for an
endpoint), and (3) keeping it working for at least **one minor release and at least 90 days**, whichever is longer,
before it can be removed in the next major release. Security fixes are the one exception: they may break a surface in a
patch release, with the reason stated in the changelog.

## 8. What is explicitly not covered

- The web console: its pages, components, URLs under `/console/`, and its use of the admin API beyond the documented
  endpoints.
- Log text and log structure written to the standard output or error, and fastify's own log fields.
- Message texts (`message`, admin `error` strings), the exact wording of console strings, and the language of messages.
- The spool file format (`GARDAGENT_LEDGER_SPOOL`) and the validation/pilot harnesses under `tools/`.
- Performance characteristics and timings, in-memory structures, the `MemoryStore` (a test double).
- Default model prices (`DEFAULT_PRICES`): they follow providers and may change in any release; configured prices are
  stable.
- Behaviour of the gateway when it is misconfigured or used with an unsupported database version.
- Provider and MCP-server behaviour that Gardagent relays.

## 9. Contract tests

| Contract | Test |
| --- | --- |
| Ledger format version 1 | `apps/gateway/test/contracts.test.ts` verifies the golden entries in `test/fixtures/contracts/` with the current code and with an independent implementation of [ledger-format.md](ledger-format.md). It fails if a version 1 entry stops verifying. |
| HTTP API (model endpoints, admin) | The same test compares the shape of live responses to the golden request/response samples. |
| Database schema | `apps/gateway/test/migrations.test.ts`: fresh install, populated 0.3.0 adoption, re-run, failure rollback and version refusal. Dump/restore rehearsal remains a [readiness gap](v1-readiness.md). |
| Format version 2 | `packages/core/test/ledger.test.ts`, `apps/gateway/test/migrations.test.ts` and `packages/verify/test/verify.test.ts` exercise version 2 and mixed chains using constructed entries; the existing version 1 golden fixtures remain unchanged. |

A golden fixture is only ever **added to**; changing or deleting one is a breaking change and needs a major version.
