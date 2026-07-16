create schema if not exists apollo_platform;
revoke all on schema apollo_platform from public;
alter default privileges for role apollo_platform_migrator
  revoke execute on functions from public;

create table apollo_platform.accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text not null,
  status text not null default 'pending',
  email_verified_at timestamptz,
  activated_at timestamptz,
  suspended_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounts_email_normalized_check
    check (email = lower(btrim(email)) and email <> ''),
  constraint accounts_email_key unique (email),
  constraint accounts_display_name_check check (btrim(display_name) <> ''),
  constraint accounts_status_check
    check (status in ('pending', 'active', 'suspended', 'deleted')),
  constraint accounts_lifecycle_check check (
    (email_verified_at is null or email_verified_at >= created_at)
    and (activated_at is null or activated_at >= created_at)
    and (suspended_at is null or suspended_at >= created_at)
    and (deleted_at is null or deleted_at >= created_at)
    and updated_at >= created_at
  )
);

create table apollo_platform.credentials (
  account_id uuid primary key
    references apollo_platform.accounts(id) on delete cascade,
  password_hash text not null,
  password_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint credentials_password_hash_check check (btrim(password_hash) <> ''),
  constraint credentials_timestamps_check check (
    password_changed_at >= created_at and updated_at >= created_at
  )
);

create table apollo_platform.email_verification_tokens (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references apollo_platform.accounts(id) on delete cascade,
  token_digest text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint email_verification_tokens_digest_check
    check (btrim(token_digest) <> ''),
  constraint email_verification_tokens_expiry_check check (expires_at > created_at),
  constraint email_verification_tokens_consumed_check
    check (
      consumed_at is null
      or (consumed_at >= created_at and consumed_at <= expires_at)
    )
);

create index email_verification_tokens_account_id_idx
  on apollo_platform.email_verification_tokens(account_id);

create table apollo_platform.password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references apollo_platform.accounts(id) on delete cascade,
  token_digest text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint password_reset_tokens_digest_check check (btrim(token_digest) <> ''),
  constraint password_reset_tokens_expiry_check check (expires_at > created_at),
  constraint password_reset_tokens_consumed_check
    check (
      consumed_at is null
      or (consumed_at >= created_at and consumed_at <= expires_at)
    )
);

create index password_reset_tokens_account_id_idx
  on apollo_platform.password_reset_tokens(account_id);

create table apollo_platform.client_installations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references apollo_platform.accounts(id) on delete cascade,
  label text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint client_installations_account_key unique (id, account_id),
  constraint client_installations_label_check check (btrim(label) <> ''),
  constraint client_installations_timestamps_check check (
    last_seen_at >= first_seen_at
    and (revoked_at is null or revoked_at >= first_seen_at)
  )
);

create index client_installations_account_id_idx
  on apollo_platform.client_installations(account_id);

create table apollo_platform.auth_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references apollo_platform.accounts(id) on delete cascade,
  installation_id uuid,
  session_digest text not null unique,
  audience text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint auth_sessions_installation_fkey
    foreign key (installation_id, account_id)
    references apollo_platform.client_installations(id, account_id),
  constraint auth_sessions_digest_check check (btrim(session_digest) <> ''),
  constraint auth_sessions_audience_check check (btrim(audience) <> ''),
  constraint auth_sessions_expiry_check check (expires_at > created_at),
  constraint auth_sessions_timestamps_check check (
    last_seen_at >= created_at
    and (revoked_at is null or revoked_at >= created_at)
  )
);

create index auth_sessions_account_id_idx
  on apollo_platform.auth_sessions(account_id);
create index auth_sessions_installation_idx
  on apollo_platform.auth_sessions(installation_id, account_id);

create table apollo_platform.authorization_codes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references apollo_platform.accounts(id) on delete cascade,
  code_digest text not null unique,
  client_id text not null,
  redirect_uri text not null,
  pkce_challenge text not null,
  pkce_method text not null default 'S256',
  nonce text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint authorization_codes_digest_check check (btrim(code_digest) <> ''),
  constraint authorization_codes_client_id_check check (btrim(client_id) <> ''),
  constraint authorization_codes_redirect_uri_check check (btrim(redirect_uri) <> ''),
  constraint authorization_codes_pkce_challenge_check
    check (btrim(pkce_challenge) <> ''),
  constraint authorization_codes_pkce_method_check check (pkce_method = 'S256'),
  constraint authorization_codes_nonce_check check (btrim(nonce) <> ''),
  constraint authorization_codes_expiry_check check (expires_at > created_at),
  constraint authorization_codes_consumed_check
    check (
      consumed_at is null
      or (consumed_at >= created_at and consumed_at <= expires_at)
    )
);

