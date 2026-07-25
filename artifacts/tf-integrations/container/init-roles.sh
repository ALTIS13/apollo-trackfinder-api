#!/bin/sh
set -eu

read_secret() {
  path=$1
  minimum=$2
  maximum=$3
  if [ ! -r "$path" ]; then
    exit 1
  fi
  size=$(wc -c < "$path")
  if [ "$size" -lt "$minimum" ] || [ "$size" -gt "$maximum" ]; then
    exit 1
  fi
  value=$(cat "$path")
  if [ -z "$value" ]; then
    exit 1
  fi
  printf '%s' "$value"
}

export TF_INTEGRATIONS_MIGRATOR_PASSWORD
export TF_INTEGRATIONS_RUNTIME_PASSWORD
TF_INTEGRATIONS_MIGRATOR_PASSWORD=$(
  read_secret /run/secrets/tf_integrations_migrator_password 1 512
)
TF_INTEGRATIONS_RUNTIME_PASSWORD=$(
  read_secret /run/secrets/tf_integrations_runtime_password 1 512
)

export PGCONNECT_TIMEOUT=10
export PGOPTIONS="-c statement_timeout=30000 -c lock_timeout=5000"

psql -X -q \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 \
  --set database_name="$POSTGRES_DB" <<'SQL'
\getenv migrator_password TF_INTEGRATIONS_MIGRATOR_PASSWORD
\getenv runtime_password TF_INTEGRATIONS_RUNTIME_PASSWORD

select format(
  'create role apollo_tf_integrations_migrator login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
  :'migrator_password'
)
where not exists (
  select 1
  from pg_roles
  where rolname = 'apollo_tf_integrations_migrator'
) \gexec

select format(
  'alter role apollo_tf_integrations_migrator login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
  :'migrator_password'
) \gexec

select format(
  'create role apollo_tf_integrations_runtime login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
  :'runtime_password'
)
where not exists (
  select 1
  from pg_roles
  where rolname = 'apollo_tf_integrations_runtime'
) \gexec

select format(
  'alter role apollo_tf_integrations_runtime login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
  :'runtime_password'
) \gexec

select format('revoke all on database %I from public', :'database_name') \gexec
select format(
  'grant connect, create on database %I to apollo_tf_integrations_migrator',
  :'database_name'
) \gexec
select format(
  'grant connect on database %I to apollo_tf_integrations_runtime',
  :'database_name'
) \gexec

revoke create on schema public from public;
alter default privileges for role apollo_tf_integrations_migrator
  revoke execute on functions from public;
SQL

unset TF_INTEGRATIONS_MIGRATOR_PASSWORD
unset TF_INTEGRATIONS_RUNTIME_PASSWORD
unset PGCONNECT_TIMEOUT PGOPTIONS
unset path minimum maximum size value
