#!/bin/sh
set -eu

check_file() {
  path=$1
  minimum=$2
  maximum=$3
  if [ ! -r "$path" ]; then
    exit 1
  fi
  size=$(wc -c < "$path")
  if [ "$size" -lt "$minimum" ] || [ "$size" -gt "$maximum" ]; then
    unset size
    exit 1
  fi
  unset size
}

: "${TF_INTEGRATIONS_DATABASE_URL_FILE:?}"
check_file "$TF_INTEGRATIONS_DATABASE_URL_FILE" 1 8192

if [ "${1:-}" = "node" ] && [ "${2:-}" = "/app/dist/migrate.mjs" ]; then
  exec "$@"
fi

: "${TF_INTEGRATIONS_TOKEN_KEYRING_FILE:?}"
: "${TF_INTEGRATIONS_SPOTIFY_CLIENT_ID_FILE:?}"
: "${TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET_FILE:?}"
: "${TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE:?}"
: "${TF_INTEGRATIONS_HEARTBEAT_SECRET_FILE:?}"

check_file "$TF_INTEGRATIONS_TOKEN_KEYRING_FILE" 1 4096
check_file "$TF_INTEGRATIONS_SPOTIFY_CLIENT_ID_FILE" 1 8192
check_file "$TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET_FILE" 1 8192
check_file "$TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE" 32 512
check_file "$TF_INTEGRATIONS_HEARTBEAT_SECRET_FILE" 32 512

if cmp -s \
  "$TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE" \
  "$TF_INTEGRATIONS_HEARTBEAT_SECRET_FILE"; then
  exit 1
fi

unset DATABASE_URL
unset SPOTIFY_CLIENT_ID SPOTIFY_CLIENT_SECRET
unset TF_INTEGRATIONS_INTERNAL_AUTH_SECRET TF_INTEGRATIONS_HEARTBEAT_SECRET
unset TF_INTEGRATIONS_TOKEN_KEYRING

exec "$@"
