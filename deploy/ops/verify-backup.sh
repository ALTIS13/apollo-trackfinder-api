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
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

require_value() {
  eval "value=\${$1-}"
  [ -n "$value" ]
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

expected_postgres_major() {
  case "$1:$2" in
    apollo-platform:apollo_platform|apollo-tf:apollo_trackfinder)
      expected_major=16
      ;;
    apollo-tf-integrations:apollo_tf_integrations)
      expected_major=17
      ;;
    *)
      return 1
      ;;
  esac
}

read_one_line() {
  file_value=
  line_count=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_count=$((line_count + 1))
    [ "$line_count" -eq 1 ] || return 1
    file_value=$line
  done < "$1"
  [ "$line_count" -eq 1 ]
}

if [ "$#" -ne 0 ] || ! require_value APOLLO_BACKUP_FILE || ! require_value APOLLO_BACKUP_CHECKSUM_FILE || ! require_value APOLLO_BACKUP_METADATA_FILE || ! require_value APOLLO_BACKUP_EXPECTED_STACK || ! require_value APOLLO_BACKUP_EXPECTED_DATABASE || ! require_value APOLLO_BACKUP_EXPECTED_RELEASE_ID; then
  exit 1
fi

[ -r "$APOLLO_BACKUP_FILE" ] && [ -r "$APOLLO_BACKUP_CHECKSUM_FILE" ] && [ -r "$APOLLO_BACKUP_METADATA_FILE" ] && safe_identifier "$APOLLO_BACKUP_EXPECTED_DATABASE" && safe_release_id "$APOLLO_BACKUP_EXPECTED_RELEASE_ID" && valid_stack_database "$APOLLO_BACKUP_EXPECTED_STACK" "$APOLLO_BACKUP_EXPECTED_DATABASE" && expected_postgres_major "$APOLLO_BACKUP_EXPECTED_STACK" "$APOLLO_BACKUP_EXPECTED_DATABASE" || exit 1
command -v sha256sum >/dev/null 2>&1 || exit 1

stage=metadata
read_one_line "$APOLLO_BACKUP_CHECKSUM_FILE" || exit 1
expected_checksum=$file_value
expected_checksum=${expected_checksum%"$(printf '\r')"}
case "$expected_checksum" in ''|*[!0123456789abcdef]* ) exit 1 ;; esac
[ "${#expected_checksum}" -eq 64 ] || exit 1
expected_metadata=$(printf '{"format_version":2,"stack":"%s","database":"%s","release_id":"%s","postgres_client_major":%s,"postgres_server_major":%s,"encrypted_sha256":"%s"}' "$APOLLO_BACKUP_EXPECTED_STACK" "$APOLLO_BACKUP_EXPECTED_DATABASE" "$APOLLO_BACKUP_EXPECTED_RELEASE_ID" "$expected_major" "$expected_major" "$expected_checksum")
read_one_line "$APOLLO_BACKUP_METADATA_FILE" || exit 1
file_value=${file_value%"$(printf '\r')"}
[ "$file_value" = "$expected_metadata" ] || exit 1

stage=checksum
actual_checksum=$(sha256sum "$APOLLO_BACKUP_FILE" 2>/dev/null) || exit 1
case "$actual_checksum" in \\*) actual_checksum=${actual_checksum#\\} ;; esac
set -- $actual_checksum
[ "$#" -ge 1 ] || exit 1
[ "$1" = "$expected_checksum" ] || exit 1
printf 'verify: complete\n'
