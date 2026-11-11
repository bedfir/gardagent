#!/bin/sh
# Round 4b: deterministic fault test of the ledger spool. A temporary gateway (scratch database) talks to a slow
# streaming stub; PostgreSQL is paused while the stream is in flight, so the ledger write fails exactly after the
# upstream response. Expected: spoolBacklog > 0, then replay after unpause, chain valid, entry present exactly once.
# Run from the repository root on the production-like install (deploy/). Prints no secret.
set -u
cd "$(dirname "$0")/../.."
ENV_FILE=${PZ_ENV_FILE:-deploy/.env}
DC="docker compose -f ${PZ_COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
NET=${PZ_NETWORK:-deploy_backend}
IMAGE=${PZ_GATEWAY_IMAGE:-deploy-gateway}
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
TOKEN=$(envval GARDAGENT_ADMIN_TOKEN); PGPW=$(envval POSTGRES_PASSWORD)
HOLD=${HOLD_MS:-12000}
cleanup() {
  $DC unpause postgres >/dev/null 2>&1 || true
  docker rm -f ga-fault-stub ga-fault-gw >/dev/null 2>&1 || true
  docker volume rm ga-fault-spool >/dev/null 2>&1 || true
  $DC exec -T postgres psql -U gardagent -d postgres -c "DROP DATABASE IF EXISTS gardagent_fault;" >/dev/null 2>&1 || true
}
trap cleanup EXIT; cleanup
docker volume create ga-fault-spool >/dev/null
docker run -d --name ga-fault-stub --network "$NET" -e HOLD="$HOLD" node:22-alpine node -e '
require("http").createServer((q,r)=>{q.resume();q.on("end",()=>{r.writeHead(200,{"content-type":"text/event-stream"});
const c=(d,u)=>"data: "+JSON.stringify({id:"x",object:"chat.completion.chunk",choices:[{index:0,delta:d,finish_reason:null}],...(u?{usage:u}:{})})+"\n\n";
r.write(c({role:"assistant",content:"he"}));
setTimeout(()=>{r.write("data: "+JSON.stringify({id:"x",object:"chat.completion.chunk",choices:[{index:0,delta:{content:"llo"},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})+"\n\n");r.end("data: [DONE]\n\n")},Number(process.env.HOLD));})}).listen(9000)' >/dev/null
$DC exec -T postgres psql -U gardagent -d postgres -c "CREATE DATABASE gardagent_fault;" >/dev/null
docker run -d --name ga-fault-gw --network "$NET" --env-file "$ENV_FILE" -e DATABASE_URL="postgres://gardagent:${PGPW}@postgres:5432/gardagent_fault" \
  -e UPSTREAM_BASE_URL=http://ga-fault-stub:9000 -e PORT=8083 -e GARDAGENT_MCP_SERVERS= -v ga-fault-spool:/app/spool "$IMAGE" >/dev/null
sleep 7
x() { docker run --rm --network "$NET" -e T="$TOKEN" -e HOLD="$HOLD" -e PHASE="$1" node:22-alpine node -e "$2"; }
health() { docker run --rm --network "$NET" node:22-alpine node -e 'fetch("http://ga-fault-gw:8083/health").then(async r=>console.log(r.status,await r.text()))'; }
spoollines() { docker run --rm -v ga-fault-spool:/s alpine sh -c 'cat /s/ledger.jsonl 2>/dev/null | wc -l'; }
echo "== baseline"; health
KEY=$(docker run --rm --network "$NET" -e T="$TOKEN" node:22-alpine node -e '
fetch("http://ga-fault-gw:8083/admin/agents",{method:"POST",headers:{authorization:"Bearer "+process.env.T,"content-type":"application/json"},body:JSON.stringify({name:"fault",allowedModels:["m"],dailyBudgetUsd:1})}).then(r=>r.json()).then(j=>process.stdout.write(j.key))')
# the stream: started in the background, the database is paused 3 s later, the stub ends the stream after HOLD ms
docker run -d --name ga-fault-client --network "$NET" -e K="$KEY" node:22-alpine node -e '
const t0=Date.now();fetch("http://ga-fault-gw:8083/v1/chat/completions",{method:"POST",headers:{authorization:"Bearer "+process.env.K,"content-type":"application/json"},body:JSON.stringify({model:"m",stream:true,max_tokens:8,messages:[{role:"user",content:"hi"}]})}).then(async r=>{const t=await r.text();console.log("stream status",r.status,"ms",Date.now()-t0,"done",t.includes("[DONE]"),"has_text",t.includes("llo"))})' >/dev/null
sleep 3
echo "== pause postgres at $(date +%T)"; $DC pause postgres
while [ "$(docker inspect -f '{{.State.Running}}' ga-fault-client)" = "true" ]; do sleep 1; done
docker logs ga-fault-client; docker rm -f ga-fault-client >/dev/null
echo "== stream finished, database still paused"; health
echo "spool lines: $(spoollines)"
echo "== unpause at $(date +%T)"; $DC unpause postgres
for i in 1 2 3 4 5 6 7 8 9 10; do sleep 2; out=$(health); echo "$out"; case "$out" in *'"spoolBacklog":0'*) break;; esac; done
echo "spool lines after replay: $(spoollines)"
x v 'const A={authorization:"Bearer "+process.env.T};(async()=>{const v=await (await fetch("http://ga-fault-gw:8083/admin/ledger/verify",{headers:A})).json();console.log("verify",JSON.stringify(v))})()'
echo "== ledger rows (chat.completions, per request hash, per verdict)"
$DC exec -T postgres psql -U gardagent -d gardagent_fault -At -c "select action, verdict, count(*), count(distinct request_hash) from ledger group by 1,2 order by 1,2;"
