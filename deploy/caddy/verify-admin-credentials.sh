#!/bin/sh
set -eu

[ "$#" -eq 2 ] || exit 64
htpasswd_file=$1
caddy_environment_file=$2
[ -f "$htpasswd_file" ] && [ -f "$caddy_environment_file" ] || exit 1
[ "$(wc -l < "$htpasswd_file")" -eq 0 ] || exit 1

nginx_user=
nginx_hash=
if IFS=: read -r nginx_user nginx_hash < "$htpasswd_file"; then
  exit 1
fi
[ -n "$nginx_user" ] && [ -n "$nginx_hash" ] || exit 1
case "$nginx_hash" in *:*) exit 1 ;; esac

unset APOLLO_ADMIN_CADDY_USER APOLLO_ADMIN_CADDY_PASSWORD_HASH
set -a
. "$caddy_environment_file"
set +a
[ "${APOLLO_ADMIN_CADDY_USER+x}" = x ]
[ "${APOLLO_ADMIN_CADDY_PASSWORD_HASH+x}" = x ]
[ "$nginx_user" = "$APOLLO_ADMIN_CADDY_USER" ]
[ "$nginx_hash" = "$APOLLO_ADMIN_CADDY_PASSWORD_HASH" ]
