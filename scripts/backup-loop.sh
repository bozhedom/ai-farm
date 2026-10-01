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
    find /backups -name 'farm-*.dump' -mtime +7 -delete
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
