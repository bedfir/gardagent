#!/bin/sh
# Criterion (h): backup then restore yields a valid ledger.
# Same logic as deploy/backup.sh and deploy/restore.sh (pg_dump | gzip, restore with psql, restart a gateway,
# verify the chain), adapted to the dev compose and made non-destructive: the dump is restored into a scratch
# database served by a second, temporary gateway, so the live database is never dropped.
# Run from the repository root. Reads secrets from ./.env without printing them.
set -eu
cd "$(dirname "$0")/../.."
ENV_FILE=${PZ_ENV_FILE:-./.env}
DC="docker compose${PZ_COMPOSE_FILE:+ -f $PZ_COMPOSE_FILE}"
# The env file is a Docker env file (raw values, spaces allowed): never source it, read the two values needed.
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
GARDAGENT_ADMIN_TOKEN=$(envval GARDAGENT_ADMIN_TOKEN); POSTGRES_PASSWORD=$(envval POSTGRES_PASSWORD)

NET=${PZ_NETWORK:-gardagent_default}
IMAGE=${PZ_GATEWAY_IMAGE:-gardagent-gateway}
OUT=${PZ_OUT:-/tmp/pilot-zero-backup}
mkdir -p "$OUT"
BK="$OUT/gardagent-$(date +%Y%m%d-%H%M%S).sql.gz"
SCRATCH_DB=gardagent_restore
SCRATCH_GW=ga-pz-restore

api() { # $1 = url
  docker run --rm --network "$NET" -e T="$GARDAGENT_ADMIN_TOKEN" node:22-alpine \
    node -e 'fetch(process.argv[1],{headers:{authorization:"Bearer "+process.env.T}}).then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.error(e.message);process.exit(1)})' "$1"
}
field() { sed -n "s/.*\"$1\":\\(\"[^\"]*\"\\|[a-z0-9]*\\).*/\\1/p" | head -n 1; }

cleanup() {
  docker rm -f "$SCRATCH_GW" >/dev/null 2>&1 || true
  $DC exec -T postgres psql -U gardagent -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH_DB;" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

LIVE=$(api http://gateway:8080/admin/ledger/verify)
echo "live ledger:     $LIVE"

$DC exec -T postgres pg_dump -U gardagent -d gardagent | gzip > "$BK"
echo "backup written:  $BK ($(wc -c < "$BK") bytes)"

$DC exec -T postgres psql -U gardagent -d postgres -c "CREATE DATABASE $SCRATCH_DB;" >/dev/null
zcat "$BK" | $DC exec -T postgres psql -U gardagent -d "$SCRATCH_DB" >/dev/null

export DATABASE_URL="postgres://gardagent:${POSTGRES_PASSWORD}@postgres:5432/${SCRATCH_DB}"
docker run -d --name "$SCRATCH_GW" --network "$NET" --env-file "$ENV_FILE" -e DATABASE_URL -e PORT=8081 "$IMAGE" >/dev/null
i=0
until api http://$SCRATCH_GW:8081/health 2>/dev/null | grep -q '"status":"ok"'; do
  i=$((i + 1)); [ "$i" -gt 30 ] && { echo "restored gateway did not become healthy" >&2; exit 1; }
  sleep 2
done
RESTORED=$(api http://$SCRATCH_GW:8081/admin/ledger/verify)
echo "restored ledger: $RESTORED"

L_HASH=$(echo "$LIVE" | field lastHash); R_HASH=$(echo "$RESTORED" | field lastHash)
L_N=$(echo "$LIVE" | field checked); R_N=$(echo "$RESTORED" | field checked)
if echo "$RESTORED" | grep -q '"valid":true' && [ "$L_HASH" = "$R_HASH" ] && [ -n "$R_HASH" ] && [ "$R_N" -ge "$L_N" ]; then
  echo "(h) PASS  restored ledger valid, $R_N entries (live had $L_N when dumped), same head hash"
else
  echo "(h) FAIL  live=$LIVE restored=$RESTORED"
  exit 1
fi
