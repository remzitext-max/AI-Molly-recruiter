#!/usr/bin/env bash
# One-time install on a fresh Ubuntu server (tested target: Hetzner CX23, Ubuntu 24.04).
# Usage (as root):  bash install.sh <git-repo-url> [domain]
# Without a domain the app uses <server-ip>.sslip.io, which still gets a real HTTPS certificate.
# Starts in DEMO mode: no real calls or texts can be sent until live mode is configured.
set -euo pipefail

REPO_URL="${1:?Usage: bash install.sh <git-repo-url> [domain]}"
DOMAIN="${2:-}"
APP_DIR=/opt/molly-recruiter

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo -i)"; exit 1; }

echo "== Installing Docker, git and firewall"
apt-get update -y
apt-get install -y ca-certificates curl git ufw openssl
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi

echo "== Firewall: allow SSH, HTTP, HTTPS only"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

if ! swapon --show | grep -q .; then
  echo "== Adding 2 GB swap (the build needs memory)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Getting the code"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO_URL" "$APP_DIR"; fi
cd "$APP_DIR"

if [ -z "$DOMAIN" ]; then
  IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
  DOMAIN="${IP}.sslip.io"
fi

if [ ! -f .env ]; then
  echo "== Creating .env with random secrets"
  rnd() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
  ADMIN_PW=$(rnd 20); RECRUITER_PW=$(rnd 20); DB_PW=$(rnd 32)
  cp .env.example .env
  set_env() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
  set_env APP_MODE demo
  set_env APP_URL "https://$DOMAIN"
  set_env DOMAIN "$DOMAIN"
  set_env SESSION_SECRET "$(rnd 64)"
  set_env POSTGRES_PASSWORD "$DB_PW"
  set_env DATABASE_URL "postgresql://molly:$DB_PW@db:5432/molly"
  set_env WEBHOOK_SIGNING_SECRET "$(rnd 48)"
  set_env LEAD_WEBHOOK_SECRET "$(rnd 48)"
  set_env SEED_ADMIN_EMAIL "admin@tbt.local"
  set_env SEED_ADMIN_PASSWORD "$ADMIN_PW"
  set_env SEED_RECRUITER_PASSWORD "$RECRUITER_PW"
  set_env ORG_NAME "TBT express"
  chmod 600 .env
  CREDS="Admin login: admin@tbt.local / $ADMIN_PW   (demo recruiters molly@demo.local and alex@demo.local: $RECRUITER_PW)"
else
  CREDS="Existing .env kept; logins unchanged."
fi

echo "== Building and starting (first build takes several minutes)"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

echo
echo "Done. Open https://$DOMAIN"
echo "$CREDS"
echo "Save these passwords now; they are not shown again. Change them after first login."
