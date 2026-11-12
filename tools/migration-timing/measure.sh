#!/bin/sh
# Measures the duration of historical 0.3.0 schema replay (the frozen test fixture) on a
# synthetic ledger. Everything runs in a throwaway PostgreSQL container (own name, no published port, removed at the end).
# usage: sh tools/migration-timing/measure.sh [rows=1000000] [repeats=3]
# Results go to stdout as "key value" lines; docs/migration-timing.md explains the method and the limits.
set -eu
ROWS=${1:-1000000}
REPEATS=${2:-3}
IMAGE=${PG_IMAGE:-postgres:16-alpine}
HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/../../apps/gateway/test/fixtures/schema-0.3.0.sql"
W=$(mktemp -d)
C="ga-mig-timing-$$"
trap 'docker rm -f "$C" >/dev/null 2>&1 || true; rm -rf "$W"' EXIT

# Frozen pre-M03 replay SQL; this is not the versioned startup path.
cp "$SRC" "$W/schema.sql"
test -s "$W/schema.sql"

docker run -d --name "$C" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=mig "$IMAGE" >/dev/null
i=0
until docker exec "$C" pg_isready -U postgres -d mig >/dev/null 2>&1 && docker exec "$C" psql -U postgres -d mig -qAtc "SELECT 1" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "postgres did not start" >&2; exit 1; }; sleep 1
done
docker cp "$W/schema.sql" "$C:/schema.sql"
psql() { docker exec -i "$C" psql -U postgres -d mig -v ON_ERROR_STOP=1 -qAt "$@"; }

echo "server $(psql -c 'SHOW server_version')"
echo "rows $ROWS repeats $REPEATS"

# Empty database, schema applied once, then the ledger is filled.
psql -1 -f /schema.sql >/dev/null
START=$(date +%s)
psql <<SQL
INSERT INTO agents (id, name, key_hash, allowed_models, daily_budget)
SELECT 'agent-' || n, 'agent-' || n, md5('k' || n), ARRAY['m'], 0 FROM generate_series(0, 19) n;
INSERT INTO ledger (seq, ts, agent_id, action, model, verdict, reason, upstream_status, prompt_tokens, completion_tokens, cost,
                    request_hash, response_hash, prev_hash, hash, degraded)
SELECT i,
       to_char(timestamp '2026-07-01' + i * interval '6 seconds', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       'agent-' || (i % 20),
       'chat.completions',
       (ARRAY['model-a','model-b','model-c','model-d','model-e'])[1 + i % 5],
       CASE WHEN i % 10 = 0 THEN 'denied' ELSE 'allowed' END,
       NULL, 200, 100 + i % 900, 50 + i % 400, (i % 5000) * 100,
       md5(i::text) || md5((i + 7)::text),
       md5((i + 13)::text) || md5((i + 29)::text),
       md5((i - 1)::text) || md5((i + 5)::text),
       md5(i::text || 'h') || md5((i * 3)::text),
       false
  FROM generate_series(1, $ROWS) i;
ANALYZE ledger;
SQL
echo "load_seconds $(( $(date +%s) - START ))"
echo "ledger_rows $(psql -c 'SELECT count(*) FROM ledger')"
echo "ledger_table_bytes $(psql -c "SELECT pg_table_size('ledger')")"
echo "ledger_indexes_bytes $(psql -c "SELECT string_agg(indexrelid::regclass || '=' || pg_relation_size(indexrelid), ' ' ORDER BY indexrelid::regclass::text) FROM pg_index WHERE indrelid = 'ledger'::regclass")"

# Full migration, in one transaction like pool.query(SCHEMA) (multi-statement simple query): elapsed milliseconds.
cat > "$W/timed-migrate.sql" <<'SQL'
SELECT clock_timestamp() AS t0 \gset
BEGIN;
\i /schema.sql
COMMIT;
SELECT round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000);
SQL
docker cp "$W/timed-migrate.sql" "$C:/timed-migrate.sql"
migrate_ms() { psql -f /timed-migrate.sql | tail -1; }

