#!/bin/sh
set -eu

# Docker/Compose file secrets may stay bind-backed with the host owner/mode.
# Copy the secret into a private tmpfs as the runtime uid/mode, then drop privileges.
SOURCE_PATH="${QQPET_OWNER_ADMIN_CREDENTIAL_SOURCE:?owner credential secret path is required}"
TARGET_PATH="${QQPET_OWNER_ADMIN_CREDENTIAL:?runtime owner credential path is required}"

if [ "$(id -u)" -ne 0 ]; then
  echo "qqpet secret entrypoint must start as root" >&2
  exit 1
fi
if [ -f "$SOURCE_PATH" ] && [ -s "$SOURCE_PATH" ]; then
  :
else
  echo "qqpet owner credential secret is missing or empty" >&2
  exit 1
fi

NODE_UID="$(id -u node)"
NODE_GID="$(id -g node)"
TARGET_DIR="$(dirname "$TARGET_PATH")"
install -d -o "$NODE_UID" -g "$NODE_GID" -m 0700 "$TARGET_DIR"
install -m 0400 -o "$NODE_UID" -g "$NODE_GID" "$SOURCE_PATH" "$TARGET_PATH"
exec setpriv --reuid="$NODE_UID" --regid="$NODE_GID" --clear-groups node dist/server/src/index.js "$@"
