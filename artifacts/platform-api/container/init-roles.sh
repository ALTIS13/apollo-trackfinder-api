#!/bin/sh
set -eu

read_secret() {
  value=$(cat "$1")
  if [ -z "$value" ]; then
    echo "Required PostgreSQL role secret is empty" >&2
    exit 1
  fi
  printf '%s' "$value"
}

export PLATFORM_MIGRATOR_PASSWORD
export PLATFORM_RUNTIME_PASSWORD
PLATFORM_MIGRATOR_PASSWORD=$(
  read_secret /run/secrets/platform_migrator_password
)
PLATFORM_RUNTIME_PASSWORD=$(
  read_secret /run/secrets/platform_runtime_password
)

psql -X -q \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 \
  --set database_name="$POSTGRES_DB" <<'SQL'
\getenv migrator_password PLATFORM_MIGRATOR_PASSWORD
\getenv runtime_password PLATFORM_RUNTIME_PASSWORD

select format(
  'create role apollo_platform_migrator login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
  :'migrator_password'
)
where not exists (
  select 1 from pg_roles where rolname = 'apollo_platform_migrator'
) \gexec

select format(
  'alter role apollo_platform_migrator login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
  :'migrator_password'
) \gexec

select format(
  'create role apollo_platform_runtime login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
  :'runtime_password'
)
where not exists (
  select 1 from pg_roles where rolname = 'apollo_platform_runtime'
) \gexec

select format(
  'alter role apollo_platform_runtime login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
  :'runtime_password'
) \gexec

select format('revoke all on database %I from public', :'database_name') \gexec
select format(
  'grant connect, create on database %I to apollo_platform_migrator',
  :'database_name'
) \gexec
select format(
  'grant connect on database %I to apollo_platform_runtime',
  :'database_name'
) \gexec

revoke create on schema public from public;
alter default privileges for role apollo_platform_migrator
  revoke execute on functions from public;
SQL

unset PLATFORM_MIGRATOR_PASSWORD PLATFORM_RUNTIME_PASSWORD value
