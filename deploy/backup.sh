#!/bin/sh
set -eu

# Determine the directory containing this script and the repository root.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="$repo_root/deploy/docker-compose.prod.yml"
backup_dir="$script_dir/backups"

timestamp=$(date +%Y%m%d-%H%M%S)
tmp_file="$backup_dir/gardagent-${timestamp}.sql"
dump_file="${tmp_file}.gz"

mkdir -p "$backup_dir"

if ! docker compose -f "$compose_file" exec -T postgres pg_dump -U gardagent -d gardagent > "$tmp_file"; then
  echo "Error: database dump failed." >&2
  rm -f "$tmp_file"
  exit 1
fi

if ! gzip "$tmp_file"; then
  echo "Error: compressing the backup failed." >&2
  rm -f "$tmp_file" "$dump_file"
  exit 1
fi

echo "Backup saved to $dump_file"

# Keep only the 14 most recent backup files.
cd "$backup_dir"
ls -t gardagent-*.sql.gz 2>/dev/null | awk 'NR>14' | while IFS= read -r old_file; do
  rm -f "$old_file"
done
