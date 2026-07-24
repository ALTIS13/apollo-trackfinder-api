#!/bin/sh
set -eu

: "${TF_SEARCH_INTERNAL_AUTH_SECRET_FILE:?TF_SEARCH_INTERNAL_AUTH_SECRET_FILE must be configured}"
: "${TF_SEARCH_HEARTBEAT_SECRET_FILE:?TF_SEARCH_HEARTBEAT_SECRET_FILE must be configured}"

if [ ! -r "$TF_SEARCH_INTERNAL_AUTH_SECRET_FILE" ] ||
  [ ! -r "$TF_SEARCH_HEARTBEAT_SECRET_FILE" ]; then
  exit 1
fi

internal_auth_secret=$(cat "$TF_SEARCH_INTERNAL_AUTH_SECRET_FILE")
heartbeat_secret=$(cat "$TF_SEARCH_HEARTBEAT_SECRET_FILE")
if [ "${#internal_auth_secret}" -lt 32 ] ||
  [ "${#internal_auth_secret}" -gt 512 ] ||
  [ "${#heartbeat_secret}" -lt 32 ] ||
  [ "${#heartbeat_secret}" -gt 512 ] ||
  [ "$internal_auth_secret" = "$heartbeat_secret" ]; then
  unset internal_auth_secret heartbeat_secret
  exit 1
fi
unset internal_auth_secret heartbeat_secret

exec "$@"
