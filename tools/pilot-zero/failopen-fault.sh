#!/bin/sh
# v0.2 item 1 fault test: observe mode + fail-open (or fail-closed) while PostgreSQL is stopped mid-traffic.
# Usage (repository root, production-like install): sh tools/pilot-zero/failopen-fault.sh open|closed
# The real gateway container is recreated with a temporary compose override (observe mode, chosen outage policy,
# upstream = a local stub addressed by IP, so no provider call and no cost). deploy/.env is never modified or printed.
# At the end the override is removed and the gateway is recreated with its normal configuration.
# Needs: docker compose, the deploy stack running. Prints no secret.
set -u
cd "$(dirname "$0")/../.."
PHASE=${1:-open}
case "$PHASE" in open) POLICY=fail-open;; closed) POLICY=fail-closed;; *) echo "usage: $0 open|closed"; exit 2;; esac
ENV_FILE=${PZ_ENV_FILE:-deploy/.env}
BASE="docker compose -f ${PZ_COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
NET=${PZ_NETWORK:-deploy_backend}
SPOOLVOL=${PZ_SPOOL_VOLUME:-deploy_ledger_spool}
OVERRIDE=$(mktemp /tmp/failopen-override.XXXXXX.yml)
DC="$BASE -f $OVERRIDE"
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
TOKEN=$(envval GARDAGENT_ADMIN_TOKEN)
DOMAIN=$(envval GARDAGENT_DOMAIN)
AGENT_ID=""
node_run() { docker run --rm --network "$NET" -e T="$TOKEN" -e K="${KEY:-}" -e AID="$AGENT_ID" -e N="${N:-0}" node:22-alpine node -e "$1"; }
health() { node_run 'fetch("http://gateway:8080/health").then(async r=>console.log(r.status,await r.text()))'; }
spoollines() { docker run --rm -v "$SPOOLVOL":/s alpine sh -c 'cat /s/ledger.jsonl 2>/dev/null | wc -l'; }
cleanup() {
  $BASE start postgres >/dev/null 2>&1 || true
  docker rm -f ga-fo-stub ga-fo-client >/dev/null 2>&1 || true
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
docker rm -f ga-fo-stub >/dev/null 2>&1
docker run -d --name ga-fo-stub --network "$NET" node:22-alpine node -e '
require("http").createServer((q,r)=>{let b="";q.on("data",d=>b+=d);q.on("end",()=>{let s=false;try{s=JSON.parse(b).stream===true}catch{}
const u={prompt_tokens:10,completion_tokens:2,total_tokens:12};
if(!s){r.writeHead(200,{"content-type":"application/json"});return r.end(JSON.stringify({id:"x",object:"chat.completion",choices:[{index:0,message:{role:"assistant",content:"hello"},finish_reason:"stop"}],usage:u}))}
r.writeHead(200,{"content-type":"text/event-stream"});
r.write("data: "+JSON.stringify({id:"x",object:"chat.completion.chunk",choices:[{index:0,delta:{content:"hel"}}]})+"\n\n");
setTimeout(()=>{r.write("data: "+JSON.stringify({id:"x",object:"chat.completion.chunk",choices:[{index:0,delta:{content:"lo"},finish_reason:"stop"}],usage:u})+"\n\n");r.end("data: [DONE]\n\n")},200)})}).listen(9000)' >/dev/null
STUBIP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" ga-fo-stub)
cat > "$OVERRIDE" <<EOF
services:
  gateway:
    environment:
      GARDAGENT_MODE: observe
      GARDAGENT_DB_OUTAGE: $POLICY
      UPSTREAM_BASE_URL: http://$STUBIP:9000
      GARDAGENT_MCP_SERVERS: ""
EOF
echo "== phase: $PHASE (GARDAGENT_MODE=observe GARDAGENT_DB_OUTAGE=$POLICY), recreating the gateway"
$DC up -d --force-recreate gateway >/dev/null 2>&1
for i in $(seq 1 30); do sleep 2; out=$(health 2>/dev/null); case "$out" in 200*) break;; esac; done
echo "baseline /health: $out"
KEY=$(node_run 'fetch("http://gateway:8080/admin/agents",{method:"POST",headers:{authorization:"Bearer "+process.env.T,"content-type":"application/json"},body:JSON.stringify({name:"failopen-test-"+Date.now(),allowedModels:["m"],dailyBudgetUsd:5})}).then(r=>r.json()).then(j=>process.stdout.write(j.agent.id+" "+j.key))')
AGENT_ID=${KEY%% *}; KEY=${KEY#* }
# Traffic: 40 requests, one every 700 ms, every 2nd one streaming, unique content each. Started in the background.
docker run -d --name ga-fo-client --network "$NET" -e K="$KEY" node:22-alpine node -e '
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;
(async()=>{for(let i=0;i<40;i++){const t0=Date.now();try{const stream=i%2===1;
const r=await fetch("http://gateway:8080/v1/chat/completions",{method:"POST",headers:{authorization:"Bearer "+process.env.K,"content-type":"application/json"},body:JSON.stringify({model:"m",stream,max_tokens:8,messages:[{role:"user",content:"req-"+i+"-"+Date.now()}]})});
const t=await r.text();const complete=stream?t.includes("[DONE]"):t.includes("hello");
console.log(new Date().toISOString().slice(11,19),"req",i,stream?"stream":"plain","status",r.status,"complete",complete,"ms",Date.now()-t0);
if(r.status===200&&complete)ok++;else bad++}catch(e){bad++;console.log("req",i,"error",String(e.message))}
await sleep(700)}
console.log("SUMMARY ok="+ok+" refused_or_failed="+bad)})()' >/dev/null
sleep 8
echo "== stop postgres at $(date +%T)"; $BASE stop postgres >/dev/null 2>&1
sleep 5
echo "-- during the outage"
echo "gateway /health: $(health)"
echo "spool lines: $(spoollines)"
if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "localhost" ]; then
  echo "public edge request (https://$DOMAIN):"
  curl -sS -m 10 -o /dev/null -w "  POST /v1/chat/completions -> %{http_code}\n" --resolve "$DOMAIN:443:127.0.0.1" \
    -H "authorization: Bearer $KEY" -H "content-type: application/json" \
    -d '{"model":"m","max_tokens":8,"messages":[{"role":"user","content":"edge-probe"}]}' "https://$DOMAIN/v1/chat/completions" 2>&1 | tail -1
  curl -sS -m 10 -w "\n  GET /health -> %{http_code}\n" --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health" 2>&1 | tail -2