create index authorization_codes_account_id_idx
  on apollo_platform.authorization_codes(account_id);

create table apollo_platform.registration_settings (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true,
  mode text not null,
  revision bigint not null default 1,
  updated_by_account_id uuid
    references apollo_platform.accounts(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint registration_settings_singleton_key unique (singleton),
  constraint registration_settings_singleton_check check (singleton),
  constraint registration_settings_mode_check
    check (mode in ('closed', 'invite_only', 'open_approval')),
  constraint registration_settings_revision_check check (revision > 0)
);

create index registration_settings_updated_by_idx
  on apollo_platform.registration_settings(updated_by_account_id);

create table apollo_platform.invitations (
  id uuid primary key default gen_random_uuid(),
  token_digest text not null unique,
  email text,
  expires_at timestamptz not null,
  uses_limit integer not null,
  uses_count integer not null default 0,
  revoked_at timestamptz,
  created_by_account_id uuid
    references apollo_platform.accounts(id) on delete set null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invitations_digest_check check (btrim(token_digest) <> ''),
  constraint invitations_email_normalized_check
    check (email is null or (email = lower(btrim(email)) and email <> '')),
  constraint invitations_expiry_check check (expires_at > created_at),
  constraint invitations_uses_limit_check check (uses_limit > 0),
  constraint invitations_uses_count_check
    check (uses_count >= 0 and uses_count <= uses_limit),
  constraint invitations_revoked_check
    check (revoked_at is null or revoked_at >= created_at),
  constraint invitations_reason_check check (btrim(reason) <> ''),
  constraint invitations_updated_check check (updated_at >= created_at)
);

create index invitations_email_idx on apollo_platform.invitations(email);
create index invitations_created_by_idx
  on apollo_platform.invitations(created_by_account_id);

create table apollo_platform.modules (
  id uuid primary key default gen_random_uuid(),
  module_key text not null,
  product text not null,
  display_name text not null,
  state text not null,
  description text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint modules_module_key_key unique (module_key),
  constraint modules_module_key_normalized_check check (
    module_key = lower(btrim(module_key))
    and module_key ~ '^[a-z0-9]+(\.[a-z0-9]+)+$'
  ),
  constraint modules_product_check check (btrim(product) <> ''),
  constraint modules_display_name_check check (btrim(display_name) <> ''),
  constraint modules_state_check check (state in ('active', 'disabled')),
  constraint modules_description_check check (btrim(description) <> ''),
  constraint modules_updated_check check (updated_at >= created_at)
);

create table apollo_platform.invitation_module_grants (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null
    references apollo_platform.invitations(id) on delete cascade,
  module_id uuid not null
    references apollo_platform.modules(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint invitation_module_grants_key unique (invitation_id, module_id)
);

create index invitation_module_grants_module_id_idx
  on apollo_platform.invitation_module_grants(module_id);

create table apollo_platform.account_module_entitlements (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references apollo_platform.accounts(id) on delete cascade,
  module_id uuid not null
    references apollo_platform.modules(id) on delete restrict,
  expires_at timestamptz,
  revoked_at timestamptz,
  source text not null,
  granted_by_account_id uuid
    references apollo_platform.accounts(id) on delete set null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_module_entitlements_key unique (account_id, module_id),
  constraint account_module_entitlements_source_check check (btrim(source) <> ''),
  constraint account_module_entitlements_reason_check check (btrim(reason) <> ''),
  constraint account_module_entitlements_expiry_check
    check (expires_at is null or expires_at > created_at),
  constraint account_module_entitlements_revoked_check
    check (revoked_at is null or revoked_at >= created_at),
  constraint account_module_entitlements_updated_check check (updated_at >= created_at)
);

create index account_module_entitlements_module_id_idx
  on apollo_platform.account_module_entitlements(module_id);
create index account_module_entitlements_granted_by_idx
  on apollo_platform.account_module_entitlements(granted_by_account_id);

create table apollo_platform.operator_roles (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references apollo_platform.accounts(id) on delete cascade,
  capability text not null,
  granted_by_account_id uuid
    references apollo_platform.accounts(id) on delete set null,
  reason text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by_account_id uuid
    references apollo_platform.accounts(id) on delete set null,
  revocation_reason text,
  constraint operator_roles_key unique (account_id, capability),
  constraint operator_roles_capability_check check (btrim(capability) <> ''),
  constraint operator_roles_reason_check check (btrim(reason) <> ''),
  constraint operator_roles_revoked_check
    check (revoked_at is null or revoked_at >= granted_at),
  constraint operator_roles_revocation_metadata_check check (
    (revoked_at is null and revoked_by_account_id is null and revocation_reason is null)
    or (
      revoked_at is not null
      and revocation_reason is not null
      and btrim(revocation_reason) <> ''
    )
  )
);

create index operator_roles_granted_by_idx
  on apollo_platform.operator_roles(granted_by_account_id);
create index operator_roles_revoked_by_idx
  on apollo_platform.operator_roles(revoked_by_account_id);

create table apollo_platform.projects (
  id uuid primary key default gen_random_uuid(),
  project_key text not null unique,
  display_name text not null,
  state text not null,
  description text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_key_normalized_check check (
    project_key = lower(btrim(project_key))
    and project_key ~ '^[a-z0-9]+(\.[a-z0-9]+)+$'
  ),
  constraint projects_display_name_check check (btrim(display_name) <> ''),
  constraint projects_state_check check (state in ('active', 'archived')),
  constraint projects_description_check check (btrim(description) <> ''),
  constraint projects_updated_check check (updated_at >= created_at)
);

create table apollo_platform.project_releases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null
    references apollo_platform.projects(id) on delete restrict,
  version text not null,
  released_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint project_releases_key unique (project_id, version),
  constraint project_releases_version_check check (btrim(version) <> ''),
  constraint project_releases_released_check check (released_at >= created_at)
);

create table apollo_platform.changelog_entries (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null
    references apollo_platform.project_releases(id) on delete restrict,
  sort_order integer not null,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  constraint changelog_entries_order_key unique (release_id, sort_order),
  constraint changelog_entries_sort_order_check check (sort_order >= 0),
  constraint changelog_entries_title_check check (btrim(title) <> ''),
  constraint changelog_entries_body_check check (btrim(body) <> '')
);

create table apollo_platform.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_account_id uuid
    references apollo_platform.accounts(id) on delete set null,
  target_type text not null,
  target_id text not null,
  action text not null,
  correlation_id uuid not null,
  reason text not null,
  previous_value jsonb,
  new_value jsonb,
  occurred_at timestamptz not null default now(),
  constraint audit_events_target_type_check check (btrim(target_type) <> ''),
  constraint audit_events_target_id_check check (btrim(target_id) <> ''),
  constraint audit_events_action_check check (btrim(action) <> ''),
  constraint audit_events_reason_check check (btrim(reason) <> '')
);