DROP_NEW_INDEXES='DROP INDEX IF EXISTS ledger_agent_seq_idx; DROP INDEX IF EXISTS ledger_model_seq_idx;'

echo "== 1. migration on a database already up to date (every restart)"
n=0; while [ $n -lt "$REPEATS" ]; do n=$((n + 1)); echo "noop_migrate_ms $(migrate_ms)"; done

echo "== 2. upgrade from v0.1.0: ledger_agent_seq_idx, ledger_model_seq_idx and ledger.degraded missing"
n=0; while [ $n -lt "$REPEATS" ]; do n=$((n + 1))
  psql -c "$DROP_NEW_INDEXES ALTER TABLE ledger DROP COLUMN IF EXISTS degraded;" >/dev/null
  echo "upgrade_v010_migrate_ms $(migrate_ms)"
done

echo "== 3. each ledger index alone (plain CREATE INDEX, no CONCURRENTLY, as in the migration)"
for spec in "ledger_ts_idx|ledger (ts)" "ledger_agent_ts_idx|ledger (agent_id, ts)" "ledger_agent_seq_idx|ledger (agent_id, seq)" "ledger_model_seq_idx|ledger (model, seq)"; do
  name=${spec%%|*}; def=${spec#*|}
  n=0; while [ $n -lt "$REPEATS" ]; do n=$((n + 1))
    psql -c "DROP INDEX IF EXISTS $name;" >/dev/null
    ms=$(psql <<SQL | tail -1
SELECT clock_timestamp() AS t0 \gset
CREATE INDEX $name ON $def;
SELECT round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000);
SQL
)
    echo "create_index_ms $name $ms"
  done
done

echo "== 4. ledger.degraded column alone (ADD COLUMN ... NOT NULL DEFAULT FALSE)"
n=0; while [ $n -lt "$REPEATS" ]; do n=$((n + 1))
  psql -c "ALTER TABLE ledger DROP COLUMN IF EXISTS degraded;" >/dev/null
  ms=$(psql <<'SQL' | tail -1
SELECT clock_timestamp() AS t0 \gset
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS degraded BOOLEAN NOT NULL DEFAULT FALSE;
SELECT round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000);
SQL
)
  echo "add_degraded_column_ms $ms"
done

echo "== 5. what a concurrent session waits during the upgrade migration (case 2), rolled back so no row is kept"
cat > "$W/probe-insert.sql" <<'SQL'
SELECT clock_timestamp() AS t0 \gset
BEGIN;
INSERT INTO ledger (seq, ts, action, verdict, prompt_tokens, completion_tokens, cost, prev_hash, hash)
VALUES (1000000000, '2026-12-31T00:00:00.000Z', 'probe', 'allowed', 0, 0, 0, 'p', 'probe-hash');
SELECT round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000);
ROLLBACK;
SQL
cat > "$W/probe-select.sql" <<'SQL'
SELECT clock_timestamp() AS t0 \gset
SELECT count(*) FROM ledger WHERE seq = 5 \gset
SELECT round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000);
SQL
docker cp "$W/probe-insert.sql" "$C:/probe-insert.sql"
docker cp "$W/probe-select.sql" "$C:/probe-select.sql"
n=0; while [ $n -lt "$REPEATS" ]; do n=$((n + 1))
  psql -c "$DROP_NEW_INDEXES ALTER TABLE ledger DROP COLUMN IF EXISTS degraded;" >/dev/null
  (migrate_ms > "$W/mig.out") &
  sleep 0.3
  echo "insert_during_migration_wait_ms $(psql -f /probe-insert.sql | tail -1)"
  echo "select_during_migration_wait_ms $(psql -f /probe-select.sql | tail -1)"
  wait
  echo "migration_ms_in_that_run $(cat "$W/mig.out")"
done
echo "done"
