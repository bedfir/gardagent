# Ledger format

This document is the written contract of the Gardagent ledger. A third party who has a copy of the entries, and nothing
else, can verify the chain by following it. Format version 1 is what 0.3.0 writes, described from the code in
`packages/core/src/hash.ts`, `packages/core/src/ledger.ts` and `packages/core/src/types.ts`. Format version 2 is the
format implemented by M04 for storage and generic verification; M05 supplies mandate metadata and gateway approval
verification.

The words "MUST", "MUST NOT" and "MAY" are used in their usual normative sense.

## 1. Format version 1 (0.3.0)

### 1.1 Entry

An entry is a JSON object. These fields are always present, with exactly these names and types:

| Field | Type | Meaning |
| --- | --- | --- |
| `seq` | integer | Position in the chain, starting at 1, no gap. |
| `prevHash` | string, 64 lowercase hex | `hash` of the entry with `seq - 1`; 64 zeros (`GENESIS_HASH`) for `seq` 1. |
| `hash` | string, 64 lowercase hex | Fingerprint of this entry (section 1.3). Not part of its own input. |
| `ts` | string | ISO 8601 UTC time of the event (`Date.toISOString()`, for example `2026-01-01T00:00:00.000Z`). |
| `agentId` | string or `null` | Agent concerned; `null` when no agent could be identified (invalid key). |
| `action` | string | What happened, for example `chat.completions`, `messages`, `mcp.tools/call`, `mcp.approval.requested`, `mcp.approval.decided`, `admin.agent.create`. |
| `model` | string or `null` | Model name; for MCP rows `<server>/<tool>` plus `#read` or `#write` once the tool is known. |
| `verdict` | `"allowed"` or `"denied"` | Decision. |
| `reason` | string or `null` | Machine-readable reason (`model_not_allowed`, `budget_exceeded`, `invalid_key`, `upstream_error`, `interrupted_no_response`, …). |
| `upstreamStatus` | integer or `null` | HTTP status returned by the provider or MCP server; `null` when there was no upstream call. |
| `promptTokens` | integer | Tokens counted as input (0 when unknown). |
| `completionTokens` | integer | Tokens counted as output (0 when unknown). |
| `cost` | integer | Cost in micro-USD (1 USD = 1 000 000). Never a fraction. |
| `requestHash` | string or `null` | SHA-256 (hex) of the canonical JSON of the request body for the model endpoints; for MCP `tools/call` and approval rows, of `params.arguments ?? {}`; for other MCP methods (from M08), of `params ?? {}`; for admin rows, of the event content the gateway built for that action (`auditInput`), which is not necessarily the HTTP request body. It lets the holder of the original content confirm it matches, without the ledger keeping it; it does not prove what an HTTP client sent. |
| `responseHash` | string or `null` | SHA-256 (hex) of the response text relayed to the client; `null` when empty. |

One optional field exists:

| Field | Type | Meaning |
| --- | --- | --- |
| `degraded` | `true` | Present **only** when the row was written late from the local spool during a database outage. It is never written as `false`. |

Every nullable field above is always present in the entry, with the value `null` when it has no value. Only `degraded`
may be absent.

An entry with a key that is not listed here is not a valid version 1 entry as written by Gardagent. A verifier that
recomputes the hash from "every key except `seq`, `prevHash`, `hash`" (as the reference implementation does) will
include such a key in the hash input, so an unknown key is neither ignored nor tolerated: it either belongs to a later
format version (section 2) or it breaks the hash.

### 1.2 Canonical JSON

`canonicalJson(value)`:

- `null`, booleans, numbers and strings are serialised with ECMAScript `JSON.stringify`. Numbers are therefore
  written without exponent for the integer ranges used here, without leading zeros and without a fractional part.
  Strings are escaped as `JSON.stringify` does, and non-ASCII characters are **not** escaped to `\uXXXX` (lone
  surrogates are).
- An array is `[` + the canonical form of each element joined by `,` + `]`, in the original order.
- An object is `{` + its members joined by `,` + `}`, where each member is `JSON.stringify(key)` + `:` + the canonical
  form of the value. Members are sorted by key in ascending order of UTF-16 code units (the `<` operator on strings),
  recursively. A member whose value is `undefined` is omitted. (A member whose value is `null` is **not** omitted.)
