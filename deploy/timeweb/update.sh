#!/usr/bin/env bash
# Updates a running installation: verified pg_dump first, then new code/image, migrations and
# health checks. Never deletes data. Rollback notes: docs/34-launch-timeweb.md.
#
#   bash deploy/timeweb/update.sh                   # git pull --ff-only, rebuild, migrate, restart
#   bash deploy/timeweb/update.sh --no-pull         # code already replaced (e.g. rsync from laptop)
#   bash deploy/timeweb/update.sh --image-tar farm.tar --image ai-farm:TAG
set -euo pipefail

# shellcheck source=deploy/timeweb/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

pull=1
deploy_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull)
      pull=0
      shift
      ;;
    --image | --image-tar)
      deploy_args+=("$1" "$2")
      pull=0
      shift 2
      ;;
    -h | --help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done

require_env_file
cd "$APP_DIR"
before_image="$(env_get FARM_IMAGE)"
before_rev="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

if [ "$pull" = 1 ]; then
  [ -d .git ] || die 'Not a git checkout. Replace the code yourself and use --no-pull.'
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die 'Local changes in tracked files; commit or revert them first.'
  log 'Fetching code'
  git pull --ff-only
fi

log 'Stopping worker (finishes the current cycle; may take a few minutes)'
compose stop worker

log 'Pre-update backup'
dump="$(backup_now preupdate)"
log "Backup: $dump"
snapshot="$APP_DIR/backups/$(basename "$dump" .dump).counts.txt"
bash "$(dirname "${BASH_SOURCE[0]}")/db-snapshot.sh" >"$snapshot"
log "Row counts: $snapshot"

if ! bash "$(dirname "${BASH_SOURCE[0]}")/deploy.sh" "${deploy_args[@]}"; then
  cat >&2 <<EOF

UPDATE FAILED. Data is untouched apart from forward-only migrations.
  Previous image: $before_image   previous commit: $before_rev
  Backup before update: $dump
Rollback (only if no new migration was applied, see docs/34-launch-timeweb.md):
  sed -i 's|^FARM_IMAGE=.*|FARM_IMAGE=$before_image|' .env
  bash deploy/timeweb/deploy.sh --image $before_image
If a migration was applied, restore the backup into a NEW volume as described in the runbook.
EOF
  exit 1
fi

after="$(mktemp)"
bash "$(dirname "${BASH_SOURCE[0]}")/db-snapshot.sh" >"$after"
log 'Tables whose row count DECREASED during the update (review each; growth is normal):'
awk -F'|' 'NR == FNR { before[$1] = $2; next } ($1 in before) && $2 < before[$1] {
  printf "  %s: %s -> %s\n", $1, before[$1], $2; shrunk = 1 } END { if (!shrunk) print "  none" }' \
  "$snapshot" "$after"
rm -f "$after"
log "Update complete: $before_image -> $(env_get FARM_IMAGE)"
