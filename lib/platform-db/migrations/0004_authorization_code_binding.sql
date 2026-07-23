alter table apollo_platform.authorization_codes
  add column auth_session_id uuid not null
    references apollo_platform.auth_sessions(id) on delete cascade,
  add column installation_id uuid not null,
  add column state_digest text not null;

alter table apollo_platform.authorization_codes
  add constraint authorization_codes_installation_fkey
    foreign key (installation_id, account_id)
    references apollo_platform.client_installations(id, account_id),
  add constraint authorization_codes_state_digest_check
    check (state_digest ~ '^[0-9a-f]{64}$');

create index authorization_codes_session_id_idx
  on apollo_platform.authorization_codes(auth_session_id);