- No whitespace is added anywhere.

### 1.3 Hash input and hash

```
hash = lowercase_hex( SHA-256( UTF-8( canonicalJson({ seq, prevHash, ...input }) ) ) )
```

where `input` is the entry minus `seq`, `prevHash` and `hash`. In other words the hash input is the canonical JSON of
**every field present in the entry except `hash`**.

Two consequences matter for compatibility:

1. **A field that is absent is not hashed; a field that is present is hashed, whatever its value.** Gardagent stores
   `degraded` as a boolean column that defaults to `FALSE`. When it rebuilds an entry from the database it adds
   `degraded: true` only if the column is true. If it were to add `degraded: false` to old rows, their hash input would
   change and the chain would break. Any new field MUST follow the same rule: *absent from the entry means absent from
   the hash input, and old entries are never given a default value.*
2. The hash covers the field values but not the database representation. `ts` is hashed as the text that was stored.

### 1.4 Chain rule

An entry list is a valid chain, starting from `startPrevHash` (the genesis hash when starting from the beginning), if
for every entry in order:

1. `seq` equals the previous `seq` plus 1 (the first entry sets the expected value; verifying a sub-range is allowed
   when `startPrevHash` is the `hash` of the entry just before it). A mismatch is reported as `seq_gap`.
2. `prevHash` equals the `hash` of the previous entry (or `startPrevHash` for the first). A mismatch is reported as
   `link_mismatch`.
3. The recomputed hash equals `hash`. A mismatch is reported as `hash_mismatch`.

Verification checks sequence and link first, then the supported format version, then the hash. Version 2 adds
content and version-ordering checks after the hash (section 2.3). The `head` of a valid chain is the `hash` of its last
entry (the genesis hash if the chain is empty).

### 1.5 What version 1 does and does not prove

The chain proves that entries were not modified, reordered, or removed from the middle, **relative to the entries you
hold**. It does not prove that the chain you hold is complete: removing entries at the end, or rewriting the whole
chain from some point on with consistent hashes, produces a chain that still verifies. Those two attacks are
detectable only by comparing the head against a value (a checkpoint) that was kept outside the database; see the
export and checkpoint work in M06. The chain also proves nothing about the truth of the content of a row (for example
that a provider really answered with `responseHash`), only that the row is the one that was written.

Arguments of MCP calls and request bodies are never stored in the ledger, only their hashes. The readable summary of
MCP arguments lives in the `approvals` table.

### 1.6 Where version 1 entries are visible

`GET /admin/ledger` returns `{ "entries": [...] }`, each entry in the shape of section 1.1 with `degraded` present only
when true. The golden fixtures in `test/fixtures/contracts/` are such entries, produced by the real code paths, and
`apps/gateway/test/contracts.test.ts` fails if any of them stops verifying.

## 2. Format version 2

Version 2 records the mandate (see [mandate.md](mandate.md)) in the ledger. It adds fields and a version marker without
changing a single byte of the hash of a version 1 entry.

### 2.1 New fields

All new fields are **optional and absent unless they have a value**. They are never written as `null`, an empty string
or a default.

| Field | Type | Present on | Meaning |
| --- | --- | --- | --- |
| `formatVersion` | integer `2` | Every entry written by a version 2 writer | Format version marker. |
| `policyRev` | string, 64 lowercase hex | Rows that result from an admission decision against an agent's policy (allowed or denied), and `admin.agent.*` rows | Identifier of the immutable policy revision in force (the SHA-256 of its canonical form; see mandate.md). |
| `operatorId` | string | `admin.*` rows and `mcp.approval.decided` rows written for a human decision | Id of the operator whose token authenticated the action. The bootstrap operator has the id `bootstrap`. Never the token. Absent on system-written rows (see 2.3). |
| `approvalRef` | string | `mcp.approval.requested`, `mcp.approval.decided`, and the `mcp.tools/call` row that the approval authorized | Id of the approval request, so that the three rows can be matched. |

Names are camelCase like the existing fields. The matching database columns (snake_case: `format_version`, `policy_rev`,
`operator_id`, `approval_ref`) are nullable with **no default**; a `NULL` column means the key is absent from the entry.

### 2.2 The rule that keeps version 1 entries verifiable

