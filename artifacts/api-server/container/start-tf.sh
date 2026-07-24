#!/bin/sh
set -eu

: "${DATABASE_URL_FILE:?DATABASE_URL_FILE must be configured}"

if [ ! -r "$DATABASE_URL_FILE" ]; then
  exit 1
fi

database_url=$(cat "$DATABASE_URL_FILE")
if [ -z "$database_url" ] || [ "${#database_url}" -gt 4096 ]; then
  unset database_url
  exit 1
fi

export DATABASE_URL="$database_url"
unset database_url

if [ -n "${APOLLO_MODULE_HEARTBEAT_KEYS_FILE:-}" ]; then
  unset APOLLO_MODULE_HEARTBEAT_KEYS
  if [ ! -r "$APOLLO_MODULE_HEARTBEAT_KEYS_FILE" ]; then
    exit 1
  fi

  heartbeat_keys_size=$(wc -c < "$APOLLO_MODULE_HEARTBEAT_KEYS_FILE")
  if [ "$heartbeat_keys_size" -lt 1 ] || [ "$heartbeat_keys_size" -gt 131072 ]; then
    unset heartbeat_keys_size
    exit 1
  fi
  unset heartbeat_keys_size

  heartbeat_keys=$(cat "$APOLLO_MODULE_HEARTBEAT_KEYS_FILE")
  if [ -z "$(printf '%s' "$heartbeat_keys" | tr -d '[:space:]')" ]; then
    unset heartbeat_keys
    exit 1
  fi

  export APOLLO_MODULE_HEARTBEAT_KEYS="$heartbeat_keys"
  unset heartbeat_keys
fi

exec "$@"
