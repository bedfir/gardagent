#!/bin/sh
set -eu

# Rotates GARDAGENT_ADMIN_TOKEN in deploy/.env, restarts the gateway and checks /health.
# The new token is never printed.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/docker-compose.prod.yml"
env_file="$script_dir/.env"

if [ ! -f "$env_file" ]; then
  echo "Error: $env_file not found. Run deploy/install.sh first." >&2
  exit 1
fi
if ! grep -q '^GARDAGENT_ADMIN_TOKEN=' "$env_file"; then
  echo "Error: GARDAGENT_ADMIN_TOKEN not found in $env_file." >&2
  exit 1
fi
for cmd in openssl docker; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: $cmd is not installed or not in PATH." >&2
    exit 1
  fi
done

new_token=$(openssl rand -hex 32)
umask 077
tmp_file=$(mktemp "$script_dir/.env.XXXXXX")
trap 'rm -f "$tmp_file"' EXIT INT TERM

# Hex only: safe in a sed replacement. Rewrite into a 600 temp file, then replace in place.
sed "s/^GARDAGENT_ADMIN_TOKEN=.*$/GARDAGENT_ADMIN_TOKEN=${new_token}/" "$env_file" > "$tmp_file"
chmod 600 "$tmp_file"
cat "$tmp_file" > "$env_file"
chmod 600 "$env_file"
new_token=""

echo "Admin token rotated in $env_file. Restarting gateway..."
# --force-recreate: a plain restart would not re-read env_file.
docker compose -f "$compose_file" up -d --force-recreate --no-deps gateway

attempts=0
max_attempts=30
while [ "$attempts" -lt "$max_attempts" ]; do
  if docker compose -f "$compose_file" exec -T gateway wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "Gateway is healthy. Update every administrator tool or script that holds the old token."
    exit 0
  fi
  attempts=$((attempts + 1))
  sleep 2
done

echo "Error: gateway did not become healthy after rotation." >&2
exit 1
