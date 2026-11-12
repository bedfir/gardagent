# Versioned migration timing (M03)

Versioned startup no longer replays the SQL measured below. A complete unversioned 0.3.0 database is adopted using
catalog reads plus a version record; no application table DDL, index build or trigger replacement runs. Subsequent
starts read migration metadata. A session advisory lock serializes the full migration sequence; each numbered
migration commits independently. Metadata creation and recording take locks on `schema_migrations` only.

Fresh installations still execute ordinary index builds and initial table/trigger creation in one transaction,
with locks held until commit. There are no existing ledger rows to scan in that case. An incomplete legacy schema
is refused; M03 does not execute the historical upgrade-from-0.1.0 path below. Advisory and DDL lock waits depend
on concurrent sessions and have no fixed upper duration. No new elapsed-time measurements have been run for M03;
the historical 17 ms and 2.6 s figures must not be used as versioned-startup estimates.

The script below remains a historical DDL benchmark using the frozen 0.3.0 fixture, not a benchmark of the new
migration runner. Runner measurements of fresh installation, populated adoption and versioned restart remain pending.

## Historical replay measurements (before M03)

# Migration timing on a large ledger

Measured on 2026-10-31 with `tools/migration-timing/measure.sh` (1 000 000 synthetic ledger rows, 3 repeats). Only
figures printed by that script are given here. Nothing is extrapolated.

## How the migration runs

* `apps/gateway/src/main.ts` calls `PgStore.migrate()` before the server listens. The gateway does not serve
  traffic while it migrates (`await pgStore.migrate()`, then `app.listen`).
* `migrate()` is a single `pool.query(SCHEMA)`: the whole schema text is sent as one multi-statement simple query, which
  PostgreSQL runs as one implicit transaction. Every lock taken stays until the end of the whole migration.
