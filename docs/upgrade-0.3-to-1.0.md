# Upgrade from 0.3.0 to v1

This guide describes the v1 development branch; it does not announce a release.
Use a reviewed executable or image and retain its exact source revision or digest.
Do not run two gateway instances. The supported adoption baseline is a complete
0.3.0 PostgreSQL schema. Older or incomplete unversioned schemas are refused.
Read [the readiness gaps](v1-readiness.md) before scheduling an upgrade.

## 1. Prepare and back up

1. Record the running executable/image digest, PostgreSQL version, deployment
   configuration and volume mappings. Preserve credentials through your existing
   protected backup process; never put them in a report or repository.
2. Block new agent and administrative traffic at the edge, let active responses
   and pending approvals finish, and keep PostgreSQL up. Require a healthy database
   and an empty spool before proceeding. Do not discard a nonempty spool: recover
   the database and allow replay first. Requests interrupted by a hard stop have
   unknown outcomes; wait for reservation housekeeping and investigate them.
3. While quiescent, save `GET /admin/ledger/verify` (require `valid: true`), the last
   ledger sequence/hash from `GET /admin/ledger?order=desc&limit=1`, agent budget and
   spend values, and `GET /admin/spend-check`. Keep these records outside the
   database. On 0.3.0 there is no checkpoint endpoint. For all-day accounting,
   retain a read-only snapshot of `agent_spend`; spend-check covers today only.
4. Stop the gateway, leaving PostgreSQL running. Take a database dump and preserve
   the stopped spool volume separately, with its permissions, as a matched recovery
   set. For the deployment kit:

   ```sh
   docker compose -f deploy/docker-compose.prod.yml stop gateway
   sh deploy/backup.sh
   ```

   The script writes compressed SQL to `deploy/backups/` and keeps only the newest
   14 dumps. Copy this recovery set to protected independent storage. A database
   dump does not include the spool or deployment configuration. Never use `down -v`
   during upgrade or recovery.
5. Restore the dump into an isolated scratch database with the matching 0.3.0
   executable before touching the live installation. Verify the recorded sequence,
   head, ledger integrity and spend. Rehearse the new executable's migrations there
   too. Do not allow the scratch gateway to forward traffic. A successful dump
   command alone does not establish recoverability.

## 2. Apply migrations

Replace the executable/image with the reviewed v1 build while retaining the same
configuration and persistent volumes. With a source-built deployment kit, after
selecting that source revision, run:

```sh
docker compose -f deploy/docker-compose.prod.yml up -d --build gateway
```

Startup migrates before listening, under a PostgreSQL advisory lock. Current steps
in `apps/gateway/src/migrations.ts` are:

| Version | Effect |
| --- | --- |
| 1 | Adopt the complete 0.3.0 baseline without rebuilding its indexes or replacing its ledger trigger; create the baseline on a fresh database. |
| 2 | Add nullable ledger format/revision/operator/approval columns without defaults or historical backfill. |
| 3 | Create operators and immutable policy snapshots; assign current snapshots to existing agents. Historical approvals and ledger rows gain no invented attribution. |
| 4 | Add optional per-agent rate limits; existing agents remain unlimited. |

Each step and its version record commit together. Earlier successful steps remain
committed if a later step fails. On failure keep traffic blocked, diagnose the
reported migration number and cause, then retry with the same reviewed executable
or restore the recovery set. Never edit `schema_migrations` to force progress.
Index creation and other DDL can block; no upgrade duration is promised. The timing
report contains historical measurements, not v1 adoption timing.

Before reopening traffic require `/health` to report a healthy database and empty
spool, verify the full chain, compare the saved prefix sequence/hash and all-day
spend, and check agents and policy snapshots. Amounts remain integer micro-USD;
the budget day remains the UTC day of admission. Historical ledger hashes must be
identical: absent fields, including `degraded: false`, must not be inserted into
old serialized entries. New rows use format 2; verification supports the old prefix.

Capture `GET /admin/ledger/checkpoint` and retain it independently. Use the complete
paginated NDJSON export and [offline verifier](verify.md) to verify the chain against
retained checkpoints. Internal verification alone cannot detect a full rewrite or
tail truncation; a checkpoint detects changes only relative to its committed prefix.

