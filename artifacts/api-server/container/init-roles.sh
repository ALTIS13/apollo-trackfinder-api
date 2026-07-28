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
  'create role apollo_tf_migrator login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit -1 valid until ''infinity''',
  :'migrator_password'
)
where not exists (
  select 1 from pg_roles where rolname = 'apollo_tf_migrator'
) \gexec

select format(
  'alter role apollo_tf_migrator login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit -1 valid until ''infinity''',
  :'migrator_password'
) \gexec

select format(
  'create role apollo_tf_runtime login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit -1 valid until ''infinity''',
  :'runtime_password'
)
where not exists (
  select 1 from pg_roles where rolname = 'apollo_tf_runtime'
) \gexec

select format(
  'alter role apollo_tf_runtime login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit -1 valid until ''infinity''',
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
      and not (
        dependencies.dbid = (
          select oid from pg_database where datname = current_database()
        )
        and dependencies.classid = 'pg_default_acl'::regclass
        and dependencies.objid in (
          select defaults.oid
          from pg_default_acl defaults
          where defaults.defaclrole = runtime_oid
        )
      )
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
  'revoke %I from %I cascade',
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
  'alter role %I in database %I reset all',
  roles.rolname,
  databases.datname
)
from pg_db_role_setting settings
join pg_roles roles on roles.oid = settings.setrole
join pg_database databases on databases.oid = settings.setdatabase
where settings.setdatabase <> 0
  and roles.rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
order by roles.rolname, databases.datname
\gexec

select format(
  'revoke all privileges on database %I from public, apollo_tf_migrator, apollo_tf_runtime cascade',
  databases.datname
)
from pg_database databases
\gexec

select format(
  'revoke all privileges on tablespace %I from apollo_tf_migrator, apollo_tf_runtime cascade',
  tablespaces.spcname
)
from pg_tablespace tablespaces
where exists (
  select 1
  from aclexplode(tablespaces.spcacl) acl
  where acl.grantee in (
    select oid
    from pg_roles
    where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
  )
)
\gexec

select format(
  'revoke all privileges on schema %I from apollo_tf_migrator, apollo_tf_runtime cascade',
  schemas.nspname
)
from pg_namespace schemas
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
  and not exists (
    select 1
    from pg_depend dependencies
    where dependencies.classid = 'pg_namespace'::regclass
      and dependencies.objid = schemas.oid
      and dependencies.objsubid = 0
      and dependencies.refclassid = 'pg_extension'::regclass
      and dependencies.deptype = 'e'
  )
  and exists (
  select 1
  from aclexplode(schemas.nspacl) acl
  where acl.grantee in (
    select oid
    from pg_roles
    where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
  )
)
\gexec

select format(
  'revoke all privileges on schema %I from public cascade',
  schemas.nspname
)
from pg_namespace schemas
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
  and not exists (
    select 1
    from pg_depend dependencies
    where dependencies.classid = 'pg_namespace'::regclass
      and dependencies.objid = schemas.oid
      and dependencies.objsubid = 0
      and dependencies.refclassid = 'pg_extension'::regclass
      and dependencies.deptype = 'e'
  )
  and (
    has_schema_privilege('public', schemas.oid, 'USAGE')
    or has_schema_privilege('public', schemas.oid, 'CREATE')
  )
\gexec

select format(
  'revoke all privileges on %s %I.%I from apollo_tf_migrator, apollo_tf_runtime cascade',
  case
    when relations.relkind = 'S' then 'sequence'
    else 'table'
  end,
  schemas.nspname,
  relations.relname
)
from pg_class relations
join pg_namespace schemas on schemas.oid = relations.relnamespace
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
  and not exists (
    select 1
    from pg_depend dependencies
    where dependencies.classid = 'pg_class'::regclass
      and dependencies.objid = relations.oid
      and dependencies.objsubid = 0
      and dependencies.refclassid = 'pg_extension'::regclass
      and dependencies.deptype = 'e'
  )
  and exists (
  select 1
  from aclexplode(relations.relacl) acl
  where acl.grantee in (
    select oid
    from pg_roles
    where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
  )
)
\gexec

