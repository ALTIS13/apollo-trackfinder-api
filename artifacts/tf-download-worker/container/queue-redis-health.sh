#!/bin/sh
set -eu

[ "${TF_DOWNLOAD_QUEUE_PASSWORD_FILE+x}" = "x" ] || exit 1
[ -f "$TF_DOWNLOAD_QUEUE_PASSWORD_FILE" ] || exit 1
[ -r "$TF_DOWNLOAD_QUEUE_PASSWORD_FILE" ] || exit 1

password=$(sed -n '1p' "$TF_DOWNLOAD_QUEUE_PASSWORD_FILE") || exit 1
[ -n "$password" ] || exit 1
response=$(
  REDISCLI_AUTH="$password" timeout 3 redis-cli \
    --no-auth-warning \
    --raw \
    -h 127.0.0.1 \
    -p 6379 \
    ping 2>/dev/null
) || exit 1
unset password

[ "$response" = "PONG" ]
