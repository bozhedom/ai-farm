#!/usr/bin/env bash
# Checks from THIS server that exchanges, the model provider and image registries answer.
# Run right after renting the VPS: a 403/451 or timeout usually means the provider blocks the
# server's country or IP range. Recreate the VPS in another Timeweb location in that case.
# Read-only: public endpoints only, no keys are used or sent.
set -uo pipefail

failed=0
check() {
  local name="$1" url="$2" ok="${3:-200}" code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url")"
  [ -n "$code" ] || code=000
  case " $ok " in
    *" $code "*) printf '  OK    %-24s %s\n' "$name" "$code" ;;
    *)
      printf '  FAIL  %-24s %s  %s\n' "$name" "$code" "$url"
      failed=$((failed + 1))
      ;;
  esac
}

echo "Public IP: $(curl -4fsS --max-time 10 https://api.ipify.org || echo unknown)"
echo 'Trading (required for Bybit; others only if used):'
check 'Bybit live API' https://api.bybit.com/v5/market/time
check 'Bybit demo API' https://api-demo.bybit.com/v5/market/time
check 'OKX API' https://openapi.okx.com/api/v5/public/time
check 'Binance API' https://api.binance.com/api/v3/time
check 'Bitget API' https://api.bitget.com/api/v2/public/time
echo 'Models and images:'
check 'OpenRouter' https://openrouter.ai/api/v1/models
check 'Docker Hub registry' https://registry-1.docker.io/v2/ '200 401'
check 'Docker apt repo' https://download.docker.com/linux/ubuntu/gpg
check 'npm registry' https://registry.npmjs.org/ '200'

server_ms="$(curl -s --max-time 10 https://api.bybit.com/v5/market/time | sed -n 's/.*"timeNano":"\([0-9]*\)[0-9]\{6\}".*/\1/p')"
if [ -n "$server_ms" ]; then
  skew=$((server_ms - $(date +%s%3N)))
  echo "Clock offset to Bybit: ${skew} ms (exchanges reject roughly > 4000 ms; includes network latency)"
fi

if [ "$failed" -gt 0 ]; then
  echo "$failed check(s) failed. See docs/34-launch-timeweb.md, section about the server location."
  exit 1
fi
echo 'All endpoints reachable.'
