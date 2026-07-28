#!/bin/sh
set -eu
umask 077

stage=input
temporary_directory=

cleanup() {
  result=$?
  if [ -n "$temporary_directory" ]; then
    rm -rf "$temporary_directory" >/dev/null 2>&1 || :
  fi
  if [ "$result" -ne 0 ]; then
    printf 'restore: %s failed\n' "$stage" >&2
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

if [ "$#" -ne 0 ] || ! require_value PGPASSFILE || ! require_value APOLLO_RESTORE_BACKUP || ! require_value APOLLO_RESTORE_CHECKSUM || ! require_value APOLLO_RESTORE_METADATA || ! require_value APOLLO_RESTORE_AGE_IDENTITY || ! require_value APOLLO_RESTORE_PGHOST || ! require_value APOLLO_RESTORE_PGPORT || ! require_value APOLLO_RESTORE_PGDATABASE || ! require_value APOLLO_RESTORE_PGUSER || ! require_value APOLLO_RESTORE_EXPECTED_STACK || ! require_value APOLLO_RESTORE_EXPECTED_DATABASE || ! require_value APOLLO_RESTORE_EXPECTED_RELEASE_ID || ! require_value APOLLO_RESTORE_DISPOSABLE; then
  exit 1
fi

[ "$APOLLO_RESTORE_DISPOSABLE" = 1 ] && [ -r "$PGPASSFILE" ] && [ -r "$APOLLO_RESTORE_BACKUP" ] && [ -r "$APOLLO_RESTORE_CHECKSUM" ] && [ -r "$APOLLO_RESTORE_METADATA" ] && [ -r "$APOLLO_RESTORE_AGE_IDENTITY" ] && safe_host "$APOLLO_RESTORE_PGHOST" && safe_port "$APOLLO_RESTORE_PGPORT" && safe_identifier "$APOLLO_RESTORE_PGDATABASE" && safe_identifier "$APOLLO_RESTORE_PGUSER" && safe_identifier "$APOLLO_RESTORE_EXPECTED_DATABASE" && safe_release_id "$APOLLO_RESTORE_EXPECTED_RELEASE_ID" && valid_stack_database "$APOLLO_RESTORE_EXPECTED_STACK" "$APOLLO_RESTORE_EXPECTED_DATABASE" && [ "$APOLLO_RESTORE_PGDATABASE" = "$APOLLO_RESTORE_EXPECTED_DATABASE" ] || exit 1
command -v age >/dev/null 2>&1 && command -v psql >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1 || exit 1

stage=verify
case "$0" in */*) script_directory=${0%/*} ;; *) script_directory=. ;; esac
if ! APOLLO_BACKUP_FILE="$APOLLO_RESTORE_BACKUP" APOLLO_BACKUP_CHECKSUM_FILE="$APOLLO_RESTORE_CHECKSUM" APOLLO_BACKUP_METADATA_FILE="$APOLLO_RESTORE_METADATA" APOLLO_BACKUP_EXPECTED_STACK="$APOLLO_RESTORE_EXPECTED_STACK" APOLLO_BACKUP_EXPECTED_DATABASE="$APOLLO_RESTORE_EXPECTED_DATABASE" APOLLO_BACKUP_EXPECTED_RELEASE_ID="$APOLLO_RESTORE_EXPECTED_RELEASE_ID" "$script_directory/verify-backup.sh" >/dev/null 2>&1; then
  exit 1
fi

stage=target-check
existing=$(psql -h "$APOLLO_RESTORE_PGHOST" -p "$APOLLO_RESTORE_PGPORT" -U "$APOLLO_RESTORE_PGUSER" -d "$APOLLO_RESTORE_PGDATABASE" -Atqc "SELECT 1 FROM (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'public') UNION ALL SELECT 1 FROM pg_class JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace WHERE pg_namespace.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND pg_class.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') UNION ALL SELECT 1 FROM pg_views WHERE schemaname NOT IN ('pg_catalog', 'information_schema') UNION ALL SELECT 1 FROM pg_sequences WHERE schemaname NOT IN ('pg_catalog', 'information_schema') UNION ALL SELECT 1 FROM pg_type JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace WHERE pg_namespace.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND pg_type.typtype IN ('b', 'c', 'd', 'e', 'r') UNION ALL SELECT 1 FROM pg_proc JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace WHERE pg_namespace.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') UNION ALL SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql') AS user_objects LIMIT 1" 2>/dev/null) || exit 1
[ -z "$existing" ] || exit 1

stage=prepare
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/apollo-restore.XXXXXX" 2>/dev/null) || exit 1
decrypt_status="$temporary_directory/decrypt.status"

stage=restore
set +e
(
  age -d -i "$APOLLO_RESTORE_AGE_IDENTITY" < "$APOLLO_RESTORE_BACKUP" 2>/dev/null
  result=$?
  printf '%s\n' "$result" > "$decrypt_status"
  exit "$result"
) | pg_restore --exit-on-error --no-owner --no-privileges -h "$APOLLO_RESTORE_PGHOST" -p "$APOLLO_RESTORE_PGPORT" -U "$APOLLO_RESTORE_PGUSER" -d "$APOLLO_RESTORE_PGDATABASE" 2>/dev/null
restore_result=$?
set -e
[ "$restore_result" -eq 0 ] || exit 1
IFS= read -r decrypt_result < "$decrypt_status" || { stage=decrypt; exit 1; }
[ "$decrypt_result" = 0 ] || { stage=decrypt; exit 1; }
printf 'restore: complete\n'