fi
while [ "$(docker inspect -f '{{.State.Running}}' ga-fo-client)" = "true" ]; do sleep 1; done
docker logs ga-fo-client
docker rm -f ga-fo-client >/dev/null
echo "-- traffic finished, postgres still stopped"
echo "gateway /health: $(health)"
echo "spool lines: $(spoollines)"
echo "-- gateway gateway warnings/errors and requests slower than 1 s (first 8)"
docker logs deploy-gateway-1 2>&1 | grep -E 'Slow spool|"level":(40|50)|responseTime":[0-9]{4,}' | cut -c1-200 | head -8
echo "== start postgres at $(date +%T)"; $BASE start postgres >/dev/null 2>&1
for i in $(seq 1 30); do sleep 2; out=$(health); echo "$out"; case "$out" in *'"spoolBacklog":0'*) break;; esac; done
echo "spool lines after replay: $(spoollines)"
node_run 'fetch("http://gateway:8080/admin/ledger/verify",{headers:{authorization:"Bearer "+process.env.T}}).then(r=>r.json()).then(v=>console.log("verify",JSON.stringify(v)))'
echo "== ledger rows of the test agent (chat.completions): total / distinct request hashes"
$BASE exec -T postgres psql -U gardagent -d gardagent -At -c "select verdict, count(*), count(distinct request_hash) from ledger where agent_id='$AGENT_ID' and action='chat.completions' group by 1;"
# deactivate the test agent
node_run 'fetch("http://gateway:8080/admin/agents/"+process.env.AID,{method:"PATCH",headers:{authorization:"Bearer "+process.env.T,"content-type":"application/json"},body:JSON.stringify({active:false})}).then(r=>console.log("test agent deactivated:",r.status))'
