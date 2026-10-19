#!/usr/bin/env bash
# One-screen status without model costs: services, health/readiness, backups, disk, memory.
set -uo pipefail

# shellcheck source=deploy/timeweb/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "Image: $(env_get FARM_IMAGE)   previous: $(env_get FARM_IMAGE_PREVIOUS)"
echo "Trading live: $(env_get TRADING_LIVE_ENABLED)   execution live: $(env_get EXECUTION_LIVE_ENABLED) [$(env_get EXECUTION_LIVE_ACCEPTED_TRACKS)]"
echo "Model provider: $(env_get MODEL_PROVIDER)   autonomy: $(env_get AUTONOMY_ENABLED)"
echo
for svc in $(services); do printf '  %-9s %s\n' "$svc" "$(service_state "$svc")"; done
echo
printf 'health:    %s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3210/api/health)"
printf 'readiness: %s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3210/api/readiness)"
if [ "${NO_EDGE:-0}" != 1 ] && [ -n "$(env_get DOMAIN)" ]; then
  printf 'external:  %s  https://%s\n' \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$(env_get DOMAIN)/api/health")" "$(env_get DOMAIN)"
fi
echo
echo 'Latest backups:'
find "$APP_DIR/backups" -maxdepth 1 -name 'farm-*.dump' -printf '  %TY-%Tm-%Td %TH:%TM  %8k KB  %f\n' 2>/dev/null |
  sort -r | head -n 3
echo
df -h / | tail -n 1 | awk '{print "Disk: " $3 " used of " $2 " (" $5 ")"}'
free -h | awk '/Mem:/ {print "RAM:  " $3 " used of " $2}'
