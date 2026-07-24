lock table apollo_platform.authorization_codes in access exclusive mode;

alter table apollo_platform.authorization_codes no force row level security;

do $$
begin
  if exists (
    select 1 from apollo_platform.authorization_codes
  ) then
    raise exception 'authorization code drain required before migration 0004'
      using errcode = '55000';
  end if;
end
$$;

alter table apollo_platform.authorization_codes force row level security;

alter table apollo_platform.auth_sessions
  add constraint auth_sessions_id_account_key unique (id, account_id);

alter table apollo_platform.authorization_codes
  add column auth_session_id uuid not null,
  add column installation_id uuid not null,
  add column state_digest text not null;

alter table apollo_platform.authorization_codes
  add constraint authorization_codes_session_fkey
    foreign key (auth_session_id, account_id)
    references apollo_platform.auth_sessions(id, account_id) on delete cascade,
  add constraint authorization_codes_installation_fkey
    foreign key (installation_id, account_id)
    references apollo_platform.client_installations(id, account_id),
  add constraint authorization_codes_state_digest_check
    check (state_digest ~ '^[0-9a-f]{64}$');

create index authorization_codes_session_id_idx
  on apollo_platform.authorization_codes(auth_session_id);
