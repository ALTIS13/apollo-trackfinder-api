\set ON_ERROR_STOP on

create role apollo_platform_migrator
  login
  password 'platform_migrator_test'
  nosuperuser
  nocreatedb
  nocreaterole
  noinherit
  noreplication
  nobypassrls;

create role apollo_platform_runtime
  login
  password 'platform_runtime_test'
  nosuperuser
  nocreatedb
  nocreaterole
  noinherit
  noreplication
  nobypassrls;

alter database apollo_platform_test owner to apollo_platform_migrator;
revoke all on database apollo_platform_test from public;
grant connect on database apollo_platform_test to apollo_platform_migrator;
grant connect on database apollo_platform_test to apollo_platform_runtime;
revoke create on schema public from public;
