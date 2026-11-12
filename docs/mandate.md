# Mandate model (v1)

Direction: every agent acts under a mandate, every mandate has limits, every action leaves a verifiable trace, and the
party that delegates keeps its own proof. This document fixes what "mandate" means in Gardagent v1 and what the ledger
records about it. It is a specification for M05; in 0.3.0 none of it exists beyond the agent record and the single
admin token. The ledger fields it relies on are defined in [ledger-format.md](ledger-format.md), section 2.

## 1. Vocabulary

- **Agent**: an automated caller holding an agent key (`ga_…`). It acts under one policy at a time.
- **Policy**: the limits of an agent: allowed models, allowed tools, tools that need approval, daily budget, and
  whether the agent is active.
- **Policy revision**: an immutable snapshot of a policy, identified by a hash.
- **Operator**: a party that administers Gardagent (creates agents, changes policy, decides approvals). Authenticated by
  an operator token.
- **Approval**: a decision by an operator on one specific tool call, bound to the hash of its arguments.

## 2. Operators

- An operator has an **id** (opaque, assigned by the gateway, never reused), a **label** chosen by whoever creates it
  (free text such as `alice-laptop` or `ci-release`), a creation time, and an optional revocation time.
- An operator authenticates with a **token**. The gateway stores only the SHA-256 of the token (as it already does for
  agent keys), never the token. The token is shown once, at creation. Tokens have a distinct prefix (`gaop_`) so that
  they can never be confused with agent keys (`ga_`).
- **Bootstrap operator.** `GARDAGENT_ADMIN_TOKEN` keeps working exactly as in 0.3.0 and authenticates the operator whose
  id is the fixed string `bootstrap`. It is not stored in the database and cannot be revoked other than by changing the
  environment variable. Only the bootstrap operator can create or revoke other operators (an operator cannot grant
  itself or others more power than it has, and there is one root of trust to protect).
- **Revocation** is a soft delete: a revoked token stops authenticating at once, and the operator row stays so that the
  ids found in old ledger rows still resolve to a label.
- The ledger records the operator **id**, not the label (labels can be edited) and never the token.
- No SSO, no roles in v1: every operator may do everything the 0.3.0 admin token could do, except managing operators.

**Limit, stated plainly.** An operator token proves possession of the token. It does not prove the identity of a human:
a token can be copied, shared, or stolen, and the label is whatever the creator typed. The ledger therefore says "the
holder of operator token `X` did this", never "person `Y` did this". Binding tokens to people is an organisational
control (one token per person, revoke on departure), not something Gardagent enforces.

## 3. Policy revisions

A policy revision is created every time an agent is created or its policy changes (`POST /admin/agents`,
`PATCH /admin/agents/:id`).

- **Content.** The snapshot is the canonical JSON ([ledger-format.md](ledger-format.md), section 1.2) of:

  ```
  { "v": 1, "allowedModels": [...], "allowedTools": [...], "approvalTools": [...],
    "dailyBudget": <micro-USD integer>, "active": <boolean> }
  ```

  The three lists are sorted and de-duplicated before hashing, so that reordering a list is not a new revision. The
  agent's name and key are not part of the policy. The classification of MCP tools as read or write is part of the MCP
  server configuration (`GARDAGENT_MCP_SERVERS`), not of the agent, and is therefore **not** covered by the revision;
  this is a known limit.
- **Identifier.** `policyRev` is the lowercase hex SHA-256 of that canonical JSON. Equal policies have equal ids, across
  agents and across time. The id is a content hash, so it can be recomputed from the snapshot by anyone.
- **Immutable store.** The snapshot is stored once under its id in an append-only table (it cannot be updated or
  deleted, like the ledger). Together with the ledger this lets a third party answer "what were the limits of this
  agent when this row was written" without trusting the live agent record.
- **Reference at admission.** Every ledger row that results from an admission decision against an agent's policy
  (allowed or denied: model calls, MCP tool calls, approval requests, policy denials) carries the `policyRev` in force
  at the moment of admission, read once per request. A request is judged against exactly one revision, even if the
  policy changes while it is in flight. Rows with no agent (`invalid_key`) carry none.
- **Changes are rows.** The `admin.agent.create` and `admin.agent.update` rows carry the `policyRev` of the **new**
  revision and the `operatorId` of the operator who made the change. The previous revision is the `policyRev` of the
  agent's previous row of that kind, or recoverable from the snapshot table.
- **Budget day and amount.** The revision contains `dailyBudget` in micro-USD; the budget day is the UTC day of
  admission, as in 0.3.0. Revisions do not change budget semantics.

## 4. Approvals and the entry they authorize

0.3.0 already binds an approval to the SHA-256 of the arguments (`argsHash`, equal to the `requestHash` of the ledger
rows). Version 2 adds the correlation between the rows:

1. When an approval is needed, the gateway creates the approval (a UUID) and writes `mcp.approval.requested` with
   `approvalRef` = that id, the `requestHash` of the arguments and the agent's `policyRev`.
2. An operator decides. The gateway writes `mcp.approval.decided` with the same `approvalRef`, the same `requestHash`,
   `verdict` `allowed`/`denied`, and the **`operatorId` of the authenticated operator**. A decision already taken
   answers 409 and writes nothing, as in 0.3.0.
   If nobody decides, the gateway itself writes `mcp.approval.decided` with `verdict` `denied`, `reason` `expired`, the
   same `approvalRef` and `requestHash`, and **no `operatorId`**: no operator authenticated it, so none is named.
3. If approved, the call is forwarded and its `mcp.tools/call` row carries the same `approvalRef`.

So the chain of proof for one action is three rows sharing an `approvalRef`, the same `requestHash` and the same
`agentId`, in increasing `seq`, where the middle one names who decided. A `mcp.tools/call` row with an `approvalRef` that
has no earlier matching allowed decision is a verification failure.

What this does not prove: that the operator saw or understood the arguments (the readable summary is kept only in the
`approvals` table, truncated to 500 characters, and never in the ledger), or that the human behind the token is who the
label says.

## 5. What is deliberately absent in v1

No SSO or external identity provider, no roles or per-agent scopes for operators, no policy approval workflow (a policy
change takes effect immediately), no signing of ledger rows with operator keys. Each of these is a possible later
addition and none is prepared by the v1 design beyond the fields above.
