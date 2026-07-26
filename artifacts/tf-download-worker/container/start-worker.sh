#!/bin/sh
set -eu

fail() {
  printf '%s\n' "TF download worker startup failed" >&2
  exit 1
}

[ "$(id -u)" = "10001" ] || fail
[ "$(id -g)" = "10001" ] || fail

[ "${TF_DOWNLOAD_QUEUE_REDIS_URL+x}" != "x" ] || fail
[ "${TF_DOWNLOAD_INTERNAL_AUTH_SECRET+x}" != "x" ] || fail
[ "${TF_DOWNLOAD_HEARTBEAT_SECRET+x}" != "x" ] || fail

[ "${TF_DOWNLOAD_QUEUE_REDIS_URL_FILE+x}" = "x" ] || fail
[ "${TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE+x}" = "x" ] || fail
[ "${TF_DOWNLOAD_HEARTBEAT_SECRET_FILE+x}" = "x" ] || fail
[ "${TF_DOWNLOAD_STORAGE_ROOT+x}" = "x" ] || fail

for secret_file in \
  "$TF_DOWNLOAD_QUEUE_REDIS_URL_FILE" \
  "$TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE" \
  "$TF_DOWNLOAD_HEARTBEAT_SECRET_FILE"
do
  [ -f "$secret_file" ] || fail
  [ -r "$secret_file" ] || fail
done

[ -d "$TF_DOWNLOAD_STORAGE_ROOT" ] || fail
[ -r "$TF_DOWNLOAD_STORAGE_ROOT" ] || fail
[ -w "$TF_DOWNLOAD_STORAGE_ROOT" ] || fail
[ -x "$TF_DOWNLOAD_STORAGE_ROOT" ] || fail
[ "$(stat -c "%u:%g" "$TF_DOWNLOAD_STORAGE_ROOT")" = "10001:10001" ] || fail
[ -x "${TF_DOWNLOAD_YT_DLP_PATH:-/usr/local/bin/yt-dlp}" ] || fail
command -v ffmpeg >/dev/null 2>&1 || fail

umask 077
exec "$@"
