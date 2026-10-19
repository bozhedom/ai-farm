#!/usr/bin/env bash
# First-time preparation of a fresh Ubuntu 24.04 Timeweb Cloud VPS for AI Farm. Run as root.
# Idempotent: every step checks the current state and can be re-run safely.
#
#   bash deploy/timeweb/bootstrap.sh                     # from an uploaded copy of the repository
#   REPO_URL=git@github.com:owner/ai-farm.git bash bootstrap.sh
#
# Environment (all optional):
#   DEPLOY_USER=farm            non-root user that owns /opt/ai-farm and runs Docker Compose
#   APP_DIR=/opt/ai-farm        application directory
#   REPO_URL=...                git URL to clone when APP_DIR is empty (otherwise this checkout is copied)
#   REPO_REF=main               branch or tag for REPO_URL
#   SSH_PUBKEY='ssh-ed25519 …'  extra public key for DEPLOY_USER
#   DOMAIN=farm.example.ru      public name; default farm.<public-ip>.sslip.io
#   DOCKER_REGISTRY_MIRROR=https://…  optional Docker Hub mirror written to /etc/docker/daemon.json
#   SKIP_STEPS="swap,ssh,…"     steps to skip: packages,time,swap,user,ssh,ufw,fail2ban,upgrades,
#                               docker,network,app,env (used for container dry runs)
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
DEPLOY_USER="${DEPLOY_USER:-farm}"
APP_DIR="${APP_DIR:-/opt/ai-farm}"
REPO_REF="${REPO_REF:-main}"
SKIP_STEPS=",${SKIP_STEPS:-},"
export APP_DIR
# shellcheck source=deploy/timeweb/lib.sh
. "$SELF_DIR/lib.sh"

[ "$(id -u)" = 0 ] || die 'Run as root: sudo bash deploy/timeweb/bootstrap.sh'
skip() {
  case "$SKIP_STEPS" in *",$1,"*) return 0 ;; *) return 1 ;; esac
}
has_systemd() { [ -d /run/systemd/system ]; }
step() {
  if skip "$1"; then
    log "skip $1"
    return 1
  fi
  log "$1: $2"
}

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] ||
    warn "Tested on Ubuntu 24.04, found ${PRETTY_NAME:-unknown}. Continuing."
fi
export DEBIAN_FRONTEND=noninteractive

if step packages 'base packages'; then
  apt-get update -q
  apt-get install -yq --no-install-recommends ca-certificates curl gnupg git rsync openssl sudo \
    ufw fail2ban unattended-upgrades chrony jq
fi

if step time 'UTC timezone and NTP (exchanges reject requests with a skewed clock)'; then
  if has_systemd; then
    timedatectl set-timezone UTC
    systemctl enable --now chrony >/dev/null 2>&1 || systemctl enable --now chronyd >/dev/null
    timedatectl set-ntp true 2>/dev/null || true
    chronyc -n tracking | grep -E 'Leap status|System time' || true
  else
    warn 'systemd is not running: time sync not configured'
  fi
fi

