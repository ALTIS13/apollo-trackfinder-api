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
htpasswd_bytes=$(wc -c < "$htpasswd_file" | tr -d '[:space:]')
parsed_bytes=$(printf '%s:%s' "$nginx_user" "$nginx_hash" |
  wc -c | tr -d '[:space:]')
case "$htpasswd_bytes" in ''|*[!0-9]*) exit 1 ;; esac
case "$parsed_bytes" in ''|*[!0-9]*) exit 1 ;; esac
[ "$htpasswd_bytes" = "$parsed_bytes" ] || exit 1
case "$nginx_hash" in *:*) exit 1 ;; esac
printf '%s\n' "$nginx_user" |
  grep -Eq '^[A-Za-z0-9_.@-]{1,128}$' || exit 1
printf '%s\n' "$nginx_hash" |
  grep -Eq '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' || exit 1

[ "$(wc -l < "$caddy_environment_file")" -eq 2 ] || exit 1
caddy_user_line=
caddy_hash_line=
{
  IFS= read -r caddy_user_line || exit 1
  IFS= read -r caddy_hash_line || exit 1
} < "$caddy_environment_file"
[ "$(wc -c < "$caddy_environment_file")" -eq \
  "$(printf '%s\n%s\n' "$caddy_user_line" "$caddy_hash_line" | wc -c)" ] || exit 1

user_prefix="APOLLO_ADMIN_CADDY_USER='"
hash_prefix="APOLLO_ADMIN_CADDY_PASSWORD_HASH='"
quote="'"
case "$caddy_user_line" in
  "$user_prefix"*"$quote")
    caddy_user=${caddy_user_line#"$user_prefix"}
    caddy_user=${caddy_user%"$quote"}
    ;;
  *) exit 1 ;;
esac
case "$caddy_hash_line" in
  "$hash_prefix"*"$quote")
    caddy_hash=${caddy_hash_line#"$hash_prefix"}
    caddy_hash=${caddy_hash%"$quote"}
    ;;
  *) exit 1 ;;
esac

printf '%s\n' "$caddy_user" |
  grep -Eq '^[A-Za-z0-9_.@-]{1,128}$' || exit 1
printf '%s\n' "$caddy_hash" |
  grep -Eq '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' || exit 1
[ "$nginx_user" = "$caddy_user" ]
[ "$nginx_hash" = "$caddy_hash" ]
