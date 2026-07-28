#!/bin/sh
set -eu
umask 077

stage=input
temporary_directory=
final_dump=
final_checksum=
final_metadata=
completed=0

cleanup() {
  result=$?
  if [ -n "$temporary_directory" ]; then
    rm -rf "$temporary_directory" >/dev/null 2>&1 || :
  fi
  if [ "$completed" -ne 1 ]; then
    rm -f "$final_dump" "$final_checksum" "$final_metadata" >/dev/null 2>&1 || :
  fi
  if [ "$result" -ne 0 ]; then
    printf 'backup: %s failed\n' "$stage" >&2
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

safe_host() {
  case "$1" in ''|*[!A-Za-z0-9.-]* ) return 1 ;; esac
}

safe_identifier() {
  case "$1" in [A-Za-z_]* ) case "$1" in *[!A-Za-z0-9_]* ) return 1 ;; esac ;; * ) return 1 ;; esac
}

safe_port() {
  case "$1" in *[!0-9]*|'' ) return 1 ;; esac
}

valid_stack_database() {
  case "$1:$2" in
    apollo-platform:apollo_platform|apollo-tf:apollo_trackfinder|apollo-tf-integrations:apollo_tf_integrations ) return 0 ;;
    * ) return 1 ;;
  esac
}

if [ "$#" -ne 0 ] || ! require_value PGPASSFILE || ! require_value APOLLO_BACKUP_PGHOST || ! require_value APOLLO_BACKUP_PGPORT || ! require_value APOLLO_BACKUP_PGDATABASE || ! require_value APOLLO_BACKUP_PGUSER || ! require_value APOLLO_BACKUP_STACK || ! require_value APOLLO_BACKUP_RELEASE_ID || ! require_value APOLLO_BACKUP_DESTINATION || ! require_value APOLLO_BACKUP_AGE_RECIPIENT; then
  exit 1
fi

[ -r "$PGPASSFILE" ] && safe_host "$APOLLO_BACKUP_PGHOST" && safe_port "$APOLLO_BACKUP_PGPORT" && safe_identifier "$APOLLO_BACKUP_PGDATABASE" && safe_identifier "$APOLLO_BACKUP_PGUSER" && safe_release_id "$APOLLO_BACKUP_RELEASE_ID" && valid_stack_database "$APOLLO_BACKUP_STACK" "$APOLLO_BACKUP_PGDATABASE" && [ -d "$APOLLO_BACKUP_DESTINATION" ] && [ -w "$APOLLO_BACKUP_DESTINATION" ] || exit 1
case "$APOLLO_BACKUP_AGE_RECIPIENT" in age1[0-9a-z]* ) ;; * ) exit 1 ;; esac
command -v pg_dump >/dev/null 2>&1 && command -v age >/dev/null 2>&1 && command -v sha256sum >/dev/null 2>&1 || exit 1

prefix="$APOLLO_BACKUP_DESTINATION/$APOLLO_BACKUP_RELEASE_ID"
final_dump="$prefix.dump.age"
final_checksum="$prefix.sha256"
final_metadata="$prefix.json"
[ ! -e "$final_dump" ] && [ ! -e "$final_checksum" ] && [ ! -e "$final_metadata" ] || exit 1

stage=prepare
temporary_directory=$(mktemp -d "$APOLLO_BACKUP_DESTINATION/.apollo-backup.XXXXXX" 2>/dev/null) || exit 1
temporary_dump="$temporary_directory/backup.dump.age"
temporary_hash="$temporary_directory/backup.hash"
temporary_checksum="$temporary_directory/backup.sha256"
temporary_metadata="$temporary_directory/backup.json"
dump_status="$temporary_directory/pg_dump.status"
tool_errors="$temporary_directory/tool-errors"

stage=encrypt
set +e
(
  pg_dump --format=custom --no-owner --no-privileges -h "$APOLLO_BACKUP_PGHOST" -p "$APOLLO_BACKUP_PGPORT" -U "$APOLLO_BACKUP_PGUSER" "$APOLLO_BACKUP_PGDATABASE" 2>"$tool_errors"
  result=$?
  printf '%s\n' "$result" > "$dump_status"
  exit "$result"
) | age -r "$APOLLO_BACKUP_AGE_RECIPIENT" 2>>"$tool_errors" > "$temporary_dump"
age_result=$?
set -e
[ "$age_result" -eq 0 ] || exit 1
IFS= read -r dump_result < "$dump_status" || { stage=dump; exit 1; }
[ "$dump_result" = 0 ] || { stage=dump; exit 1; }

stage=checksum
sha256sum "$temporary_dump" > "$temporary_hash" 2>>"$tool_errors" || exit 1
IFS=' ' read -r checksum _ignored < "$temporary_hash" || exit 1
checksum=${checksum%"$(printf '\r')"}
case "$checksum" in \\*) checksum=${checksum#\\} ;; esac
[ -n "$checksum" ] || exit 1
printf '%s\n' "$checksum" > "$temporary_checksum"

stage=metadata
printf '{"format_version":1,"stack":"%s","database":"%s","release_id":"%s","encrypted_sha256":"%s"}\n' "$APOLLO_BACKUP_STACK" "$APOLLO_BACKUP_PGDATABASE" "$APOLLO_BACKUP_RELEASE_ID" "$checksum" > "$temporary_metadata"
chmod 600 "$temporary_dump" "$temporary_checksum" "$temporary_metadata" >/dev/null 2>&1 || exit 1

stage=commit
mv "$temporary_dump" "$final_dump" >/dev/null 2>&1 || exit 1
mv "$temporary_checksum" "$final_checksum" >/dev/null 2>&1 || exit 1
mv "$temporary_metadata" "$final_metadata" >/dev/null 2>&1 || exit 1
chmod 600 "$final_dump" "$final_checksum" "$final_metadata" >/dev/null 2>&1 || exit 1
completed=1
printf 'backup: complete\n'
