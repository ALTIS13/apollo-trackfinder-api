#!/bin/sh
set -eu

fail() {
  printf '%s\n' "TF download queue startup failed" >&2
  exit 1
}

[ "$(id -u)" = "999" ] || fail
[ "$(id -g)" = "999" ] || fail
[ "${TF_DOWNLOAD_QUEUE_PASSWORD_FILE+x}" = "x" ] || fail
[ -f "$TF_DOWNLOAD_QUEUE_PASSWORD_FILE" ] || fail
[ -r "$TF_DOWNLOAD_QUEUE_PASSWORD_FILE" ] || fail

password=$(sed -n '1p' "$TF_DOWNLOAD_QUEUE_PASSWORD_FILE") || fail
password_bytes=$(printf '%s' "$password" | wc -c)
[ "$password_bytes" -ge 32 ] || fail
[ "$password_bytes" -le 512 ] || fail
case "$password" in
  *[!A-Za-z0-9_-]*) fail ;;
esac

config_file=/tmp/tf-download-redis.conf
umask 077
{
  printf '%s\n' "appendonly yes"
  printf '%s\n' "appendfsync everysec"
  printf '%s\n' "dir /data"
  printf 'requirepass "%s"\n' "$password"
} > "$config_file"
unset password password_bytes

exec redis-server "$config_file"
