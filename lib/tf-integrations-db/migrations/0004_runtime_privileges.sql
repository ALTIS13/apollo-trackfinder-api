alter default privileges for role apollo_tf_integrations_migrator
  revoke usage on schemas from apollo_tf_integrations_runtime;

alter default privileges for role apollo_tf_integrations_migrator
  revoke select, insert, update, delete on tables
  from apollo_tf_integrations_runtime;

revoke all privileges on all tables in schema apollo_tf_integrations
  from apollo_tf_integrations_runtime;

grant usage on schema apollo_tf_integrations
  to apollo_tf_integrations_runtime;

grant select, insert, update, delete
  on table apollo_tf_integrations.provider_accounts
  to apollo_tf_integrations_runtime;

grant select on table apollo_tf_integrations.schema_migrations
  to apollo_tf_integrations_runtime;
