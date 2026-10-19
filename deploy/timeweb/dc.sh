#!/usr/bin/env bash
# docker compose with the production file set of this server. Examples:
#   bash deploy/timeweb/dc.sh ps
#   bash deploy/timeweb/dc.sh logs --tail=100 worker
#   bash deploy/timeweb/dc.sh up -d --no-build --force-recreate web worker   # after editing .env
#   bash deploy/timeweb/dc.sh exec worker node --import tsx scripts/trading-check.ts demo bybit
set -euo pipefail
# shellcheck source=deploy/timeweb/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
compose "$@"
