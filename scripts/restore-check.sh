#!/bin/sh
set -eu
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo 'Usage: sh scripts/restore-check.sh backups/farm-TIMESTAMP.dump' >&2
  exit 1
fi
restore_db="farm_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"
docker compose exec -T db createdb -U farm "$restore_db"
trap 'docker compose exec -T db dropdb -U farm "$restore_db"' EXIT
docker compose exec -T db pg_restore -U farm -d "$restore_db" --no-owner --exit-on-error < "$1"
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U farm -d "$restore_db" -c 'SELECT count(*) AS products FROM products' -c 'SELECT count(*) AS orders FROM orders' -c 'SELECT count(*) AS jobs FROM jobs'
echo 'Restore check passed in an isolated temporary database.'