1. The hash input is, as in version 1, the canonical JSON of every field present in the entry except `hash`. The
   algorithm of sections 1.2 to 1.4 is **unchanged** and is the only hash algorithm. There is no second code path for
   version 1.
2. The format version of an entry is the value of `formatVersion` if the key is present, and **1** if it is absent.
   Entries written before version 2 carry no marker, so their hash input is byte-for-byte what it was, and their stored
   hash still verifies. No existing row is rewritten or backfilled by any migration.
3. A writer MUST add `formatVersion: 2` to every new entry, and MUST NOT add any of the new fields to an entry without
   it. Because the marker is part of the hash input, it cannot be removed or changed afterwards without breaking the
   hash.
4. A reader that finds a `formatVersion` it does not know (anything other than absent or `2`) MUST report the chain as
   unverifiable (`unsupported_format`); it MUST NOT skip the entry or guess.
5. A reader MUST report a version 1 entry (no marker) that carries any of `policyRev`, `operatorId` or `approvalRef` as
   invalid, and MUST report an entry with `formatVersion: 2` that lacks the marker's companion rules (below) as invalid.
6. Format versions are non-decreasing along the chain: once an entry has `formatVersion: 2`, every later entry MUST
   have it too. Version 1 entries therefore form a prefix of the chain. (The hash chain already makes it impossible to
   change an entry's version in place; this rule additionally lets a verifier fail fast and gives a clean
   boundary for the upgrade.)
7. `degraded` keeps the version 1 rule: present only when `true`.

The first version 2 entry is chained to the last version 1 entry through `prevHash` as usual; the upgrade creates no
break and no special entry.

### 2.3 Companion rules checked by the verifier

M04 core verification checks generic field constraints: optional references must be non-empty strings, `policyRev`
must be 64 lowercase hex, and `degraded`, if present, must be true. It checks sequence, link, supported version,
hash, then content and version ordering. Unknown versions report `unsupported_format`; invalid content or a version
regression reports `invalid_format`. `verifyChain` accepts the preceding verified version as `startVersion` and
returns `lastVersion` with a successful result, including for an empty range. Paginated full-chain verification MUST
carry this state alongside the preceding hash across pages. Independent partial verification defaults to version 1
and checks version ordering only within the supplied range.
The action-specific approval checks below belong to the gateway verifier implemented with M05; they are not
performed by core verification. A version 2 marker alone does not establish that every optional mandate field is populated; historical references may be unavailable.

For entries of format version 2 (these are checks on content, in addition to the chain rule of section 1.4):

- `policyRev`, when present, is 64 lowercase hex.
- An `mcp.tools/call` row carrying `approvalRef` is matched by an earlier `mcp.approval.decided` row with the same
  `approvalRef`, `verdict: "allowed"`, the same `agentId` and the same `requestHash`. The `requestHash` equality is
  the binding between the human decision and the arguments that were then executed.
- An `mcp.approval.decided` row is one of two kinds, told apart by `reason`:
  - **Human decision** (`reason` is not `expired`): it MUST carry an `operatorId`.
  - **Automatic expiry** (`reason: "expired"`, `verdict: "denied"`): written by the gateway when the approval timed out
    or the waiting request was cancelled. No operator authenticated it, so it MUST NOT carry an `operatorId`, and the
    verifier reports one as invalid. It carries `approvalRef`, `requestHash` and `policyRev` like any decision. The
    absence of an operator is the statement "no human decided"; it is never attributed to the bootstrap operator.
  - An `mcp.tools/call` row never matches an expiry row as its authorizing decision (the match above requires
    `verdict: "allowed"`).

### 2.4 Compatibility impact

- Version 1 data: unchanged, verified unchanged. A test (M04) must verify the same fixtures with the version 2 code.
- Old verifier on new data: a 0.3.0 verifier given complete serialized JSON entries recomputes the hash from every present key, so it still computes the right
  hash for version 2 entries and reports a valid chain; it simply does not check the companion rules. This is the
  reason new fields are hashed rather than stored outside the hash.
- The CSV export columns do not change in version 2 (see [compatibility.md](compatibility.md)).
- Anything added to this format must be describable without the words "model", "token" or "MCP" at the level of
  `packages/core`: the fields above are generic (a revision, an operator, a reference), and the MCP-specific rules in
  section 2.3 belong to the gateway's verifier, not to `hashEntry`.
