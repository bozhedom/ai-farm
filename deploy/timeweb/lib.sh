#!/usr/bin/env bash
# Shared helpers for deploy/timeweb/*.sh. Source it; do not run it directly.
# shellcheck shell=bash

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31mXX\033[0m %s\n' "$*" >&2
  exit 1
}

# Value of KEY from .env without sourcing it (values are never evaluated by the shell).
env_get() {
  local key="$1" file="${2:-$APP_DIR/.env}"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2-
}

# Replace or append KEY=VALUE in .env. VALUE must not contain newlines or '|'.
env_set() {
  local key="$1" value="$2" file="${3:-$APP_DIR/.env}"
  case "$value" in *'|'* | *$'\n'*) die "env_set: unsupported character in $key" ;; esac
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

# The production stack: app + prebuilt image + SearXNG + Caddy HTTPS. NO_EDGE=1 skips Caddy.
compose() {
  local files=(-f compose.yaml -f compose.prebuilt.yaml -f compose.cloud.yaml)
  [ "${NO_EDGE:-0}" = 1 ] || files+=(-f compose.edge.yaml)
  (cd "$APP_DIR" && docker compose "${files[@]}" --profile app "$@")
}

services() {
  local list=(db search web worker backup observer)
  [ "${NO_EDGE:-0}" = 1 ] || list+=(proxy)
  printf '%s\n' "${list[@]}"
}

service_state() {
  local id
  id="$(compose ps -q "$1" 2>/dev/null | head -n 1)"
  [ -n "$id" ] || {
    echo missing
    return
  }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id"
}

# Wait until every service is healthy (or running when it has no health check).
wait_healthy() {
  local timeout="${1:-600}" start svc state pending
  start="$(date +%s)"
  while :; do
    pending=''
    for svc in $(services); do
      state="$(service_state "$svc")"
      case "$state" in healthy | running) ;; *) pending="$pending $svc=$state" ;; esac
    done
    [ -z "$pending" ] && return 0
    if [ $(($(date +%s) - start)) -ge "$timeout" ]; then
      warn "Not healthy after ${timeout}s:$pending"
      return 1
    fi
    sleep 5
  done
}

# Poll URL until HTTP 2xx. Prints the final status code.
wait_http() {
  local url="$1" timeout="${2:-120}" start code
  start="$(date +%s)"
  while :; do
    code="$(curl -ks -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)"
    case "$code" in 2??)
      echo "$code"
      return 0
      ;;
    esac
    if [ $(($(date +%s) - start)) -ge "$timeout" ]; then
      echo "${code:-000}"
      return 1
    fi
    sleep 5
  done
}

require_env_file() {
  local file="$APP_DIR/.env" mode key value
  [ -f "$file" ] || die ".env not found in $APP_DIR. Run deploy/timeweb/bootstrap.sh first."
  mode="$(stat -c '%a' "$file")"
  [ "$mode" = 600 ] || die ".env must have mode 600 (now $mode): chmod 600 $file"
  for key in POSTGRES_PASSWORD OWNER_PASSWORD SESSION_SECRET FARM_DB_VOLUME; do
    value="$(env_get "$key")"
    case "$value" in '' | CHANGE_ME | GENERATE_WITH_SETUP) die "$key is not set in .env" ;; esac
  done
  if [ "${NO_EDGE:-0}" != 1 ]; then
    [ -n "$(env_get DOMAIN)" ] || die 'DOMAIN is empty in .env (or run with NO_EDGE=1)'
    [ "$(env_get APP_ORIGIN)" = "https://$(env_get DOMAIN)" ] ||
      die "APP_ORIGIN must be https://$(env_get DOMAIN)"
    [ "$(env_get SECURE_COOKIE)" = true ] || die 'SECURE_COOKIE must be true behind HTTPS'
  fi
}

# backup and observer run as LOCAL_UID:LOCAL_GID and write backups/ and .health/.
ensure_data_dirs() {
  local uid gid dir
  uid="$(env_get LOCAL_UID)"
  gid="$(env_get LOCAL_GID)"
  [ -n "$uid" ] && [ -n "$gid" ] || die 'LOCAL_UID/LOCAL_GID are missing in .env'
  for dir in backups .health; do
    mkdir -p "$APP_DIR/$dir" 2>/dev/null || sudo -n mkdir -p "$APP_DIR/$dir"
    if [ "$(stat -c '%u:%g' "$APP_DIR/$dir")" != "$uid:$gid" ]; then
      log "Fixing owner of $dir to $uid:$gid"
      if [ "$(id -u)" = 0 ]; then
        chown "$uid:$gid" "$APP_DIR/$dir"
      else
        sudo -n chown "$uid:$gid" "$APP_DIR/$dir" || die "chown $uid:$gid $APP_DIR/$dir failed"
      fi
    fi
  done
  # Computer-use screenshots are written by the image's `node` user (uid 1000), not LOCAL_UID.
  dir="$APP_DIR/output/computer-use"
  mkdir -p "$dir" 2>/dev/null || sudo -n mkdir -p "$dir"
  if [ "$(stat -c '%u:%g' "$dir")" != 1000:1000 ]; then
    log 'Fixing owner of output/computer-use to 1000:1000'
    if [ "$(id -u)" = 0 ]; then chown 1000:1000 "$dir"; else sudo -n chown 1000:1000 "$dir" || die "chown 1000:1000 $dir failed"; fi
  fi
  chmod 700 "$APP_DIR/backups" 2>/dev/null || sudo -n chmod 700 "$APP_DIR/backups"
  chmod 755 "$APP_DIR/.health" 2>/dev/null || sudo -n chmod 755 "$APP_DIR/.health"
}

# Manual pg_dump through the running db container; verifies the archive before returning its path.
backup_now() {
  local label="${1:-manual}" target
  mkdir -p "$APP_DIR/backups"
  chmod 700 "$APP_DIR/backups"
  target="$APP_DIR/backups/farm-$(date -u +%Y%m%dT%H%M%SZ)-$label-$$.dump"
  (umask 077 && compose exec -T db pg_dump -U farm -d farm -Fc >"$target.tmp")
  [ -s "$target.tmp" ] || die "Backup is empty: $target.tmp"
  compose exec -T db pg_restore --list <"$target.tmp" >/dev/null || die 'Backup archive is unreadable'
  mv "$target.tmp" "$target"
  echo "$target"
}
