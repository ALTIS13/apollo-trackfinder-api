#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  printf 'usage: caddy-protected-command.sh <validate|reload> <environment-file> <complete-config>\n' >&2
  exit 64
fi

operation=$1
environment_file=$2
complete_config=$3
case "$operation" in
  validate | reload) ;;
  *)
    printf 'unsupported Caddy operation\n' >&2
    exit 64
    ;;
esac

unset APOLLO_ADMIN_CADDY_USER APOLLO_ADMIN_CADDY_PASSWORD_HASH
if [ -e "$environment_file" ]; then
  [ -f "$environment_file" ]
  set -a
  . "$environment_file"
  set +a
fi

exec /usr/bin/caddy "$operation" \
  --config "$complete_config" \
  --adapter caddyfile
