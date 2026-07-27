#!/bin/sh
set -eu

fail() {
  printf '%s\n' "TF role bootstrap failed" >&2
  exit 1
}

read_secret() {
  path=$1
  maximum=$2
  secret_value=$(
    /usr/local/bin/read-bounded-secret \
      --append-sentinel \
      "$path" \
      "$maximum" 2>/dev/null
  ) || fail
  case "$secret_value" in
    *"$secret_sentinel")
      ;;
    *)
      fail
      ;;
  esac
  secret_value=${secret_value%"$secret_sentinel"}
}

export LC_ALL=C
secret_sentinel=$(printf '\036')

export APOLLO_TF_MIGRATOR_PASSWORD
export APOLLO_TF_RUNTIME_PASSWORD
read_secret /run/secrets/tf_migrator_password 512
APOLLO_TF_MIGRATOR_PASSWORD=$secret_value
read_secret /run/secrets/tf_runtime_password 512
APOLLO_TF_RUNTIME_PASSWORD=$secret_value
unset secret_value

export PGCONNECT_TIMEOUT=10
export PGOPTIONS="-c statement_timeout=30000 -c lock_timeout=5000"

run_bootstrap() {
  psql -X -q "$@" --set ON_ERROR_STOP=1 <<'SQL'
\getenv migrator_password APOLLO_TF_MIGRATOR_PASSWORD
\getenv runtime_password APOLLO_TF_RUNTIME_PASSWORD

begin;

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

do $ownership$
declare
  migrator_oid oid := (
    select oid from pg_roles where rolname = 'apollo_tf_migrator'
  );
  runtime_oid oid := (
    select oid from pg_roles where rolname = 'apollo_tf_runtime'
  );
begin
  if exists (
    select 1
    from pg_shdepend dependencies
    where dependencies.refclassid = 'pg_authid'::regclass
      and dependencies.refobjid = runtime_oid
      and dependencies.deptype = 'o'
      and dependencies.classid <> 'pg_default_acl'::regclass
  ) then
    raise exception 'managed_role_owns_unexpected_object';
  end if;

  if exists (
    select 1
    from pg_shdepend dependencies
    where dependencies.refclassid = 'pg_authid'::regclass
      and dependencies.refobjid = migrator_oid
      and dependencies.deptype = 'o'
      and not (
        dependencies.dbid = (
          select oid from pg_database where datname = current_database()
        )
        and dependencies.classid = 'pg_default_acl'::regclass
        and dependencies.objid in (
          select defaults.oid
          from pg_default_acl defaults
          where defaults.defaclrole = migrator_oid
        )
      )
      and not (
        dependencies.dbid = (
          select oid from pg_database where datname = current_database()
        )
        and dependencies.classid = 'pg_namespace'::regclass
        and dependencies.objid = (
          select oid from pg_namespace where nspname = 'apollo_tf'
        )
      )
      and not (
        dependencies.dbid = (
          select oid from pg_database where datname = current_database()
        )
        and dependencies.classid = 'pg_class'::regclass
        and dependencies.objid in (
          select relations.oid
          from pg_class relations
          join pg_namespace schemas on schemas.oid = relations.relnamespace
          where (
            schemas.nspname = 'public'
            and (
              relations.relname in (
                'track_search_cache',
                'track_search_cache_id_seq',
                'play_history',
                'play_history_id_seq',
                'liked_tracks',
                'liked_tracks_id_seq',
                'playlists',
                'playlists_id_seq',
                'playlist_tracks',
                'playlist_tracks_id_seq'
              )
              or (
                relations.relkind = 'i'
                and relations.oid in (
                  select indexes.indexrelid
                  from pg_index indexes
                  join pg_class tables on tables.oid = indexes.indrelid
                  join pg_namespace table_schemas
                    on table_schemas.oid = tables.relnamespace
                  where table_schemas.nspname = 'public'
                    and tables.relname in (
                      'track_search_cache',
                      'play_history',
                      'liked_tracks',
                      'playlists',
                      'playlist_tracks'
                    )
                )
              )
            )
          )
          or (
            schemas.nspname = 'apollo_tf'
            and relations.relname in (
              'schema_migrations',
              'schema_migrations_pkey'
            )
          )
        )
      )
      and not (
        dependencies.dbid = (
          select oid from pg_database where datname = current_database()
        )
        and dependencies.classid = 'pg_type'::regclass
        and dependencies.objid in (
          select types.oid
          from pg_type types
          where types.typrelid in (
            select relations.oid
            from pg_class relations
            join pg_namespace schemas on schemas.oid = relations.relnamespace
            where (
              schemas.nspname = 'public'
              and relations.relname in (
                'track_search_cache',
                'play_history',
                'liked_tracks',
                'playlists',
                'playlist_tracks'
              )
            )
            or (
              schemas.nspname = 'apollo_tf'
              and relations.relname = 'schema_migrations'
            )
          )
          or types.typelem in (
            select relations.reltype
            from pg_class relations
            join pg_namespace schemas on schemas.oid = relations.relnamespace
            where (
              schemas.nspname = 'public'
              and relations.relname in (
                'track_search_cache',
                'play_history',
                'liked_tracks',
                'playlists',
                'playlist_tracks'
              )
            )
            or (
              schemas.nspname = 'apollo_tf'
              and relations.relname = 'schema_migrations'
            )
          )
        )
      )
  ) then
    raise exception 'managed_role_owns_unexpected_object';
  end if;
end
$ownership$;

select format(
  'revoke %I from %I',
  granted_roles.rolname,
  member_roles.rolname
)
from pg_auth_members memberships
join pg_roles granted_roles on granted_roles.oid = memberships.roleid
join pg_roles member_roles on member_roles.oid = memberships.member
where granted_roles.rolname in (
  'apollo_tf_migrator',
  'apollo_tf_runtime'
)
or member_roles.rolname in (
  'apollo_tf_migrator',
  'apollo_tf_runtime'
)
group by granted_roles.rolname, member_roles.rolname
\gexec

alter role apollo_tf_migrator reset all;
alter role apollo_tf_runtime reset all;

select format(
  'revoke all on database %I from public',
  current_database()
) \gexec
select format(
  'revoke all privileges on database %I from apollo_tf_migrator',
  current_database()
) \gexec
select format(
  'revoke all privileges on database %I from apollo_tf_runtime',
  current_database()
) \gexec

select format(
  'revoke all privileges on schema %I from apollo_tf_migrator, apollo_tf_runtime',
  schemas.nspname
)
from pg_namespace schemas
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
\gexec

select format(
  'revoke all privileges on all tables in schema %I from apollo_tf_migrator, apollo_tf_runtime',
  schemas.nspname
)
from pg_namespace schemas
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
\gexec

select format(
  'revoke all privileges on all sequences in schema %I from apollo_tf_migrator, apollo_tf_runtime',
  schemas.nspname
)
from pg_namespace schemas
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
\gexec

select format(
  'revoke all privileges on all functions in schema %I from apollo_tf_migrator, apollo_tf_runtime',
  schemas.nspname
)
from pg_namespace schemas
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
\gexec

select format(
  'revoke all privileges on all procedures in schema %I from apollo_tf_migrator, apollo_tf_runtime',
  schemas.nspname
)
from pg_namespace schemas
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
\gexec

select format(
  'revoke all privileges on type %I.%I from apollo_tf_migrator, apollo_tf_runtime',
  schemas.nspname,
  types.typname
)
from pg_type types
join pg_namespace schemas on schemas.oid = types.typnamespace
left join pg_class relations on relations.oid = types.typrelid
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
  and (
    types.typtype in ('d', 'e', 'r', 'm')
    or (
      types.typtype = 'c'
      and relations.relkind = 'c'
    )
  )
\gexec

select format(
  'alter default privileges for role %I%s revoke all privileges on %s from %I',
  owners.rolname,
  case
    when schemas.nspname is null then ''
    else format(' in schema %I', schemas.nspname)
  end,
  case defaults.defaclobjtype
    when 'r' then 'tables'
    when 'S' then 'sequences'
    when 'f' then 'functions'
    when 'T' then 'types'
    when 'n' then 'schemas'
  end,
  coalesce(grantees.rolname, 'public')
)
from pg_default_acl defaults
join pg_roles owners on owners.oid = defaults.defaclrole
left join pg_namespace schemas on schemas.oid = defaults.defaclnamespace
cross join lateral aclexplode(defaults.defaclacl) acl
left join pg_roles grantees on grantees.oid = acl.grantee
where (
  grantees.rolname in (
    'apollo_tf_migrator',
    'apollo_tf_runtime'
  )
  or owners.rolname in (
    'apollo_tf_migrator',
    'apollo_tf_runtime'
  )
)
  and defaults.defaclobjtype in ('r', 'S', 'f', 'T', 'n')
group by
  owners.rolname,
  schemas.nspname,
  defaults.defaclobjtype,
  coalesce(grantees.rolname, 'public')
\gexec

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

select format(
  'grant select, insert, update, delete on table %I.%I to apollo_tf_runtime',
  schemas.nspname,
  relations.relname
)
from pg_class relations
join pg_namespace schemas on schemas.oid = relations.relnamespace
where schemas.nspname = 'public'
  and relations.relkind in ('r', 'p')
  and relations.relname in (
    'track_search_cache',
    'play_history',
    'liked_tracks',
    'playlists',
    'playlist_tracks'
  )
\gexec

select format(
  'grant usage on sequence %I.%I to apollo_tf_runtime',
  schemas.nspname,
  relations.relname
)
from pg_class relations
join pg_namespace schemas on schemas.oid = relations.relnamespace
where schemas.nspname = 'public'
  and relations.relkind = 'S'
  and relations.relname in (
    'track_search_cache_id_seq',
    'play_history_id_seq',
    'liked_tracks_id_seq',
    'playlists_id_seq',
    'playlist_tracks_id_seq'
  )
\gexec

select 'grant usage on schema apollo_tf to apollo_tf_runtime'
where exists (
  select 1 from pg_namespace where nspname = 'apollo_tf'
)
\gexec

select 'grant select on table apollo_tf.schema_migrations to apollo_tf_runtime'
where to_regclass('apollo_tf.schema_migrations') is not null
\gexec

alter default privileges for role apollo_tf_migrator
  revoke execute on functions from public;

commit;
SQL
}

if [ -n "${TF_ROLE_BOOTSTRAP_DATABASE_URL_FILE:-}" ]; then
  read_secret "$TF_ROLE_BOOTSTRAP_DATABASE_URL_FILE" 4096
  admin_url=$secret_value
  unset secret_value
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
unset PGCONNECT_TIMEOUT PGOPTIONS LC_ALL
unset path maximum secret_sentinel
