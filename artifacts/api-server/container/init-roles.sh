#!/bin/sh
set -eu

fail() {
  printf '%s\n' "TF role bootstrap failed" >&2
  exit 1
}

read_secret() {
  path=$1
  maximum=$2
  [ -f "$path" ] && [ -r "$path" ] || fail

  size=$(wc -c < "$path" 2>/dev/null) || fail
  case "$size" in
    ''|*[!0-9]*)
      fail
      ;;
  esac
  [ "$size" -ge 1 ] && [ "$size" -le "$maximum" ] || fail

  value=$(cat "$path" 2>/dev/null) || fail
  loaded_size=$(printf '%s' "$value" | wc -c) || fail
  [ "$loaded_size" -eq "$size" ] || fail
  printf '%s' "$value"
}

export APOLLO_TF_MIGRATOR_PASSWORD
export APOLLO_TF_RUNTIME_PASSWORD
APOLLO_TF_MIGRATOR_PASSWORD=$(
  read_secret /run/secrets/tf_migrator_password 512
)
APOLLO_TF_RUNTIME_PASSWORD=$(
  read_secret /run/secrets/tf_runtime_password 512
)

export PGCONNECT_TIMEOUT=10
export PGOPTIONS="-c statement_timeout=30000 -c lock_timeout=5000"

run_bootstrap() {
  psql -X -q "$@" --set ON_ERROR_STOP=1 <<'SQL'
\getenv migrator_password APOLLO_TF_MIGRATOR_PASSWORD
\getenv runtime_password APOLLO_TF_RUNTIME_PASSWORD

select format(
  'create role apollo_tf_migrator login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
  :'migrator_password'
)
where not exists (
  select 1 from pg_roles where rolname = 'apollo_tf_migrator'
) \gexec

select format(
  'alter role apollo_tf_migrator login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
  :'migrator_password'
) \gexec

select format(
  'create role apollo_tf_runtime login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
  :'runtime_password'
)
where not exists (
  select 1 from pg_roles where rolname = 'apollo_tf_runtime'
) \gexec

select format(
  'alter role apollo_tf_runtime login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
  :'runtime_password'
) \gexec

select format(
  'revoke all on database %I from public',
  current_database()
) \gexec
select format(
  'grant connect, create on database %I to apollo_tf_migrator',
  current_database()
) \gexec
select format(
  'grant connect on database %I to apollo_tf_runtime',
  current_database()
) \gexec

revoke create on schema public from public;
grant usage, create on schema public to apollo_tf_migrator;
grant usage on schema public to apollo_tf_runtime;
SQL
}

if [ -n "${TF_ROLE_BOOTSTRAP_DATABASE_URL_FILE:-}" ]; then
  admin_url=$(read_secret "$TF_ROLE_BOOTSTRAP_DATABASE_URL_FILE" 4096)
  if ! run_bootstrap "$admin_url" >/dev/null 2>&1; then
    fail
  fi
  unset admin_url
else
  [ -n "${POSTGRES_USER:-}" ] && [ -n "${POSTGRES_DB:-}" ] || fail
  if ! run_bootstrap \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" >/dev/null 2>&1; then
    fail
  fi
fi

unset APOLLO_TF_MIGRATOR_PASSWORD APOLLO_TF_RUNTIME_PASSWORD
unset PGCONNECT_TIMEOUT PGOPTIONS
unset path maximum size value loaded_size