create index audit_events_actor_account_id_idx
  on apollo_platform.audit_events(actor_account_id);
create index audit_events_target_idx
  on apollo_platform.audit_events(target_type, target_id);
create index audit_events_correlation_id_idx
  on apollo_platform.audit_events(correlation_id);
create index audit_events_occurred_at_idx
  on apollo_platform.audit_events(occurred_at);

create function apollo_platform.enforce_registration_revision()
returns trigger
language plpgsql
as $$
begin
  if new.revision <= old.revision then
    raise exception 'registration_settings revision must increase'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger registration_settings_revision_guard
before update on apollo_platform.registration_settings
for each row execute function apollo_platform.enforce_registration_revision();

create function apollo_platform.reject_immutable_change()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is immutable', tg_table_name using errcode = '55000';
end;
$$;

create trigger project_releases_immutable
before update or delete on apollo_platform.project_releases
for each row execute function apollo_platform.reject_immutable_change();

create trigger project_releases_truncate_immutable
before truncate on apollo_platform.project_releases
for each statement execute function apollo_platform.reject_immutable_change();

create trigger audit_events_immutable
before update or delete on apollo_platform.audit_events
for each row execute function apollo_platform.reject_immutable_change();

create trigger audit_events_truncate_immutable
before truncate on apollo_platform.audit_events
for each statement execute function apollo_platform.reject_immutable_change();

