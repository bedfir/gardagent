#!/bin/sh
set -eu

# Determine the directory containing this script and the repository root.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="$repo_root/deploy/docker-compose.prod.yml"
env_file="$script_dir/.env"

auto_confirm=0
# --yes is accepted before or after the backup file name.
for arg in "$@"; do
  shift
  if [ "$arg" = "--yes" ]; then auto_confirm=1; else set -- "$@" "$arg"; fi
done

if [ $# -ne 1 ]; then
  echo "Usage: $0 [--yes] <backup-file>" >&2
  exit 1
fi

backup_file=$1

if [ ! -f "$backup_file" ]; then
  echo "Error: backup file not found: $backup_file" >&2
  exit 1
fi

if [ ! -f "$env_file" ]; then
  echo "Error: $env_file not found. Run deploy/install.sh first." >&2
  exit 1
fi

get_env() {
  sed -n "s/^$1=//p" "$env_file" | head -n 1
}

admin_token=$(get_env GARDAGENT_ADMIN_TOKEN)
if [ -z "$admin_token" ]; then
  echo "Error: GARDAGENT_ADMIN_TOKEN is not set in $env_file." >&2
  exit 1
fi

if [ "$auto_confirm" -eq 0 ]; then
  printf "This will DESTROY the current database and replace it with %s. Continue? [y/N] " "$backup_file"
  read -r reply
  case "$reply" in
    [Yy]*) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

echo "Stopping gateway..."
docker compose -f "$compose_file" stop gateway

echo "Recreating empty database..."
docker compose -f "$compose_file" exec -T postgres psql -U gardagent -d postgres -c "DROP DATABASE IF EXISTS gardagent;" >/dev/null
docker compose -f "$compose_file" exec -T postgres psql -U gardagent -d postgres -c "CREATE DATABASE gardagent;" >/dev/null

echo "Restoring backup..."
if gzip -t "$backup_file" >/dev/null 2>&1; then
  if ! zcat "$backup_file" | docker compose -f "$compose_file" exec -T postgres psql -U gardagent -d gardagent >/dev/null; then
    echo "Error: restore failed." >&2
    exit 1
  fi
else
  if ! docker compose -f "$compose_file" exec -T postgres psql -U gardagent -d gardagent < "$backup_file" >/dev/null; then
    echo "Error: restore failed." >&2
    exit 1
  fi
fi

echo "Restarting gateway..."
docker compose -f "$compose_file" up -d gateway

echo "Waiting for gateway to be healthy..."
attempts=0
max_attempts=30
while [ $attempts -lt $max_attempts ]; do
  if docker compose -f "$compose_file" exec -T gateway wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1; then
    break
  fi
  attempts=$((attempts + 1))
  sleep 2
done

if [ $attempts -eq $max_attempts ]; then
  echo "Error: gateway did not become healthy." >&2
  exit 1
fi

echo "Verifying ledger integrity..."
verify_output="$(docker compose -f "$compose_file" exec -T gateway wget -qO- --header="Authorization: Bearer $admin_token" http://127.0.0.1:8080/admin/ledger/verify 2>/dev/null || true)"
case "$verify_output" in
  *'"valid":true'*) ;;
  *)
    echo "Error: ledger verification failed (answer did not contain \"valid\":true)." >&2
    exit 1
    ;;
esac

echo "Restore complete."
