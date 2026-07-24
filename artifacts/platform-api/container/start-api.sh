#!/bin/sh
set -eu

if [ "${1:-}" = "node" ] && [ "${2:-}" = "/app/dist/migrate.mjs" ]; then
  exec "$@"
fi

read_secret() {
  name=$1
  path=$2
  value=$(cat "$path")
  if [ -z "$value" ]; then
    echo "$name must not be empty" >&2
    exit 1
  fi
  printf '%s' "$value"
}

: "${DATABASE_URL_FILE:?DATABASE_URL_FILE must be configured}"
export DATABASE_URL
DATABASE_URL=$(read_secret DATABASE_URL "$DATABASE_URL_FILE")

if [ "${PLATFORM_SMOKE_CONTAINER:-false}" != "true" ]; then
  : "${APOLLO_ASSERTION_PRIVATE_JWK_FILE:?APOLLO_ASSERTION_PRIVATE_JWK_FILE must be configured}"
  : "${APOLLO_ASSERTION_PUBLIC_JWKS_FILE:?APOLLO_ASSERTION_PUBLIC_JWKS_FILE must be configured}"
  : "${APOLLO_OAUTH_CLIENTS_FILE:?APOLLO_OAUTH_CLIENTS_FILE must be configured}"
  : "${APOLLO_OPERATOR_BOOTSTRAP_TOKEN_FILE:?APOLLO_OPERATOR_BOOTSTRAP_TOKEN_FILE must be configured}"
  export APOLLO_OPERATOR_BOOTSTRAP_TOKEN
  APOLLO_OPERATOR_BOOTSTRAP_TOKEN=$(
    read_secret APOLLO_OPERATOR_BOOTSTRAP_TOKEN "$APOLLO_OPERATOR_BOOTSTRAP_TOKEN_FILE"
  )
fi

exec "$@"
