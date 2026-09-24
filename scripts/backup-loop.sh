#!/bin/sh
set -eu
umask 077
mkdir -p /backups
while true; do
  target="/backups/farm-$(date -u +%Y%m%dT%H%M%SZ)-auto-$$.dump"
  if pg_dump -h db -U farm -d farm -Fc > "$target.tmp"; then
    mv "$target.tmp" "$target"
    find /backups -name 'farm-*.dump' -mtime +7 -delete
    echo "Backup completed"
  else
    rm -f "$target.tmp"
    echo "BACKUP_FAILED" >&2
    exit 1
  fi
  sleep 86400 &
  wait $!
done