if step swap 'swap file when RAM <= 4 GB (Nuxt build needs headroom)'; then
  mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  if [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
    log 'swap already active'
  elif [ "$mem_kb" -le $((4300 * 1024)) ]; then
    size=2G
    [ "$mem_kb" -le $((2300 * 1024)) ] && size=4G
    [ -f /swapfile ] || { fallocate -l "$size" /swapfile && chmod 600 /swapfile && mkswap /swapfile; }
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    echo 'vm.swappiness=10' >/etc/sysctl.d/90-ai-farm-swap.conf
    sysctl -q -p /etc/sysctl.d/90-ai-farm-swap.conf
  else
    log 'RAM > 4 GB, swap not needed'
  fi
fi

if step docker 'Docker Engine and Compose plugin from download.docker.com'; then
  if ! docker compose version >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    # shellcheck disable=SC1091
    codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" \
      >/etc/apt/sources.list.d/docker.list
    apt-get update -q
    apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  if [ ! -f /etc/docker/daemon.json ]; then
    mkdir -p /etc/docker
    if [ -n "${DOCKER_REGISTRY_MIRROR:-}" ]; then
      mirror=",\"registry-mirrors\":[\"$DOCKER_REGISTRY_MIRROR\"]"
    else
      mirror=''
    fi
    printf '{"log-driver":"json-file","log-opts":{"max-size":"20m","max-file":"5"},"live-restore":true%s}\n' \
      "$mirror" >/etc/docker/daemon.json
    if has_systemd; then systemctl restart docker; fi
  fi
  if has_systemd; then systemctl enable --now docker >/dev/null; fi
  docker compose version
fi

if step user "deploy user $DEPLOY_USER"; then
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    adduser --disabled-password --gecos '' "$DEPLOY_USER"
  fi
  if getent group docker >/dev/null; then usermod -aG docker "$DEPLOY_USER"; fi
  usermod -aG sudo "$DEPLOY_USER"
  # The user has no password (SSH keys only), so sudo must not ask for one. Membership in the
  # docker group is root-equivalent anyway; keep this account's key as safe as root's.
  echo "$DEPLOY_USER ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/90-ai-farm
  chmod 440 /etc/sudoers.d/90-ai-farm
  visudo -cf /etc/sudoers.d/90-ai-farm >/dev/null
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
  keys="$home/.ssh/authorized_keys"
  touch "$keys"
  if [ -s /root/.ssh/authorized_keys ]; then
    while IFS= read -r line; do
      if [ -n "$line" ] && ! grep -qxF "$line" "$keys"; then printf '%s\n' "$line" >>"$keys"; fi
    done </root/.ssh/authorized_keys
  fi
  if [ -n "${SSH_PUBKEY:-}" ] && ! grep -qxF "$SSH_PUBKEY" "$keys"; then
    printf '%s\n' "$SSH_PUBKEY" >>"$keys"
  fi
  chown "$DEPLOY_USER:$DEPLOY_USER" "$keys"
  chmod 600 "$keys"
fi

if step ssh 'SSH hardening (only when key login is already possible)'; then
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6 || true)"
  conf=/etc/ssh/sshd_config.d/10-ai-farm.conf
  if [ -s /root/.ssh/authorized_keys ] || { [ -n "$home" ] && [ -s "$home/.ssh/authorized_keys" ]; }; then
    # 10- sorts before Ubuntu's 50-cloud-init.conf; sshd keeps the first value it reads.
    cat >"$conf" <<'EOF'
# Managed by deploy/timeweb/bootstrap.sh
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
MaxAuthTries 4
X11Forwarding no
EOF
    if sshd -t 2>/dev/null; then
      if has_systemd; then systemctl reload ssh 2>/dev/null || systemctl restart ssh; fi
      log 'Password login disabled. Before closing this session, check key login in a NEW terminal.'
    else
      rm -f "$conf"
      warn 'sshd -t failed; hardening reverted'
    fi
  else
    warn 'No authorized_keys for root or the deploy user: password login left ENABLED.'
    warn 'Add a key (ssh-copy-id root@SERVER) and re-run this script.'
  fi
fi

if step ufw 'firewall: 22, 80, 443'; then
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  ufw status verbose | sed -n '1,12p'
  # Docker publishes ports past ufw. Compose binds PostgreSQL (55432) and web (3210) to 127.0.0.1
  # only; Caddy is the only public listener.
fi

if step fail2ban 'fail2ban for sshd'; then
  cat >/etc/fail2ban/jail.d/ai-farm.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  if has_systemd; then
    systemctl enable --now fail2ban >/dev/null
    systemctl restart fail2ban
  fi
fi

if step upgrades 'unattended security upgrades (no automatic reboot)'; then
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
  cat >/etc/apt/apt.conf.d/52ai-farm-unattended <<'EOF'
// A reboot interrupts open trades; the owner reboots manually (containers restart themselves).
Unattended-Upgrade::Automatic-Reboot "false";
EOF
  if has_systemd; then systemctl enable --now unattended-upgrades >/dev/null; fi
fi

if step network 'reachability of exchanges, model provider and registries'; then
  bash "$SELF_DIR/netcheck.sh" || warn 'Some endpoints are unreachable from this location; see above.'
fi