insert into apollo_platform.registration_settings (mode, revision)
values ('closed', 1);

insert into apollo_platform.modules
  (module_key, product, display_name, state, description)
values
  ('tf.search', 'trackfinder', 'Search', 'active', 'Search and playback metadata'),
  (
    'tf.integrations',
    'trackfinder',
    'Integrations',
    'active',
    'Spotify and Yandex connection and parsing'
  ),
  (
    'tf.downloads',
    'trackfinder',
    'Downloads',
    'active',
    'Download and transcode requests and retrieval'
  ),
  (
    'tf.collections',
    'trackfinder',
    'Collections',
    'active',
    'Likes, playlists, history, and legacy collection migration'
  );

alter table apollo_platform.accounts enable row level security;
alter table apollo_platform.accounts force row level security;
create policy accounts_account_isolation on apollo_platform.accounts
  for all
  using (id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.account_id', true), '')::uuid);

alter table apollo_platform.credentials enable row level security;
alter table apollo_platform.credentials force row level security;
create policy credentials_account_isolation on apollo_platform.credentials
  for all
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (
    account_id = nullif(current_setting('app.account_id', true), '')::uuid
  );

alter table apollo_platform.email_verification_tokens enable row level security;
alter table apollo_platform.email_verification_tokens force row level security;
create policy email_verification_tokens_account_isolation
  on apollo_platform.email_verification_tokens
  for all
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (
    account_id = nullif(current_setting('app.account_id', true), '')::uuid
  );

alter table apollo_platform.password_reset_tokens enable row level security;
alter table apollo_platform.password_reset_tokens force row level security;
create policy password_reset_tokens_account_isolation
  on apollo_platform.password_reset_tokens
  for all
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (
    account_id = nullif(current_setting('app.account_id', true), '')::uuid
  );

alter table apollo_platform.client_installations enable row level security;
alter table apollo_platform.client_installations force row level security;
create policy client_installations_account_isolation
  on apollo_platform.client_installations
  for all
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (
    account_id = nullif(current_setting('app.account_id', true), '')::uuid
  );

alter table apollo_platform.auth_sessions enable row level security;
alter table apollo_platform.auth_sessions force row level security;
create policy auth_sessions_account_isolation on apollo_platform.auth_sessions
  for all
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (
    account_id = nullif(current_setting('app.account_id', true), '')::uuid
  );

alter table apollo_platform.authorization_codes enable row level security;
alter table apollo_platform.authorization_codes force row level security;
create policy authorization_codes_account_isolation
  on apollo_platform.authorization_codes
  for all
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (
    account_id = nullif(current_setting('app.account_id', true), '')::uuid
  );

alter table apollo_platform.account_module_entitlements enable row level security;
alter table apollo_platform.account_module_entitlements force row level security;
create policy account_module_entitlements_account_isolation
  on apollo_platform.account_module_entitlements
  for all
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (
    account_id = nullif(current_setting('app.account_id', true), '')::uuid
  );

alter table apollo_platform.operator_roles enable row level security;
alter table apollo_platform.operator_roles force row level security;
create policy operator_roles_account_isolation on apollo_platform.operator_roles
  for all
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (
    account_id = nullif(current_setting('app.account_id', true), '')::uuid
  );

grant usage on schema apollo_platform to apollo_platform_runtime;

grant select, insert, update on
  apollo_platform.accounts,
  apollo_platform.credentials,
  apollo_platform.email_verification_tokens,
  apollo_platform.password_reset_tokens,
  apollo_platform.client_installations,
  apollo_platform.auth_sessions,
  apollo_platform.authorization_codes,
  apollo_platform.registration_settings,
  apollo_platform.invitations,
  apollo_platform.invitation_module_grants,
  apollo_platform.modules,
  apollo_platform.account_module_entitlements,
  apollo_platform.operator_roles,
  apollo_platform.projects,
  apollo_platform.changelog_entries
to apollo_platform_runtime;

grant select, insert on
  apollo_platform.project_releases,
  apollo_platform.audit_events
to apollo_platform_runtime;

revoke execute on function apollo_platform.enforce_registration_revision()
  from public;
revoke execute on function apollo_platform.reject_immutable_change()
  from public;
