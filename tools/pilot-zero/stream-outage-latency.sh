#!/bin/sh
# v0.2-2: latency of streams (OpenAI and Anthropic SSE) that are in flight when PostgreSQL really goes away.
# Usage (repository root, production-like install): sh tools/pilot-zero/stream-outage-latency.sh open|closed [stop|pause]
#   open|closed  outage policy under test (observe mode in both cases: fail-closed + observe is a valid combination)
#   stop|pause   how PostgreSQL goes away: `stop` = process gone (connections reset / refused),
#                `pause` = process frozen (connections stay open and never answer: the worst case for a driver)
# Env: PZ_PROBES=N plain requests sent during the outage (default 22; 0 = streams only, nothing else flags the outage);
#      PZ_CUT_AFTER_S=seconds between the start of the 4 streams (4.5 s long) and the cut (default 1.5; 4.1 = just
#      before their end, the worst case: nothing has detected the outage when they finish);
#      PZ_GATEWAY_IMAGE=name runs the test with another, already built image (e.g. the previous release) instead of the deployed one;
#      PZ_EXTRA_ENV="NAME=value NAME2=value2" adds gateway variables (e.g. timeouts) to the temporary override.
# The real gateway container is recreated with a temporary compose override (observe mode, upstream = local stub
# addressed by IP, so no provider call and no cost). deploy/.env is never modified or printed. At the end the override
# is removed, PostgreSQL is running and the gateway is recreated with its normal configuration. Prints no secret.
set -u
cd "$(dirname "$0")/../.."
PHASE=${1:-open}
METHOD=${2:-stop}
case "$PHASE" in open) POLICY=fail-open;; closed) POLICY=fail-closed;; *) echo "usage: $0 open|closed [stop|pause]"; exit 2;; esac
case "$METHOD" in stop|pause) ;; *) echo "usage: $0 open|closed [stop|pause]"; exit 2;; esac
ENV_FILE=${PZ_ENV_FILE:-deploy/.env}
BASE="docker compose -f ${PZ_COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
NET=${PZ_NETWORK:-deploy_backend}
SPOOLVOL=${PZ_SPOOL_VOLUME:-deploy_ledger_spool}
GWC=${PZ_GATEWAY_CONTAINER:-deploy-gateway-1}
PGC=${PZ_POSTGRES_CONTAINER:-deploy-postgres-1}
OVERRIDE=$(mktemp /tmp/stream-outage-override.XXXXXX.yml)
DC="$BASE -f $OVERRIDE"
TOOLS="$(pwd)/tools/pilot-zero"
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
TOKEN=$(envval GARDAGENT_ADMIN_TOKEN)
AGENT_ID=""
node_run() { docker run --rm --network "$NET" -e T="$TOKEN" -e AID="$AGENT_ID" node:22-alpine node -e "$1"; }
health() { node_run 'fetch("http://gateway:8080/health").then(async r=>console.log(r.status,await r.text()))'; }
spoollines() { docker run --rm -v "$SPOOLVOL":/s alpine sh -c 'cat /s/ledger.jsonl 2>/dev/null | wc -l'; }
now() { date +%s%3N; }
# After an unpause/start PostgreSQL can report "unhealthy" for a few seconds, and compose refuses to start the
# gateway (depends_on: service_healthy) in the meantime: wait for the health check before going on.
wait_pg() {
  for i in $(seq 1 40); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$PGC" 2>/dev/null)" = "healthy" ] && return 0
    sleep 1
  done
  echo "WARNING: postgres not healthy after 40 s"
}
restore_db() { $BASE unpause postgres >/dev/null 2>&1 || true; $BASE start postgres >/dev/null 2>&1 || true; wait_pg; }
cleanup() {
  restore_db
  docker rm -f ga-so-stub ga-so-client >/dev/null 2>&1 || true
  rm -f "$OVERRIDE"
  $BASE up -d gateway >/dev/null 2>&1 || true   # normal configuration again (no override)
  # The test agent never stays active, whatever happened above (idempotent; retried while the gateway comes back).
  if [ -n "$AGENT_ID" ]; then
    for _i in $(seq 1 20); do
      node_run 'fetch("http://gateway:8080/admin/agents/"+process.env.AID,{method:"PATCH",headers:{authorization:"Bearer "+process.env.T,"content-type":"application/json"},body:JSON.stringify({active:false})}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))' >/dev/null 2>&1 && break
      sleep 3
    done
  fi
}
trap cleanup EXIT
docker rm -f ga-so-stub ga-so-client >/dev/null 2>&1
docker run -d --name ga-so-stub --network "$NET" -v "$TOOLS":/t:ro node:22-alpine node /t/stream-outage-stub.mjs >/dev/null
STUBIP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" ga-so-stub)
{
  echo "services:"
  echo "  gateway:"
  [ -n "${PZ_GATEWAY_IMAGE:-}" ] && echo "    image: $PZ_GATEWAY_IMAGE"
  echo "    environment:"
  echo "      GARDAGENT_MODE: observe"
  echo "      GARDAGENT_DB_OUTAGE: $POLICY"
  echo "      UPSTREAM_BASE_URL: http://$STUBIP:9000"
  echo "      ANTHROPIC_UPSTREAM_BASE_URL: http://$STUBIP:9000"
  echo "      GARDAGENT_MCP_SERVERS: \"\""
  for kv in ${PZ_EXTRA_ENV:-}; do echo "      ${kv%%=*}: \"${kv#*=}\""; done
} > "$OVERRIDE"
echo "== phase: $PHASE ($POLICY, observe), database cut: $METHOD, extra env: ${PZ_EXTRA_ENV:-none}"
wait_pg
$DC up -d --force-recreate gateway >/dev/null 2>&1
for i in $(seq 1 30); do sleep 2; out=$(health 2>/dev/null); case "$out" in 200*) break;; esac; done
echo "baseline /health: $out"
KEY=$(node_run 'fetch("http://gateway:8080/admin/agents",{method:"POST",headers:{authorization:"Bearer "+process.env.T,"content-type":"application/json"},body:JSON.stringify({name:"stream-outage-"+Date.now(),allowedModels:["m"],dailyBudgetUsd:5})}).then(r=>r.json()).then(j=>process.stdout.write(j.agent.id+" "+j.key))')
AGENT_ID=${KEY%% *}; KEY=${KEY#* }
docker run -d --name ga-so-client --network "$NET" -v "$TOOLS":/t:ro -e K="$KEY" -e PROBES="${PZ_PROBES:-22}" -e STUB="$STUBIP:9000" node:22-alpine node /t/stream-outage-client.mjs >/dev/null
for i in $(seq 1 50); do docker logs ga-so-client 2>&1 | grep -q START && break; sleep 0.1; done
sleep "${PZ_CUT_AFTER_S:-1.5}"
CUT=$(now); echo "== cut postgres ($METHOD) at +0 ms (epoch $CUT)"
if [ "$METHOD" = "pause" ]; then $BASE pause postgres >/dev/null 2>&1; else $BASE stop postgres >/dev/null 2>&1; fi
echo "   cut command returned after $(( $(now) - CUT )) ms"
while [ "$(docker inspect -f '{{.State.Running}}' ga-so-client)" = "true" ]; do sleep 1; done
docker logs ga-so-client 2>&1 | grep -v '^START'
docker rm -f ga-so-client >/dev/null
echo "-- traffic finished, postgres still down"
echo "spool lines: $(spoollines)"
echo "gateway container: $(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' "$GWC")"
echo "-- gateway warnings/errors (first 8)"
docker logs "$GWC" 2>&1 | grep -E 'Slow spool|"level":(40|50|60)|Error|error:' | cut -c1-260 | head -8
echo "== restore postgres"; restore_db
for i in $(seq 1 40); do sleep 2; out=$(health 2>/dev/null); case "$out" in *'"spoolBacklog":0'*'"database":"up"'*|*'"database":"up"'*'"spoolBacklog":0'*) break;; esac; done
echo "$out"
echo "spool lines after replay: $(spoollines)"
node_run 'fetch("http://gateway:8080/admin/ledger/verify",{headers:{authorization:"Bearer "+process.env.T}}).then(r=>r.json()).then(v=>console.log("verify",JSON.stringify(v)))'
echo "== ledger rows of the test agent: verdict / rows / distinct request hashes"
$BASE exec -T postgres psql -U gardagent -d gardagent -At -c "select verdict, count(*), count(distinct request_hash) from ledger where agent_id='$AGENT_ID' group by 1;"
node_run 'fetch("http://gateway:8080/admin/agents/"+process.env.AID,{method:"PATCH",headers:{authorization:"Bearer "+process.env.T,"content-type":"application/json"},body:JSON.stringify({active:false})}).then(r=>console.log("test agent deactivated:",r.status))'
