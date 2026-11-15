#!/bin/sh
# Run from any directory. Never enable tracing: credentials stay private.
set +x
set -eu
umask 077

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
for tool in docker curl python3 openssl mktemp; do
    command -v "$tool" >/dev/null 2>&1 || { printf 'Missing prerequisite: %s\n' "$tool" >&2; exit 1; }
done
work=$(mktemp -d)
project="gardagent-quickstart-$(openssl rand -hex 6)"
export GARDAGENT_ADMIN_TOKEN
GARDAGENT_ADMIN_TOKEN=$(openssl rand -hex 32)
# Explicit env file prevents Compose from discovering a repository .env.
export COMPOSE_DISABLE_ENV_FILE=1 COMPOSE_ENV_FILES=/dev/null
compose() {
    docker compose --env-file /dev/null -p "$project" -f "$root/docker-compose.local.yml" --profile local "$@"
}
clock() { python3 -c 'import time; print(time.monotonic_ns())'; }
started=$(clock)
phase=setup
phase_start=$started
active=0
cleanup() {
    result=$?
    trap - 0 HUP INT TERM
    set +e
    if [ "$active" -eq 1 ]; then
        end=$(clock)
        python3 -c 'import sys; print("%s\t%.3f\tFAILED" % (sys.argv[1], (int(sys.argv[3])-int(sys.argv[2]))/1e9))' "$phase" "$phase_start" "$end" >> "$work/timings"
    fi
    printf '\n%-18s %12s  %s\n' Phase Seconds Result
    while IFS="$(printf '\t')" read -r label seconds status; do
        printf '%-18s %12s  %s\n' "$label" "$seconds" "$status"
    done < "$work/timings"
    end=$(clock)
    python3 -c 'import sys; print("Total before cleanup: %.3f seconds" % ((int(sys.argv[2])-int(sys.argv[1]))/1e9))' "$started" "$end"
    if ! compose down -v --remove-orphans > "$work/cleanup.log" 2>&1; then
        printf 'Cleanup failed; retry with project %s and docker compose down -v.\n' "$project" >&2
        result=1
    fi
    rm -rf "$work"
    exit "$result"
}
: > "$work/timings"
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
begin() { phase=$1; phase_start=$(clock); active=1; printf 'Running: %s\n' "$phase"; }
finish() {
    end=$(clock)
    python3 -c 'import sys; print("%s\t%.3f\tPASS" % (sys.argv[1], (int(sys.argv[3])-int(sys.argv[2]))/1e9))' "$phase" "$phase_start" "$end" >> "$work/timings"
    active=0
}
# Do not echo tool output, HTTP bodies, or headers, including on failure.
# Header files also keep credentials out of curl command-line arguments.
printf 'Authorization: Bearer %s\n' "$GARDAGENT_ADMIN_TOKEN" > "$work/admin-header"
request() {
    curl --fail --silent --connect-timeout 5 --max-time 330 "$@" 2>/dev/null
}
begin build
compose build > "$work/build.log" 2>&1
finish
begin model-pull
compose up -d model-init > "$work/model.log" 2>&1
container=$(compose ps -a -q model-init 2>/dev/null)
[ -n "$container" ]
code=$(docker wait "$container" 2>/dev/null)
[ "$code" = 0 ]
finish
begin health
compose up -d > "$work/start.log" 2>&1
attempt=0
until request --max-time 5 http://127.0.0.1:8080/health > "$work/health.json" &&
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("status")=="ok" and d.get("database")=="up" else 1)' "$work/health.json" 2>/dev/null
do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 120 ] || exit 1
    sleep 1
done
finish
begin agent-creation
request http://127.0.0.1:8080/admin/agents -H "@$work/admin-header" \
    -H 'Content-Type: application/json' \
    -d '{"name":"local-demo","allowedModels":["qwen2.5:0.5b","demo-anthropic"],"allowedTools":["demo/*"],"dailyBudgetUsd":1}' > "$work/agent.json"
python3 - "$work" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
d = json.loads((p / 'agent.json').read_text())
key = d['key']
assert isinstance(key, str) and key.startswith('ga_') and '\n' not in key and '\r' not in key
(p / 'agent-header').write_text('Authorization: Bearer ' + key + '\n')
PY
finish
begin first-call
request http://127.0.0.1:8080/v1/chat/completions -H "@$work/agent-header" \
    -H 'Content-Type: application/json' \
    -d '{"model":"qwen2.5:0.5b","max_tokens":64,"messages":[{"role":"user","content":"Say hello in one sentence."}]}' > "$work/call.json"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["choices"][0]["message"]["content"]' "$work/call.json" 2>/dev/null
finish
begin ledger-read
request 'http://127.0.0.1:8080/admin/ledger?order=desc&limit=5' -H "@$work/admin-header" > "$work/ledger.json"
python3 - "$work" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
a = json.loads((p / 'agent.json').read_text())
d = json.loads((p / 'ledger.json').read_text())
assert any(r['agentId'] == a['agent']['id'] and r['action'] == 'chat.completions'
           and r['model'] == 'qwen2.5:0.5b' and r['verdict'] == 'allowed'
           and r['upstreamStatus'] == 200 for r in d['entries'])
PY
finish
begin verify
request http://127.0.0.1:8080/admin/ledger/verify -H "@$work/admin-header" > "$work/verify.json"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["valid"] is True and d["checked"] > 0' "$work/verify.json" 2>/dev/null
finish
