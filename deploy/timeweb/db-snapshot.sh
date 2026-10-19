#!/usr/bin/env bash
# Prints "schema.table|rows[|md5]" for every table of the farm database, sorted by name.
# Run the same command on the old and the new server and compare the files with diff.
#
#   bash deploy/timeweb/db-snapshot.sh                > counts.txt
#   bash deploy/timeweb/db-snapshot.sh --fingerprint  > fingerprints.txt   # + md5 of all rows
#
# On the old FirstVDS layout (no Caddy in its Compose stack) set the stack explicitly:
#   OLD_COMPOSE='docker compose -f compose.yaml -f compose.prebuilt.yaml -f compose.cloud.yaml' \
#     bash db-snapshot.sh
set -euo pipefail

# shellcheck source=deploy/timeweb/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

name="table_schema || '.' || table_name"
if [ "${1:-}" = --fingerprint ]; then
  expr="format('SELECT %L || ''|'' || count(*) || ''|'' || coalesce(md5(string_agg(t::text, '','' ORDER BY t::text)), ''-'') FROM %I.%I t', $name, table_schema, table_name)"
else
  expr="format('SELECT %L || ''|'' || count(*) FROM %I.%I', $name, table_schema, table_name)"
fi
sql="SELECT $expr FROM information_schema.tables
WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name \\gexec"

if [ -n "${OLD_COMPOSE:-}" ]; then
  # shellcheck disable=SC2086 # OLD_COMPOSE is a command line on purpose
  (cd "$APP_DIR" && $OLD_COMPOSE exec -T db psql -U farm -d farm -X -At -v ON_ERROR_STOP=1 <<<"$sql")
else
  compose exec -T db psql -U farm -d farm -X -At -v ON_ERROR_STOP=1 <<<"$sql"
fi
