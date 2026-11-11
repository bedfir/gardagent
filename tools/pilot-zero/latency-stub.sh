#!/bin/sh
# Criterion (e), noise-free variant: gateway overhead measured against a local stub upstream (fixed 20 ms
# latency) so that provider jitter does not hide it. A temporary gateway on a scratch database is used; the
# live gateway and database are untouched. Run from the repository root; reads ./.env without printing it.
set -eu
cd "$(dirname "$0")/../.."
ENV_FILE=${PZ_ENV_FILE:-./.env}
DC="docker compose${PZ_COMPOSE_FILE:+ -f $PZ_COMPOSE_FILE}"
# The env file is a Docker env file (raw values, spaces allowed): never source it, read the two values needed.
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
GARDAGENT_ADMIN_TOKEN=$(envval GARDAGENT_ADMIN_TOKEN); POSTGRES_PASSWORD=$(envval POSTGRES_PASSWORD)
NET=${PZ_NETWORK:-gardagent_default}
IMAGE=${PZ_GATEWAY_IMAGE:-gardagent-gateway}
cleanup() {
  docker rm -f ga-pz-stub ga-pz-lat >/dev/null 2>&1 || true
  $DC exec -T postgres psql -U gardagent -d postgres -c "DROP DATABASE IF EXISTS gardagent_lat;" >/dev/null 2>&1 || true
}
trap cleanup EXIT; cleanup
docker run -d --name ga-pz-stub --network "$NET" node:22-alpine node -e '
require("http").createServer((q,r)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>setTimeout(()=>{r.setHeader("content-type","application/json");
r.end(JSON.stringify({id:"x",object:"chat.completion",choices:[{index:0,message:{role:"assistant",content:"OK"},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}))},20))}).listen(9000)' >/dev/null
$DC exec -T postgres psql -U gardagent -d postgres -c "CREATE DATABASE gardagent_lat;" >/dev/null
export DATABASE_URL="postgres://gardagent:${POSTGRES_PASSWORD}@postgres:5432/gardagent_lat"
UPSTREAM_BASE_URL=http://ga-pz-stub:9000 docker run -d --name ga-pz-lat --network "$NET" --env-file "$ENV_FILE" -e DATABASE_URL -e UPSTREAM_BASE_URL -e PORT=8082 -e GARDAGENT_MCP_SERVERS= "$IMAGE" >/dev/null
sleep 6
docker run --rm --network "$NET" -e T="$GARDAGENT_ADMIN_TOKEN" node:22-alpine node -e '
const A={authorization:"Bearer "+process.env.T,"content-type":"application/json"};
(async()=>{
const r=await fetch("http://ga-pz-lat:8082/admin/agents",{method:"POST",headers:A,body:JSON.stringify({name:"lat",allowedModels:["m"],dailyBudgetUsd:1})});
const key=(await r.json()).key;
const body=JSON.stringify({model:"m",max_tokens:8,messages:[{role:"user",content:"hi"}]});
const t=async(url,h)=>{const t0=performance.now();const x=await fetch(url,{method:"POST",headers:{"content-type":"application/json",...h},body});await x.text();return performance.now()-t0};
const d=[],g=[];
for(let i=0;i<300;i++){ if(i%2){d.push(await t("http://ga-pz-stub:9000/v1/chat/completions",{}));g.push(await t("http://ga-pz-lat:8082/v1/chat/completions",{authorization:"Bearer "+key}));}
 else {g.push(await t("http://ga-pz-lat:8082/v1/chat/completions",{authorization:"Bearer "+key}));d.push(await t("http://ga-pz-stub:9000/v1/chat/completions",{}));} }
const p=(a,q)=>[...a].sort((x,y)=>x-y)[Math.ceil(q/100*a.length)-1];
const o=p(g,95)-p(d,95);
console.log(`(e-stub) pairs=300 direct p50/p95=${p(d,50).toFixed(1)}/${p(d,95).toFixed(1)}ms gateway p50/p95=${p(g,50).toFixed(1)}/${p(g,95).toFixed(1)}ms overhead p95=${o.toFixed(1)}ms median=${(p(g,50)-p(d,50)).toFixed(1)}ms -> ${o<100?"PASS":"FAIL"}`);
})()'
