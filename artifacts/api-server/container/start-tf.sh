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

exec "$@"