* Every statement is idempotent (`CREATE ... IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), so a restart on an up-to-date
  database only checks that things exist.
* No `CONCURRENTLY` anywhere. There are six `CREATE INDEX IF NOT EXISTS` statements (`approvals_status_idx`,
  `agent_reservations_agent_idx`, and four on `ledger`: `ledger_ts_idx`, `ledger_agent_ts_idx`, `ledger_agent_seq_idx`,
  `ledger_model_seq_idx`), all plain index builds. A plain `CREATE INDEX` takes a SHARE lock on the table, which blocks
  writes until the build ends. `CONCURRENTLY` cannot run inside a transaction block, so using it would mean running
  those statements outside `SCHEMA`.
* `DROP TRIGGER IF EXISTS ledger_no_update` then `CREATE TRIGGER` on `ledger` takes an ACCESS EXCLUSIVE lock, held to
  the end of the transaction. It comes last in the script, so reads on `ledger` are blocked only for the tail of the migration.
* Which objects are new depends on the version a database comes from (from `git log -S` and `git tag --contains`):
  `ledger_ts_idx` and `ledger_agent_ts_idx` exist since v0.1.0; `ledger_agent_seq_idx`, `ledger_model_seq_idx` and the
  `ledger.degraded` column come with v0.2.0. A database upgraded from v0.1.0 therefore builds two indexes on `ledger`
  at its first start. Later upgrades only run the no-op case.

## Method

* Throwaway container `postgres:16-alpine` (server 16.13), default configuration (default `maintenance_work_mem`,
  default `shared_buffers`), no published port, removed at the end of the script.
* The SQL under test is the text of the `SCHEMA` constant, extracted from `pg-store.ts` by the script, run with
  `BEGIN; \i schema.sql; COMMIT;` in `psql` to reproduce the single-transaction behaviour. Durations are
  `clock_timestamp()` differences taken inside PostgreSQL, so container start and `docker exec` overhead are not included.
* Data: 20 agents and 1 000 000 `ledger` rows made by `generate_series`: ISO text `ts` spaced by 6 s, 5 models, 10%
  denied, 64-hex-character request/response/previous/own hashes (they are synthetic and do not form a valid chain; the
  migration never reads them), `degraded = false`. Loaded in 38 s.
* Resulting sizes: table 409 731 072 bytes (about 391 MiB). Indexes in bytes: `ledger_pkey` 22 487 040,
  `ledger_hash_key` 124 035 072, `ledger_ts_idx` 49 741 824, `ledger_agent_ts_idx` 103 890 944,
  `ledger_agent_seq_idx` 59 842 560, `ledger_model_seq_idx` 31 629 312.
* Host: WSL2, 4 logical CPUs, 7.8 GB RAM, Docker 29.9.2 (overlayfs). Nothing else heavy was running.

## Results (milliseconds, 3 runs each)

| Case | Runs | Median |
|------|------|--------|
| 1. Full migration, database already up to date (every restart) | 18, 17, 17 | 17 |
| 2. Full migration, upgrade from v0.1.0 (`ledger_agent_seq_idx`, `ledger_model_seq_idx`, `degraded` missing) | 2598, 2934, 2516 | 2598 |
| 3a. `CREATE INDEX ledger_ts_idx ON ledger (ts)` | 981, 949, 1099 | 981 |
| 3b. `CREATE INDEX ledger_agent_ts_idx ON ledger (agent_id, ts)` | 2323, 2267, 2261 | 2267 |
| 3c. `CREATE INDEX ledger_agent_seq_idx ON ledger (agent_id, seq)` | 1419, 1347, 1363 | 1363 |
| 3d. `CREATE INDEX ledger_model_seq_idx ON ledger (model, seq)` | 1099, 1120, 1081 | 1099 |
| 4. `ADD COLUMN degraded BOOLEAN NOT NULL DEFAULT FALSE` | 6, 6, 6 | 6 |

Case 2 (about 2.6 s) is close to 3c + 3d (about 2.5 s) plus the column and the other statements, as expected.

### Effect on a concurrent session during case 2

A second session tried, 0.3 s after the migration started, an `INSERT` into `ledger` (rolled back afterwards) and a
`SELECT ... WHERE seq = 5`:

| Run | INSERT waited (ms) | SELECT waited (ms) | Migration (ms) |
|-----|--------------------|--------------------|----------------|
| 1 | 2204 | 4 | 2520 |
| 2 | 2305 | 5 | 2643 |
| 3 | 2184 | 5 | 2511 |

The insert waits until the migration commits (migration duration minus the 0.3 s head start). The read is not blocked
while the indexes build. The ACCESS EXCLUSIVE lock of the trigger statements was not isolated by this probe.

## What this says, and what it does not

* On this machine and this data, a ledger of one million rows adds about 2.6 s to the first start after an upgrade from
  v0.1.0, and 17 ms to a normal restart. During those 2.6 s no ledger write can happen from another process (for
  example an old gateway instance still running, or the spool replay of another instance); the new instance is not
  listening yet.
* Limits:
  * One data size only (1 000 000 rows). The scaling to larger ledgers was not measured and is not claimed.
  * Warm cache: the table had just been loaded, so it was in memory. A cold start on slow storage will take longer.
  * Fast local storage and default PostgreSQL settings; a loaded production server, a different `maintenance_work_mem`,
    or parallel index workers will change the figures.
  * Synthetic rows: widths and value distributions look like real ledger rows (about 400 bytes) but are not real data.
    The `agent_id`/`model` cardinalities (20 and 5) affect index size and build time.
  * Three repeats per case, no confidence interval. The gap between the fastest and slowest run is up to about 17% (case 2, and 3a at 16%).
  * The migration was run through `psql`, not through the `pg` driver of the gateway; the statements and the
    transaction scope are the same, the network path is not.
  * Concurrency was probed with one insert and one select, not with real gateway traffic.
* Not decided here: whether to move the ledger index builds to `CREATE INDEX CONCURRENTLY` outside the transaction. It would
  remove the write block, at the cost of a longer build, a second code path in `migrate()` and the handling of an
  invalid index left by a failed concurrent build.

## Reproduce

```sh
sh tools/migration-timing/measure.sh 1000000 3
```

Needs Docker and the `postgres:16-alpine` image. Takes a few minutes for 1 000 000 rows (the load alone took 38 s here).
