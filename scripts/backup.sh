#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE="${1:?usage: backup.sh /allowlisted/file}"
[[ "$SOURCE" = /etc/nginx/sites-available/* || "$SOURCE" = /etc/nginx/sites-enabled/* || "$SOURCE" = /etc/server-manager/allowlisted/* ]] || { echo "Path is not allowlisted." >&2; exit 1; }
[[ -f "$SOURCE" ]] || { echo "File does not exist." >&2; exit 1; }
STAMP="$(date -u +%Y-%m-%d_%H-%M-%S)"
DEST="/var/backups/server-manager/$STAMP"
install -d -m 0750 "$DEST"
NAME="$(basename -- "$SOURCE")"
cp --preserve=mode,ownership,timestamps -- "$SOURCE" "$DEST/$NAME"
CHECKSUM="$(sha256sum -- "$DEST/$NAME" | awk '{print $1}')"
printf '%s  %s\n' "$CHECKSUM" "$DEST/$NAME" > "$DEST/$NAME.sha256"
printf '{"originalPath":"%s","checksum":"%s","createdAt":"%s"}\n' "$SOURCE" "$CHECKSUM" "$(date -u +%FT%TZ)" > "$DEST/$NAME.json"
chmod 0640 "$DEST/$NAME" "$DEST/$NAME.sha256" "$DEST/$NAME.json"
echo "$DEST/$NAME"