select format(
  'revoke all privileges on %s %I.%I from public cascade',
  case
    when relations.relkind = 'S' then 'sequence'
    else 'table'
  end,
  schemas.nspname,
  relations.relname
)
from pg_class relations
join pg_namespace schemas on schemas.oid = relations.relnamespace
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
  and relations.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  and not exists (
    select 1
    from pg_depend dependencies
    where dependencies.classid = 'pg_class'::regclass
      and dependencies.objid = relations.oid
      and dependencies.objsubid = 0
      and dependencies.refclassid = 'pg_extension'::regclass
      and dependencies.deptype = 'e'
  )
  and (
    (
      relations.relkind = 'S'
      and has_sequence_privilege(
        'public',
        relations.oid,
        'USAGE,SELECT,UPDATE'
      )
    )
    or (
      relations.relkind <> 'S'
      and has_table_privilege(
        'public',
        relations.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
    )
  )
\gexec

select format(
  'revoke all privileges (%I) on table %I.%I from apollo_tf_migrator, apollo_tf_runtime cascade',
  attributes.attname,
  schemas.nspname,
  relations.relname
)
from pg_attribute attributes
join pg_class relations on relations.oid = attributes.attrelid
join pg_namespace schemas on schemas.oid = relations.relnamespace
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
  and not exists (
    select 1
    from pg_depend dependencies
    where dependencies.classid = 'pg_class'::regclass
      and dependencies.objid = relations.oid
      and dependencies.objsubid = 0
      and dependencies.refclassid = 'pg_extension'::regclass
      and dependencies.deptype = 'e'
  )
  and exists (
  select 1
  from aclexplode(attributes.attacl) acl
  where acl.grantee in (
    select oid
    from pg_roles
    where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
  )
)
\gexec

select format(
  'revoke all privileges (%I) on table %I.%I from public cascade',
  attributes.attname,
  schemas.nspname,
  relations.relname
)
from pg_attribute attributes
join pg_class relations on relations.oid = attributes.attrelid
join pg_namespace schemas on schemas.oid = relations.relnamespace
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
  and relations.relkind in ('r', 'p', 'v', 'm', 'f')
  and attributes.attnum > 0
  and not attributes.attisdropped
  and not exists (
    select 1
    from pg_depend dependencies
    where dependencies.classid = 'pg_class'::regclass
      and dependencies.objid = relations.oid
      and dependencies.objsubid = 0
      and dependencies.refclassid = 'pg_extension'::regclass
      and dependencies.deptype = 'e'
  )
  and has_column_privilege(
    'public',
    relations.oid,
    attributes.attnum,
    'SELECT,INSERT,UPDATE,REFERENCES'
  )
\gexec

select format(
  'revoke all privileges on routine %I.%I(%s) from apollo_tf_migrator, apollo_tf_runtime cascade',
  schemas.nspname,
  routines.proname,
  pg_get_function_identity_arguments(routines.oid)
)
from pg_proc routines
join pg_namespace schemas on schemas.oid = routines.pronamespace
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
  and not exists (
    select 1
    from pg_depend dependencies
    where dependencies.classid = 'pg_proc'::regclass
      and dependencies.objid = routines.oid
      and dependencies.objsubid = 0
      and dependencies.refclassid = 'pg_extension'::regclass
      and dependencies.deptype = 'e'
  )
  and exists (
  select 1
  from aclexplode(routines.proacl) acl
  where acl.grantee in (
    select oid
    from pg_roles
    where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
  )
)
\gexec

select format(
  'revoke all privileges on routine %I.%I(%s) from public cascade',
  schemas.nspname,
  routines.proname,
  pg_get_function_identity_arguments(routines.oid)
)
from pg_proc routines
join pg_namespace schemas on schemas.oid = routines.pronamespace
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
  and not exists (
    select 1
    from pg_depend dependencies
    where dependencies.classid = 'pg_proc'::regclass
      and dependencies.objid = routines.oid
      and dependencies.objsubid = 0
      and dependencies.refclassid = 'pg_extension'::regclass
      and dependencies.deptype = 'e'
  )
  and has_function_privilege('public', routines.oid, 'EXECUTE')
\gexec

select format(
  'revoke all privileges on type %I.%I from apollo_tf_migrator, apollo_tf_runtime cascade',
  schemas.nspname,
  types.typname
)
from pg_type types
join pg_namespace schemas on schemas.oid = types.typnamespace
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
  and not exists (
    select 1
    from pg_depend dependencies
    where dependencies.classid = 'pg_type'::regclass
      and dependencies.objid = types.oid
      and dependencies.objsubid = 0
      and dependencies.refclassid = 'pg_extension'::regclass
      and dependencies.deptype = 'e'
  )
  and exists (
  select 1
  from aclexplode(types.typacl) acl
  where acl.grantee in (
    select oid
    from pg_roles
    where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
  )
)
\gexec

select format(
  'revoke all privileges on type %I.%I from public cascade',
  schemas.nspname,
  types.typname
)
from pg_type types
join pg_namespace schemas on schemas.oid = types.typnamespace
left join pg_class type_relations on type_relations.oid = types.typrelid
where schemas.nspname <> 'information_schema'
  and schemas.nspname !~ '^pg_'
  and types.typisdefined
  and types.typelem = 0
  and (
    types.typrelid = 0
    or type_relations.relkind = 'c'
  )
  and not exists (
    select 1
    from pg_depend dependencies
    where dependencies.classid = 'pg_type'::regclass
      and dependencies.objid = types.oid
      and dependencies.objsubid = 0
      and dependencies.refclassid = 'pg_extension'::regclass
      and dependencies.deptype = 'e'
  )
  and has_type_privilege('public', types.oid, 'USAGE')
\gexec

select format(
  'revoke all privileges on large object %s from apollo_tf_migrator, apollo_tf_runtime cascade',
  objects.oid
)
from pg_largeobject_metadata objects
where exists (
  select 1
  from aclexplode(objects.lomacl) acl
  where acl.grantee in (
    select oid
    from pg_roles
    where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
  )
)
\gexec

select format(
  'revoke all privileges on large object %s from public cascade',
  objects.oid
)
from pg_largeobject_metadata objects
where exists (
  select 1
  from aclexplode(objects.lomacl) acl
  where acl.grantee = 0
)
\gexec

select format(
  'revoke all privileges on language %I from apollo_tf_migrator, apollo_tf_runtime cascade',
  languages.lanname
)
from pg_language languages
where exists (
  select 1
  from aclexplode(languages.lanacl) acl
  where acl.grantee in (
    select oid
    from pg_roles
    where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
  )
)
\gexec

select format(
  'revoke all privileges on foreign data wrapper %I from apollo_tf_migrator, apollo_tf_runtime cascade',
  wrappers.fdwname
)
from pg_foreign_data_wrapper wrappers
where exists (
  select 1
  from aclexplode(wrappers.fdwacl) acl
  where acl.grantee in (
    select oid
    from pg_roles
    where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
  )
)
\gexec

select format(
  'revoke all privileges on foreign data wrapper %I from public cascade',
  wrappers.fdwname
)
from pg_foreign_data_wrapper wrappers
where not exists (
  select 1
  from pg_depend dependencies
  where dependencies.classid = 'pg_foreign_data_wrapper'::regclass
    and dependencies.objid = wrappers.oid
    and dependencies.objsubid = 0
    and dependencies.refclassid = 'pg_extension'::regclass
    and dependencies.deptype = 'e'
)
  and has_foreign_data_wrapper_privilege(
    'public',
    wrappers.oid,
    'USAGE'
  )
\gexec

select format(
  'revoke all privileges on foreign server %I from apollo_tf_migrator, apollo_tf_runtime cascade',
  servers.srvname
)
from pg_foreign_server servers
where exists (
  select 1
  from aclexplode(servers.srvacl) acl
  where acl.grantee in (
    select oid
    from pg_roles
    where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
  )
)
\gexec

select format(
  'revoke all privileges on foreign server %I from public cascade',
  servers.srvname
)
from pg_foreign_server servers
where not exists (
  select 1
  from pg_depend dependencies
  where dependencies.classid = 'pg_foreign_server'::regclass
    and dependencies.objid = servers.oid
    and dependencies.objsubid = 0
    and dependencies.refclassid = 'pg_extension'::regclass
    and dependencies.deptype = 'e'
)
  and has_server_privilege('public', servers.oid, 'USAGE')
\gexec

select format(
  'revoke all privileges on parameter %I from apollo_tf_migrator, apollo_tf_runtime cascade',
  parameters.parname
)
from pg_parameter_acl parameters
where exists (
  select 1
  from aclexplode(parameters.paracl) acl
  where acl.grantee in (
    select oid
    from pg_roles
    where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
  )
)
\gexec

select format(
  'alter default privileges for role %I%s revoke all privileges on %s from %I cascade',
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
  revoke execute on functions from public cascade;

do $audit$
declare
  first_normal_object_id constant oid := 16384;
  migrator_oid oid := (
    select oid from pg_roles where rolname = 'apollo_tf_migrator'
  );
  runtime_oid oid := (
    select oid from pg_roles where rolname = 'apollo_tf_runtime'
  );
begin
  if exists (
    select 1
    from pg_roles roles
    where roles.rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
      and not coalesce(
        (
          roles.rolcanlogin
          and not roles.rolsuper
          and not roles.rolcreatedb
          and not roles.rolcreaterole
          and not roles.rolinherit
          and not roles.rolreplication
          and not roles.rolbypassrls
          and roles.rolconnlimit = -1
          and roles.rolvaliduntil = 'infinity'::timestamptz
          and roles.rolconfig is null
        ),
        false
      )
  )
  or exists (
    select 1
    from pg_auth_members memberships
    where memberships.roleid in (migrator_oid, runtime_oid)
      or memberships.member in (migrator_oid, runtime_oid)
  )
  or exists (
    select 1
    from pg_db_role_setting settings
    where settings.setrole in (migrator_oid, runtime_oid)
  ) then
    raise exception 'role_state_audit_failed';
  end if;

  if exists (
    select 1
    from pg_shdepend dependencies
    where dependencies.refclassid = 'pg_authid'::regclass
      and dependencies.refobjid in (migrator_oid, runtime_oid)
      and dependencies.deptype = 'a'
      and dependencies.dbid <> 0
      and dependencies.dbid <> (
        select oid from pg_database where datname = current_database()
      )
  ) then
    raise exception 'cross_database_acl_dependency';
  end if;

  if exists (
    with direct_acl as (
      select
        'database'::text as acl_class,
        databases.oid as object_oid,
        null::text as schema_name,
        databases.datname::text as object_name,
        null::text as sub_name,
        null::text as object_kind,
        databases.datdba as owner_oid,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      from pg_database databases
      cross join lateral aclexplode(databases.datacl) acl

      union all

      select
        'tablespace',
        tablespaces.oid,
        null,
        tablespaces.spcname,
        null,
        null,
        tablespaces.spcowner,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      from pg_tablespace tablespaces
      cross join lateral aclexplode(tablespaces.spcacl) acl

      union all

      select
        'schema',
        schemas.oid,
        null,
        schemas.nspname,
        null,
        null,
        schemas.nspowner,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      from pg_namespace schemas
      cross join lateral aclexplode(schemas.nspacl) acl

      union all

      select
        'relation',
        relations.oid,
        schemas.nspname,
        relations.relname,
        null,
        relations.relkind::text,
        relations.relowner,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      from pg_class relations
      join pg_namespace schemas on schemas.oid = relations.relnamespace
      cross join lateral aclexplode(relations.relacl) acl

      union all

      select
        'column',
        relations.oid,
        schemas.nspname,
        relations.relname,
        attributes.attname,
        relations.relkind::text,
        relations.relowner,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      from pg_attribute attributes
      join pg_class relations on relations.oid = attributes.attrelid
      join pg_namespace schemas on schemas.oid = relations.relnamespace
      cross join lateral aclexplode(attributes.attacl) acl

      union all

      select
        'routine',
        routines.oid,
        schemas.nspname,
        routines.proname,
        pg_get_function_identity_arguments(routines.oid),
        routines.prokind::text,
        routines.proowner,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      from pg_proc routines
      join pg_namespace schemas on schemas.oid = routines.pronamespace
      cross join lateral aclexplode(routines.proacl) acl

      union all

      select
        'type',
        types.oid,
        schemas.nspname,
        types.typname,
        null,
        types.typtype::text,
        types.typowner,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      from pg_type types
      join pg_namespace schemas on schemas.oid = types.typnamespace
      cross join lateral aclexplode(types.typacl) acl

      union all

      select
        'large_object',
        objects.oid,
        null,
        objects.oid::text,
        null,
        null,
        objects.lomowner,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      from pg_largeobject_metadata objects
      cross join lateral aclexplode(objects.lomacl) acl

      union all

      select
        'language',
        languages.oid,
        null,
        languages.lanname,
        null,
        null,
        languages.lanowner,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      from pg_language languages
      cross join lateral aclexplode(languages.lanacl) acl

      union all

      select
        'foreign_data_wrapper',
        wrappers.oid,
        null,
        wrappers.fdwname,
        null,
        null,
        wrappers.fdwowner,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      from pg_foreign_data_wrapper wrappers
      cross join lateral aclexplode(wrappers.fdwacl) acl

      union all

      select
        'foreign_server',
        servers.oid,
        null,
        servers.srvname,
        null,
        null,
        servers.srvowner,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      from pg_foreign_server servers
      cross join lateral aclexplode(servers.srvacl) acl

      union all

      select
        'parameter',
        parameters.oid,
        null,
        parameters.parname,
        null,
        null,
        null::oid,
        acl.grantee,
        acl.privilege_type,
        acl.is_grantable
      from pg_parameter_acl parameters
      cross join lateral aclexplode(parameters.paracl) acl
    )
    select 1
    from direct_acl
    where direct_acl.grantee in (migrator_oid, runtime_oid)
      and not coalesce(
        (
          not direct_acl.is_grantable
          and (
            (
              direct_acl.grantee = migrator_oid
              and (
                direct_acl.owner_oid = migrator_oid
                or (
                  direct_acl.acl_class = 'database'
                  and direct_acl.object_name = current_database()
                  and direct_acl.privilege_type in ('CONNECT', 'CREATE')
                )
                or (
                  direct_acl.acl_class = 'schema'
                  and direct_acl.object_name = 'public'
                  and direct_acl.privilege_type in ('USAGE', 'CREATE')
                )
              )
            )
            or (
              direct_acl.grantee = runtime_oid
              and (
                (
                  direct_acl.acl_class = 'database'
                  and direct_acl.object_name = current_database()
                  and direct_acl.privilege_type = 'CONNECT'
                )
                or (
                  direct_acl.acl_class = 'schema'
                  and direct_acl.object_name in ('public', 'apollo_tf')
                  and direct_acl.privilege_type = 'USAGE'
                )
                or (
                  direct_acl.acl_class = 'relation'
                  and direct_acl.schema_name = 'public'
                  and direct_acl.object_kind in ('r', 'p')
                  and direct_acl.object_name in (
                    'track_search_cache',
                    'play_history',
                    'liked_tracks',
                    'playlists',
                    'playlist_tracks'
                  )
                  and direct_acl.privilege_type in (
                    'SELECT',
                    'INSERT',
                    'UPDATE',
                    'DELETE'
                  )
                )
                or (
                  direct_acl.acl_class = 'relation'
                  and direct_acl.schema_name = 'public'
                  and direct_acl.object_kind = 'S'
                  and direct_acl.object_name in (
                    'track_search_cache_id_seq',
                    'play_history_id_seq',
                    'liked_tracks_id_seq',
                    'playlists_id_seq',
                    'playlist_tracks_id_seq'
                  )
                  and direct_acl.privilege_type = 'USAGE'
                )
                or (
                  direct_acl.acl_class = 'relation'
                  and direct_acl.schema_name = 'apollo_tf'
                  and direct_acl.object_kind in ('r', 'p')
                  and direct_acl.object_name = 'schema_migrations'
                  and direct_acl.privilege_type = 'SELECT'
                )
              )
            )
          )
        ),
        false
      )
  ) then
    raise exception 'direct_acl_audit_failed';
  end if;

  if exists (
    select 1
    from pg_namespace schemas
    where (
        (
          schemas.nspname <> 'information_schema'
          and schemas.nspname !~ '^pg_'
        )
        or schemas.oid >= first_normal_object_id
      )
      and (
        has_schema_privilege(runtime_oid, schemas.oid, 'CREATE')
        or has_schema_privilege(runtime_oid, schemas.oid, 'USAGE') <>
          (schemas.nspname in ('public', 'apollo_tf'))
      )
  )
  or exists (
    select 1
    from pg_class relations
    join pg_namespace schemas on schemas.oid = relations.relnamespace
    where (
        (
          schemas.nspname <> 'information_schema'
          and schemas.nspname !~ '^pg_'
        )
        or relations.oid >= first_normal_object_id
      )
      and relations.relkind in ('r', 'p', 'v', 'm', 'f')
      and (
        has_table_privilege(runtime_oid, relations.oid, 'SELECT') <>
          (
            (
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
        or has_table_privilege(runtime_oid, relations.oid, 'INSERT') <>
          (
            schemas.nspname = 'public'
            and relations.relname in (
              'track_search_cache',
              'play_history',
              'liked_tracks',
              'playlists',
              'playlist_tracks'
            )
          )
        or has_table_privilege(runtime_oid, relations.oid, 'UPDATE') <>
          (
            schemas.nspname = 'public'
            and relations.relname in (
              'track_search_cache',
              'play_history',
              'liked_tracks',
              'playlists',
              'playlist_tracks'
            )
          )
        or has_table_privilege(runtime_oid, relations.oid, 'DELETE') <>
          (
            schemas.nspname = 'public'
            and relations.relname in (
              'track_search_cache',
              'play_history',
              'liked_tracks',
              'playlists',
              'playlist_tracks'
            )
          )
        or has_table_privilege(runtime_oid, relations.oid, 'TRUNCATE')
        or has_table_privilege(runtime_oid, relations.oid, 'REFERENCES')
        or has_table_privilege(runtime_oid, relations.oid, 'TRIGGER')
      )
  )
  or exists (
    select 1
    from pg_class relations
    join pg_namespace schemas on schemas.oid = relations.relnamespace
    where (
        (
          schemas.nspname <> 'information_schema'
          and schemas.nspname !~ '^pg_'
        )
        or relations.oid >= first_normal_object_id
      )
      and relations.relkind = 'S'
      and (
        has_sequence_privilege(runtime_oid, relations.oid, 'USAGE') <>
          (
            schemas.nspname = 'public'
            and relations.relname in (
              'track_search_cache_id_seq',
              'play_history_id_seq',
              'liked_tracks_id_seq',
              'playlists_id_seq',
              'playlist_tracks_id_seq'
            )
          )
        or has_sequence_privilege(runtime_oid, relations.oid, 'SELECT')
        or has_sequence_privilege(runtime_oid, relations.oid, 'UPDATE')
      )
  )
  or exists (
    select 1
    from pg_attribute attributes
    join pg_class relations on relations.oid = attributes.attrelid
    join pg_namespace schemas on schemas.oid = relations.relnamespace
    where (
        (
          schemas.nspname <> 'information_schema'
          and schemas.nspname !~ '^pg_'
        )
        or relations.oid >= first_normal_object_id
      )
      and relations.relkind in ('r', 'p', 'v', 'm', 'f')
      and attributes.attnum > 0
      and not attributes.attisdropped
      and (
        has_column_privilege(
          runtime_oid,
          relations.oid,
          attributes.attnum,
          'SELECT'
        ) <>
          (
            (
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
        or has_column_privilege(
          runtime_oid,
          relations.oid,
          attributes.attnum,
          'INSERT'
        ) <>
          (
            schemas.nspname = 'public'
            and relations.relname in (
              'track_search_cache',
              'play_history',
              'liked_tracks',
              'playlists',
              'playlist_tracks'
            )
          )
        or has_column_privilege(
          runtime_oid,
          relations.oid,
          attributes.attnum,
          'UPDATE'
        ) <>
          (
            schemas.nspname = 'public'
            and relations.relname in (
              'track_search_cache',
              'play_history',
              'liked_tracks',
              'playlists',
              'playlist_tracks'
            )
          )
        or has_column_privilege(
          runtime_oid,
          relations.oid,
          attributes.attnum,
          'REFERENCES'
        )
      )
  )
  or exists (
    select 1
    from pg_proc routines
    join pg_namespace schemas on schemas.oid = routines.pronamespace
    where (
        (
          schemas.nspname <> 'information_schema'
          and schemas.nspname !~ '^pg_'
        )
        or routines.oid >= first_normal_object_id
      )
      and has_function_privilege(runtime_oid, routines.oid, 'EXECUTE')
  )
  or exists (
    select 1
    from pg_type types
    join pg_namespace schemas on schemas.oid = types.typnamespace
    left join pg_class type_relations on type_relations.oid = types.typrelid
    where (
        (
          schemas.nspname <> 'information_schema'
          and schemas.nspname !~ '^pg_'
        )
        or types.oid >= first_normal_object_id
      )
      and types.typisdefined
      and types.typelem = 0
      and (
        types.typrelid = 0
        or type_relations.relkind = 'c'
      )
      and has_type_privilege(runtime_oid, types.oid, 'USAGE')
  )
  or exists (
    select 1
    from pg_largeobject_metadata objects
    cross join lateral aclexplode(objects.lomacl) acl
    where acl.grantee = 0
  )
  or exists (
    select 1
    from pg_foreign_data_wrapper wrappers
    where has_foreign_data_wrapper_privilege(
        runtime_oid,
        wrappers.oid,
        'USAGE'
      )
  )
  or exists (
    select 1
    from pg_foreign_server servers
    where has_server_privilege(runtime_oid, servers.oid, 'USAGE')
  ) then
    raise exception 'effective_runtime_acl_audit_failed';
  end if;

  if exists (
    select 1
    from pg_default_acl defaults
    cross join lateral aclexplode(defaults.defaclacl) acl
    where (
      defaults.defaclrole in (migrator_oid, runtime_oid)
      or acl.grantee in (migrator_oid, runtime_oid)
    )
      and not (
        defaults.defaclrole = migrator_oid
        and defaults.defaclnamespace = 0
        and defaults.defaclobjtype = 'f'
        and acl.grantee = migrator_oid
        and acl.privilege_type = 'EXECUTE'
        and not acl.is_grantable
      )
  ) then
    raise exception 'default_acl_audit_failed';
  end if;
end
$audit$;

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
