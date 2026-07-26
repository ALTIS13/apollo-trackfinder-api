#!/bin/sh
set -eu

if [ "${TF_DOWNLOAD_SMOKE_FIXTURES+x}" = "x" ]; then
  if [ "${NODE_ENV:-}" != "test" ] ||
    [ "$TF_DOWNLOAD_SMOKE_FIXTURES" != "true" ]; then
    printf '%s\n' "TF download smoke fixture configuration rejected" >&2
    exit 1
  fi
  export TF_DOWNLOAD_YT_DLP_PATH=/app/bin/smoke-downloader.sh
  export NODE_OPTIONS=--import=/app/bin/smoke-deadline.mjs
fi

exec "$@"
