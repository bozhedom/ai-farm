#!/usr/bin/env bash
# Restores a pg_dump (-Fc) from the old server into the EMPTY database of this new server.
# Refuses to touch a database that already has tables: it never overwrites working data.
# Run BEFORE the first deploy.sh (or after `docker volume rm` of a fresh, never-used volume).
#
#   bash deploy/timeweb/restore-from-dump.sh backups/farm-20261021T080000Z-manual-123.dump
set -euo pipefail

# shellcheck source=deploy/timeweb/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dump="${1:-}"
[ -n "$dump" ] && [ -s "$dump" ] || die 'Usage: restore-from-dump.sh path/to/farm-....dump'
require_env_file
cd "$APP_DIR"

for svc in web worker observer backup; do
  if [ "$(service_state "$svc")" != missing ]; then
    die "Service $svc exists. Restore only into a fresh install (stop and remove app services first)."
  fi
done

log 'Starting PostgreSQL only'
compose up -d db
for _ in $(seq 1 60); do
  [ "$(service_state db)" = healthy ] && break
  sleep 2
done
[ "$(service_state db)" = healthy ] || die 'PostgreSQL did not become healthy'

tables="$(compose exec -T db psql -U farm -d farm -X -At -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
[ "$tables" = 0 ] || die "Database is not empty ($tables tables). Nothing was changed."

log 'Checking the archive'
compose exec -T db pg_restore --list <"$dump" >/dev/null || die 'Archive is unreadable'

log 'Restoring in one transaction'
compose exec -T db pg_restore -U farm -d farm --no-owner --no-privileges --exit-on-error \
  --single-transaction <"$dump"

out="$APP_DIR/backups/restored-$(basename "$dump" .dump).counts.txt"
bash "$(dirname "${BASH_SOURCE[0]}")/db-snapshot.sh" >"$out"
log "Restored. Row counts: $out"
cat <<EOF

Compare with the counts taken on the old server, e.g.:
  diff old-counts.txt $out
Only then run: bash deploy/timeweb/deploy.sh   (it applies any newer migrations)
EOF
