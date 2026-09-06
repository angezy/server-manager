#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/server-manager}"
if [[ "$(id -u)" -ne 0 ]]; then echo "Run as root on Ubuntu." >&2; exit 1; fi
apt-get update
apt-get install -y ca-certificates curl git build-essential nginx openssl
id -u server-manager >/dev/null 2>&1 || useradd --system --home-dir /var/lib/server-manager --create-home --shell /usr/sbin/nologin server-manager
install -d -o server-manager -g server-manager -m 0750 "$APP_DIR" /var/lib/server-manager /var/log/server-manager /var/backups/server-manager
echo "Install prerequisites complete. Copy the project to $APP_DIR, run npm ci, create .env, then enable the systemd units."
