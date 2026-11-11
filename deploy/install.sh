#!/bin/sh
set -eu

# Determine the directory containing this script and the repository root.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="$repo_root/deploy/docker-compose.prod.yml"
example_file="$script_dir/.env.example"
env_file="$script_dir/.env"

if [ ! -f "$example_file" ]; then
  echo "Error: $example_file not found." >&2
  exit 1
fi

if [ -f "$env_file" ]; then
  echo "Error: $env_file already exists. Remove it first if you want to reinstall." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed or not in PATH." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Error: docker compose is not installed or not in PATH." >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "Error: openssl is not installed or not in PATH." >&2
  exit 1
fi

admin_token=$(openssl rand -hex 32)
postgres_password=$(openssl rand -hex 32)

sed -e "s/^GARDAGENT_ADMIN_TOKEN=.*$/GARDAGENT_ADMIN_TOKEN=${admin_token}/" \
    -e "s/^POSTGRES_PASSWORD=.*$/POSTGRES_PASSWORD=${postgres_password}/" \
    "$example_file" > "$env_file"

chmod 600 "$env_file"

echo "Created $env_file with generated secrets."
echo "Next steps:"
echo "  1. Edit $env_file: set UPSTREAM_API_KEY, GARDAGENT_DOMAIN and, on a LAN-only network, GARDAGENT_TLS=internal."
echo "  2. Run: docker compose -f $compose_file up -d --build"
echo "  3. Check health: docker compose -f $compose_file exec -T gateway wget -qO- http://127.0.0.1:8080/health"
