#!/bin/sh
set -eu
umask 077

stage=input
temporary_directory=
final_dump=
final_checksum=
final_metadata=
claim_directory=
claim_owned=0
owned_dump=
owned_checksum=
owned_metadata=
completed=0

write_claim_state() {
  state_temporary="$claim_directory/state.json.tmp"
  case "$1" in
    active)
      printf '{"format_version":1,"release_id":"%s","state":"active"}\n' \
        "$APOLLO_BACKUP_RELEASE_ID" > "$state_temporary" || return 1
      ;;
    complete)
      printf '{"format_version":1,"release_id":"%s","state":"complete"}\n' \
        "$APOLLO_BACKUP_RELEASE_ID" > "$state_temporary" || return 1
      ;;
    quarantined)
      printf '{"format_version":1,"release_id":"%s","state":"quarantined","failed_stage":"%s"}\n' \
        "$APOLLO_BACKUP_RELEASE_ID" "$stage" > "$state_temporary" || return 1
      ;;
    *)
      return 1
      ;;
  esac
  chmod 600 "$state_temporary" >/dev/null 2>&1 || return 1
  mv "$state_temporary" "$claim_directory/state.json" >/dev/null 2>&1 ||
    return 1
}

cleanup() {
  result=$?
  if [ "$completed" -ne 1 ]; then
    if [ -n "$owned_dump" ] && [ "$owned_dump" -ef "$final_dump" ]; then
      rm -f "$final_dump" >/dev/null 2>&1 || :
    fi
    if [ -n "$owned_checksum" ] &&
      [ "$owned_checksum" -ef "$final_checksum" ]; then
      rm -f "$final_checksum" >/dev/null 2>&1 || :
    fi
    if [ -n "$owned_metadata" ] &&
      [ "$owned_metadata" -ef "$final_metadata" ]; then
      rm -f "$final_metadata" >/dev/null 2>&1 || :
    fi
    if [ "$claim_owned" -eq 1 ]; then
      write_claim_state quarantined >/dev/null 2>&1 || :
    fi
  fi
  if [ -n "$temporary_directory" ]; then
    rm -rf "$temporary_directory" >/dev/null 2>&1 || :
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

server_major() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 100000 ] || return 1
  server_version_value=$1
  parsed_server_major=$((server_version_value / 10000))
}

if [ "$#" -ne 0 ] || ! require_value PGPASSFILE || ! require_value APOLLO_BACKUP_PGHOST || ! require_value APOLLO_BACKUP_PGPORT || ! require_value APOLLO_BACKUP_PGDATABASE || ! require_value APOLLO_BACKUP_PGUSER || ! require_value APOLLO_BACKUP_STACK || ! require_value APOLLO_BACKUP_RELEASE_ID || ! require_value APOLLO_BACKUP_DESTINATION || ! require_value APOLLO_BACKUP_AGE_RECIPIENT; then
  exit 1
fi

[ -r "$PGPASSFILE" ] && safe_host "$APOLLO_BACKUP_PGHOST" && safe_port "$APOLLO_BACKUP_PGPORT" && safe_identifier "$APOLLO_BACKUP_PGDATABASE" && safe_identifier "$APOLLO_BACKUP_PGUSER" && safe_release_id "$APOLLO_BACKUP_RELEASE_ID" && valid_stack_database "$APOLLO_BACKUP_STACK" "$APOLLO_BACKUP_PGDATABASE" && [ -d "$APOLLO_BACKUP_DESTINATION" ] && [ -w "$APOLLO_BACKUP_DESTINATION" ] || exit 1
case "$APOLLO_BACKUP_AGE_RECIPIENT" in age1[0-9a-z]* ) ;; * ) exit 1 ;; esac
command -v pg_dump >/dev/null 2>&1 && command -v psql >/dev/null 2>&1 && command -v age >/dev/null 2>&1 && command -v sha256sum >/dev/null 2>&1 && command -v ln >/dev/null 2>&1 || exit 1

prefix="$APOLLO_BACKUP_DESTINATION/$APOLLO_BACKUP_RELEASE_ID"
final_dump="$prefix.dump.age"
final_checksum="$prefix.sha256"
final_metadata="$prefix.json"
claim_directory="$APOLLO_BACKUP_DESTINATION/.$APOLLO_BACKUP_RELEASE_ID.apollo-backup-claim"
owned_dump="$claim_directory/owned.dump.age"
owned_checksum="$claim_directory/owned.sha256"
owned_metadata="$claim_directory/owned.json"

stage=claim
mkdir "$claim_directory" 2>/dev/null || exit 1
claim_owned=1
chmod 700 "$claim_directory" >/dev/null 2>&1 || exit 1
write_claim_state active >/dev/null 2>&1 || exit 1
[ ! -e "$final_dump" ] && [ ! -e "$final_checksum" ] && [ ! -e "$final_metadata" ] || exit 1

stage=version
expected_postgres_major "$APOLLO_BACKUP_STACK" "$APOLLO_BACKUP_PGDATABASE" ||
  exit 1
client_version=$(pg_dump --version 2>/dev/null) || exit 1
case "$client_version" in
  "pg_dump (PostgreSQL) $expected_major."*) ;;
  *) exit 1 ;;
esac
server_version_num=$(
  psql -h "$APOLLO_BACKUP_PGHOST" -p "$APOLLO_BACKUP_PGPORT" \
    -U "$APOLLO_BACKUP_PGUSER" -d "$APOLLO_BACKUP_PGDATABASE" \
    -Atqc "SHOW server_version_num" 2>/dev/null
) || exit 1
server_major "$server_version_num" || exit 1
[ "$parsed_server_major" -eq "$expected_major" ] || exit 1

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
printf '{"format_version":2,"stack":"%s","database":"%s","release_id":"%s","postgres_client_major":%s,"postgres_server_major":%s,"encrypted_sha256":"%s"}\n' "$APOLLO_BACKUP_STACK" "$APOLLO_BACKUP_PGDATABASE" "$APOLLO_BACKUP_RELEASE_ID" "$expected_major" "$parsed_server_major" "$checksum" > "$temporary_metadata"
chmod 600 "$temporary_dump" "$temporary_checksum" "$temporary_metadata" >/dev/null 2>&1 || exit 1

stage=commit
ln "$temporary_dump" "$owned_dump" >/dev/null 2>&1 || exit 1
ln "$owned_dump" "$final_dump" >/dev/null 2>&1 || exit 1
ln "$temporary_checksum" "$owned_checksum" >/dev/null 2>&1 || exit 1
ln "$owned_checksum" "$final_checksum" >/dev/null 2>&1 || exit 1
ln "$temporary_metadata" "$owned_metadata" >/dev/null 2>&1 || exit 1
ln "$owned_metadata" "$final_metadata" >/dev/null 2>&1 || exit 1
chmod 600 "$final_dump" "$final_checksum" "$final_metadata" >/dev/null 2>&1 || exit 1
write_claim_state complete >/dev/null 2>&1 || exit 1
completed=1
printf 'backup: complete\n'
