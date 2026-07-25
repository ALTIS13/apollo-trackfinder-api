alter table apollo_tf_integrations.provider_accounts
  add column generation uuid not null default gen_random_uuid();

alter table apollo_tf_integrations.provider_accounts
  alter column generation drop default;
