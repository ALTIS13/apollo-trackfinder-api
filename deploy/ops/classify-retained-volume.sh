#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ]; then
  printf 'classification: input failed\n' >&2
  exit 1
fi
case "$1" in ''|*[!A-Za-z0-9_.-]* ) printf 'classification: input failed\n' >&2; exit 1 ;; esac
command -v docker >/dev/null 2>&1 || { printf 'classification: input failed\n' >&2; exit 1; }

inspected_name=$(docker volume inspect "$1" --format '{{.Name}}' 2>/dev/null) || { printf 'classification: input failed\n' >&2; exit 1; }
[ "$inspected_name" = "$1" ] || { printf 'classification: input failed\n' >&2; exit 1; }
attached=$(docker ps -aq --filter "volume=$1" 2>/dev/null) || { printf 'classification: input failed\n' >&2; exit 1; }
if [ -n "$attached" ]; then
  printf 'ATTACHED_BLOCKED\n'
else
  printf 'DETACHED_UNKNOWN\n'
fi
