#!/bin/sh
# Runs one end-to-end validation round (production-like install: PZ_ENV_FILE=deploy/.env PZ_COMPOSE_FILE=deploy/docker-compose.prod.yml PZ_NETWORK=deploy_backend PZ_HARNESS_NETWORK=deploy_edge PZ_GATEWAY_IMAGE=deploy-gateway GW_CONTAINER=deploy-gateway-1 PG_CONTAINER=deploy-postgres-1): the Node harness (criteria a-g, i) in a container on the compose network,
# then the backup/restore check (h). Needs ./.env and the harness agent key in $PZ_KEY_FILE
# (outside git, mode 600). Prints no secret. Starts the MCP reference server if it is not running.
set -eu
cd "$(dirname "$0")/../.."
NET=${PZ_NETWORK:-gardagent_default}
HNET=${PZ_HARNESS_NETWORK:-$NET}   # network of the harness and of the MCP server (needs the gateway and outbound access)
ENV_FILE=${PZ_ENV_FILE:-./.env}
PZ_KEY_FILE=${PZ_KEY_FILE:-$HOME/.ga-oc/secrets/pilot-zero.key}
OUT=${PZ_OUT:-$HOME/.ga-oc/pilot-zero-out}
mkdir -p "$OUT"

if ! docker ps --format '{{.Names}}' | grep -qx ga-mcp-everything; then
  docker rm -f ga-mcp-everything >/dev/null 2>&1 || true
  docker run -d --name ga-mcp-everything --network "$HNET" -e PORT=3001 node:22-alpine \
    sh -c 'npx -y @modelcontextprotocol/server-everything@latest streamableHttp' >/dev/null
  sleep 25
fi

PZ_KEY=$(cat "$PZ_KEY_FILE") docker run --rm --network "$HNET" --env-file "$ENV_FILE" -e GW_CONTAINER -e PG_CONTAINER -e PZ_KEY \
  -e PZ_PAIRS -e PZ_F_SAMPLES -e RESULTS_FILE=/out/results.json -v "$OUT:/out" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD/tools/pilot-zero:/app:ro" -w /app node:22-alpine node run.mjs || echo "harness exit code $?"

sh tools/pilot-zero/backup-restore.sh
sh tools/pilot-zero/latency-stub.sh
