#!/usr/bin/env bash
# Builds (or loads) the application image, applies migrations and starts the whole stack:
# PostgreSQL, SearXNG, web, worker, backup, observer and Caddy HTTPS.
# Run as the deploy user in /opt/ai-farm after bootstrap.sh. Safe to re-run.
#
#   bash deploy/timeweb/deploy.sh                       # build the image on this server
#   bash deploy/timeweb/deploy.sh --image-tar farm.tar --image ai-farm:TAG   # prebuilt image
#   NO_EDGE=1 bash deploy/timeweb/deploy.sh             # without Caddy (SSH tunnel to :3210 only)
set -euo pipefail

# shellcheck source=deploy/timeweb/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

image=''
image_tar=''
while [ $# -gt 0 ]; do
  case "$1" in
    --image)
      image="$2"
      shift 2
      ;;
    --image-tar)
      image_tar="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done

docker info >/dev/null 2>&1 || die 'Docker is not reachable. Log in again after bootstrap (docker group) or use sudo.'
require_env_file
ensure_data_dirs
cd "$APP_DIR"

if [ -n "$image_tar" ]; then
  [ -n "$image" ] || die '--image-tar requires --image TAG'
  log "Loading $image_tar"
  docker load -i "$image_tar"
  docker image inspect "$image" >/dev/null || die "Image $image not found in $image_tar"
elif [ -n "$image" ]; then
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
else
  rev="$(git rev-parse --short HEAD 2>/dev/null || echo src)"
  image="ai-farm:$rev-$(date -u +%Y%m%d%H%M)"
  log "Building $image (5-15 minutes on 2 vCPU)"
  docker build -t "$image" .
fi

previous="$(env_get FARM_IMAGE)"
if [ "$previous" != "$image" ]; then
  [ -n "$previous" ] && [ "$previous" != ai-farm:pending ] && env_set FARM_IMAGE_PREVIOUS "$previous"
  env_set FARM_IMAGE "$image"
fi
log "FARM_IMAGE=$image (previous: ${previous:-none})"

log 'Starting PostgreSQL and SearXNG'
compose up -d db search
for _ in $(seq 1 60); do
  [ "$(service_state db)" = healthy ] && break
  sleep 2
done
[ "$(service_state db)" = healthy ] || die 'PostgreSQL did not become healthy'

log 'Applying migrations'
compose run --rm --no-deps -T web node --import tsx scripts/migrate.ts

log 'Starting all services'
compose up -d --no-build

log 'Waiting for health checks (up to 10 minutes)'
if ! wait_healthy 600; then
  compose ps
  die 'Some services are not healthy. Inspect: docker compose ... logs --tail=100 <service>'
fi
compose ps

code="$(wait_http http://127.0.0.1:3210/api/health 60)" || die "Local /api/health returned $code"
log "Local health: $code"
if code="$(wait_http http://127.0.0.1:3210/api/readiness 120)"; then
  log "Local readiness: $code"
else
  warn "Readiness returned $code: backup/observer status may still be warming up. Re-check in 5 minutes."
fi

if [ "${NO_EDGE:-0}" = 1 ]; then
  url='http://127.0.0.1:3210'
  log 'No Caddy: open through an SSH tunnel: ssh -L 3210:127.0.0.1:3210 farm@SERVER'
else
  domain="$(env_get DOMAIN)"
  url="https://$domain"
  log "Waiting for the HTTPS certificate of $domain (DNS must point here; ports 80/443 open)"
  if code="$(wait_http "$url/api/health" 180)"; then
    log "External HTTPS health: $code"
  else
    warn "External $url/api/health returned $code. Check DNS, ufw and: docker compose ... logs proxy"
  fi
fi

cat <<EOF

AI Farm is running.
  Office:   $url/office/trading
  Password: OWNER_PASSWORD in $APP_DIR/.env
  Status:   bash deploy/timeweb/status.sh
EOF