## 3. Operators and client changes

`GARDAGENT_ADMIN_TOKEN` remains the bootstrap credential (minimum 32 characters).
There is no mandatory credential replacement, and existing agent keys remain valid.
Use bootstrap-authenticated `POST /admin/operators` with a label, for example
`{"label":"alice-laptop"}`, to issue one named token per operator. The response
contains `operator` and a once-only `token`; store it immediately in your protected
credential manager. Only its hash is stored. Named operators can administer agents
and decide approvals, but only bootstrap can create or revoke operators. Revocation
uses `POST /admin/operators/:id/revoke` and affects subsequent authentication.
The console accepts either credential. See [mandate.md](mandate.md).

New administration and approval decisions record the authenticated operator id;
requests retain the immutable policy revision captured at admission. Labels and
token possession do not prove a human identity. Old rows retain their original
absence of revision, operator and approval correlation fields.

MCP non-tool pass-through is a breaking change. In enforce mode nothing passes
silently: initialize and tools/list are governed and journaled, ping is local and
journaled, and only declared notifications are admitted. Listings and capabilities
are filtered. Resources, prompts, other undeclared methods and server requests are
refused without forwarding. GET and DELETE return 405, batches and malformed frames
are rejected. Tools retain allow-lists, read/write classification and argument-hash
bound approvals. Update clients that depended on pass-through or listening streams;
consult the complete [matrix](mcp-matrix.md), including observe-mode exceptions.
Observe mode forwards policy violations with recorded observed reasons; it still
refuses malformed framing and cannot bypass durable approval-state outage checks.

Optional `requestsPerMinute` and `maxConcurrentRequests` are configured through
POST/PATCH `/admin/agents`. Zero means unlimited; omitted PATCH fields are unchanged.
They share counters across both model endpoints and MCP for an agent. Model refusals return
HTTP 429 with `Retry-After` before budget reservation. MCP requests currently return HTTP 200
with JSON-RPC `-32004` and `Retry-After`; notifications return HTTP 429 with an empty body.
The MCP request status remains a gap against the HTTP 429 exit criterion. Approval waits occupy a concurrency slot.
Counters are process-local and reset on restart; observe mode records rather than
blocks a rate violation. See [rate-limits.md](rate-limits.md).

## 4. Restore instead of downgrading

Never start 0.3.0 against the migrated database: it has no newer-schema guard.
The v1 runner refuses schema versions newer than it supports; there are no down
migrations. Restoring the pre-upgrade snapshot loses every action recorded since
that snapshot, including issued tokens and policy changes. Preserve the failed
installation's database, spool and externally retained checkpoints for investigation
before replacing anything. Do not replay its newer spool into the older database.

Keep traffic blocked and stop the gateway. Restore the pre-upgrade dump into a
fresh isolated database using the matching PostgreSQL tools, with SQL errors fatal:

```sh
# replacement-db must be an empty, separately provisioned recovery database.
# Use your normal protected PostgreSQL connection settings.
gzip -t /safe/backup.sql.gz || exit 1
gzip -dc /safe/backup.sql.gz > /safe/recovery.sql || exit 1
psql -X --set ON_ERROR_STOP=on --single-transaction \
  --dbname replacement-db --file /safe/recovery.sql
```

Use protected local storage for the dump and temporary SQL, and check every exit
status. Select the saved 0.3.0 executable/configuration, point it at this restored
database and its matched pre-upgrade spool, and start it behind the blocked edge.
Require the saved head/sequence, valid chain, unchanged spend and expected agents
before switching traffic. If restoring a post-upgrade snapshot instead, use its
matching v1 executable and spool, never 0.3.0.

`deploy/restore.sh` is a destructive convenience helper for the deployment-kit
database: it restarts whichever gateway is currently selected. It does not select
the matching executable, restore the spool, compare spend, or invoke psql with
`ON_ERROR_STOP`. Its success message and chain check alone are insufficient for this
upgrade rehearsal. Use the explicit isolated procedure above and retain the source
recovery set until the restored installation has been checked.
