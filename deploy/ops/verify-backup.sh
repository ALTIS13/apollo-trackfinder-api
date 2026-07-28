#!/bin/sh
set -eu
umask 077

stage=input

cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    printf 'verify: %s failed\n' "$stage" >&2
  fi
}
trap cleanup EXIT HUP INT TERM

require_value() {
  value=$(printenv "$1" 2>/dev/null || :)
  [ -n "$value" ] || return 1
}

safe_release_id() {
  case "$1" in [A-Za-z0-9]* ) case "$1" in *[!A-Za-z0-9._-]* ) return 1 ;; esac ;; * ) return 1 ;; esac
}

safe_identifier() {
  case "$1" in [A-Za-z_]* ) case "$1" in *[!A-Za-z0-9_]* ) return 1 ;; esac ;; * ) return 1 ;; esac
}

valid_stack_database() {
  case "$1:$2" in
    apollo-platform:apollo_platform|apollo-tf:apollo_trackfinder|apollo-tf-integrations:apollo_tf_integrations ) return 0 ;;
    * ) return 1 ;;
  esac
}

if [ "$#" -ne 0 ] || ! require_value APOLLO_BACKUP_FILE || ! require_value APOLLO_BACKUP_CHECKSUM_FILE || ! require_value APOLLO_BACKUP_METADATA_FILE || ! require_value APOLLO_BACKUP_EXPECTED_STACK || ! require_value APOLLO_BACKUP_EXPECTED_DATABASE || ! require_value APOLLO_BACKUP_EXPECTED_RELEASE_ID; then
  exit 1
fi

[ -r "$APOLLO_BACKUP_FILE" ] && [ -r "$APOLLO_BACKUP_CHECKSUM_FILE" ] && [ -r "$APOLLO_BACKUP_METADATA_FILE" ] && safe_identifier "$APOLLO_BACKUP_EXPECTED_DATABASE" && safe_release_id "$APOLLO_BACKUP_EXPECTED_RELEASE_ID" && valid_stack_database "$APOLLO_BACKUP_EXPECTED_STACK" "$APOLLO_BACKUP_EXPECTED_DATABASE" || exit 1
command -v sha256sum >/dev/null 2>&1 || exit 1

stage=checksum
expected_checksum=$(tr -d '\r\n' < "$APOLLO_BACKUP_CHECKSUM_FILE")
[ -n "$expected_checksum" ] || exit 1
actual_checksum=$(sha256sum "$APOLLO_BACKUP_FILE" | awk '{print $1}' | tr -d '\r') || exit 1
[ "$actual_checksum" = "$expected_checksum" ] || exit 1

stage=metadata
expected_metadata=$(printf '{"format_version":1,"stack":"%s","database":"%s","release_id":"%s","encrypted_sha256":"%s"}' "$APOLLO_BACKUP_EXPECTED_STACK" "$APOLLO_BACKUP_EXPECTED_DATABASE" "$APOLLO_BACKUP_EXPECTED_RELEASE_ID" "$expected_checksum")
metadata=$(tr -d '\r\n' < "$APOLLO_BACKUP_METADATA_FILE")
[ "$metadata" = "$expected_metadata" ] || exit 1
printf 'verify: complete\n'