if step app "application in $APP_DIR"; then
  if [ -f "$APP_DIR/compose.yaml" ]; then
    log "$APP_DIR already contains the application; not touched (use update.sh)"
  elif [ -n "${REPO_URL:-}" ]; then
    git clone --branch "$REPO_REF" "$REPO_URL" "$APP_DIR"
  elif [ -f "$SOURCE_ROOT/compose.yaml" ] && [ "$SOURCE_ROOT" != "$APP_DIR" ]; then
    mkdir -p "$APP_DIR"
    # A git worktree has a .git *file* pointing outside the copy; only a real .git dir is useful.
    git_rule=()
    [ -d "$SOURCE_ROOT/.git" ] || git_rule=(--exclude .git)
    rsync -a --include .env.example --exclude .env --exclude '.env.*' --exclude node_modules --exclude .nuxt \
      --exclude .output --exclude output --exclude backups --exclude .health --exclude .secrets \
      --exclude releases --exclude .claude "${git_rule[@]}" "$SOURCE_ROOT/" "$APP_DIR/"
  else
    die "No application source. Upload the repository or set REPO_URL."
  fi
  if id "$DEPLOY_USER" >/dev/null 2>&1; then chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"; fi
  chmod 700 "$APP_DIR"
  install -d -m 700 "$APP_DIR/backups"
  install -d -m 755 "$APP_DIR/.health"
  if id "$DEPLOY_USER" >/dev/null 2>&1; then
    chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/backups" "$APP_DIR/.health"
  fi
fi

if step env 'private .env with fresh secrets'; then
  env_file="$APP_DIR/.env"
  if [ -f "$env_file" ]; then
    log '.env already exists; secrets and settings preserved'
    if [ -z "$(env_get VM_AGENT_TOKEN "$env_file")" ]; then
      env_set VM_AGENT_TOKEN "$(openssl rand -hex 32)" "$env_file"
      log 'Added the missing VM_AGENT_TOKEN (nothing else changed)'
    fi
  else
    [ -f "$APP_DIR/.env.example" ] || die "$APP_DIR/.env.example is missing"
    if [ -z "${DOMAIN:-}" ]; then
      ip="$(curl -4fsS --max-time 10 https://api.ipify.org || curl -4fsS --max-time 10 https://ifconfig.me || true)"
      [ -n "$ip" ] || die 'Cannot detect the public IP; set DOMAIN=...'
      DOMAIN="farm.$ip.sslip.io"
    fi
    uid="$(id -u "$DEPLOY_USER" 2>/dev/null || echo 1000)"
    gid="$(id -g "$DEPLOY_USER" 2>/dev/null || echo 1000)"
    db_password="$(openssl rand -hex 24)"
    owner_password="$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n')"
    session_secret="$(openssl rand -hex 48)"
    (umask 077 && sed -e "s|CHANGE_ME|$db_password|g" "$APP_DIR/.env.example" >"$env_file.tmp")
    env_set LOCAL_UID "$uid" "$env_file.tmp"
    env_set LOCAL_GID "$gid" "$env_file.tmp"
    env_set OWNER_PASSWORD "$owner_password" "$env_file.tmp"
    env_set SESSION_SECRET "$session_secret" "$env_file.tmp"
    env_set APP_ORIGIN "https://$DOMAIN" "$env_file.tmp"
    env_set SECURE_COOKIE true "$env_file.tmp"
    env_set TRUST_PROXY true "$env_file.tmp"
    env_set DOMAIN "$DOMAIN" "$env_file.tmp"
    env_set FARM_DB_VOLUME "$(env_get FARM_DB_VOLUME "$env_file.tmp" | grep . || echo ai-farm-db)" "$env_file.tmp"
    env_set FARM_IMAGE "$(env_get FARM_IMAGE "$env_file.tmp" | grep . || echo ai-farm:pending)" "$env_file.tmp"
    # Server autonomy (docs/33-autonomy.md): the worker autopilot starts Paper/Demo loops itself,
    # never Live, and a stuck loop exits so Docker restarts the worker.
    env_set AUTOPILOT_ON_BOOT true "$env_file.tmp"
    env_set WORKER_STUCK_RESTART true "$env_file.tmp"
    env_set PACING_ENABLED true "$env_file.tmp"
    # Shared secret with the separate computer-use VM (docs/32-computer-use.md); off until enabled.
    env_set VM_AGENT_TOKEN "$(openssl rand -hex 32)" "$env_file.tmp"
    chmod 600 "$env_file.tmp"
    if id "$DEPLOY_USER" >/dev/null 2>&1; then chown "$DEPLOY_USER:$DEPLOY_USER" "$env_file.tmp"; fi
    mv "$env_file.tmp" "$env_file"
    printf '\n\033[1;32mOwner password (shown once; it is also OWNER_PASSWORD in %s, mode 600):\033[0m\n  %s\n\n' \
      "$env_file" "$owner_password"
  fi
fi

cat <<EOF

Bootstrap finished. Next, as $DEPLOY_USER:
  ssh $DEPLOY_USER@<server-ip>
  cd $APP_DIR && bash deploy/timeweb/deploy.sh
Runbook: docs/34-launch-timeweb.md
EOF
