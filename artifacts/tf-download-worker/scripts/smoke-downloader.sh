#!/bin/sh
set -eu

for argument in "$@"; do
  source_url=$argument
done

case "${source_url:-}" in
  *mode=stderr*)
    stderr_value=${source_url##*stderr=}
    stderr_value=${stderr_value%%&*}
    printf '%s\n' "$stderr_value" >&2
    exit 17
    ;;
  *mode=size*)
    head -c 2048 /dev/zero | tr '\000' 'S'
    ;;
  *mode=quota*)
    head -c 1000 /dev/zero | tr '\000' 'Q'
    ;;
  *mode=hold*)
    head -c 900 /dev/zero | tr '\000' 'H'
    sleep 30
    ;;
  *mode=deadline*)
    head -c 256 /dev/zero | tr '\000' 'D'
    sleep 30
    ;;
  *mode=active*)
    count=0
    while [ "$count" -lt 300 ]; do
      printf '%s' "ACTIVE-FIXTURE-BYTES"
      count=$((count + 1))
      sleep 0.1
    done
    ;;
  *)
    head -c 600 /dev/zero | tr '\000' 'A'
    ;;
esac
