#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP="${1:?usage: restore.sh /var/backups/server-manager/timestamp/file}"
META="$BACKUP.json"
[[ -f "$BACKUP" && -f "$META" ]] || { echo "Backup or metadata missing." >&2; exit 1; }
EXPECTED="$(awk '{print $1}' "$BACKUP.sha256")"
ACTUAL="$(sha256sum -- "$BACKUP" | awk '{print $1}')"
[[ "$EXPECTED" = "$ACTUAL" ]] || { echo "Checksum verification failed." >&2; exit 1; }
ORIGINAL="$(sed -n 's/.*"originalPath":"\([^"]*\)".*/\1/p' "$META")"
[[ "$ORIGINAL" = /etc/nginx/sites-available/* || "$ORIGINAL" = /etc/nginx/sites-enabled/* || "$ORIGINAL" = /etc/server-manager/allowlisted/* ]] || { echo "Original path is not allowlisted." >&2; exit 1; }
CURRENT="$(dirname "$ORIGINAL")/.$(basename "$ORIGINAL").pre-restore.$(date -u +%Y%m%d%H%M%S)"
cp --preserve=mode,ownership,timestamps -- "$ORIGINAL" "$CURRENT"
TMP="${ORIGINAL}.restore.$$"
cp --preserve=mode,ownership,timestamps -- "$BACKUP" "$TMP"
mv -- "$TMP" "$ORIGINAL"
echo "Restored $ORIGINAL; current file backed up at $CURRENT"
