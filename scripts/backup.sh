#!/bin/sh
set -eu
umask 077
mkdir -p backups
target="backups/farm-$(date -u +%Y%m%dT%H%M%SZ)-manual-$$.dump"
docker compose exec -T db pg_dump -U farm -d farm -Fc > "$target.tmp"
mv "$target.tmp" "$target"
echo "Backup created: $target"
