#!/bin/sh
set -eu
umask 077
mkdir -p /backups
health_dir="${HEALTH_DIRECTORY:-/health}"
mkdir -p "$health_dir"
stamp() {
  printf '{"status":"%s","completedAt":"%s"}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$health_dir/backup.json.tmp"
  chmod 644 "$health_dir/backup.json.tmp"
  mv "$health_dir/backup.json.tmp" "$health_dir/backup.json"
}
while true; do
  target="/backups/farm-$(date -u +%Y%m%dT%H%M%SZ)-auto-$$.dump"
  if pg_dump -h db -U farm -d farm -Fc > "$target.tmp"; then
    mv "$target.tmp" "$target"
    # Private reports and browser snapshots may be unreadable to this container.
    # Only rotate this service's dumps; a cleanup failure must not restart pg_dump.
    # BusyBox -delete forces depth-first traversal, even with -maxdepth; use rm instead.
    if ! find /backups -maxdepth 1 -type f -name 'farm-*-auto-*.dump' -mtime +7 -exec rm -f {} +; then
      echo "BACKUP_CLEANUP_FAILED" >&2
    fi
    stamp ok
    echo "Backup completed"
  else
    rm -f "$target.tmp"
    stamp failed
    echo "BACKUP_FAILED" >&2
    exit 1
  fi
  sleep 86400 &
  wait $!
done
