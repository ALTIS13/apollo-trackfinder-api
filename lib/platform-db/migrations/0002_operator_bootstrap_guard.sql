alter table apollo_platform.registration_settings
  add column operator_bootstrap_account_id uuid
    references apollo_platform.accounts(id) on delete restrict,
  add column operator_bootstrap_completed_at timestamptz,
  add constraint operator_bootstrap_metadata_check check (
    (operator_bootstrap_account_id is null)
    = (operator_bootstrap_completed_at is null)
  );

alter table apollo_platform.operator_roles no force row level security;

with first_active_operator as (
  select account_id, min(granted_at) as granted_at
  from apollo_platform.operator_roles
  where revoked_at is null
  group by account_id
  order by min(granted_at), account_id
  limit 1
)
update apollo_platform.registration_settings as settings
set operator_bootstrap_account_id = first_active_operator.account_id,
    operator_bootstrap_completed_at = first_active_operator.granted_at,
    revision = settings.revision + 1,
    updated_at = greatest(settings.updated_at, first_active_operator.granted_at)
from first_active_operator
where settings.singleton = true
  and settings.operator_bootstrap_account_id is null;

alter table apollo_platform.operator_roles force row level security;

create function apollo_platform.record_operator_bootstrap()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, apollo_platform
as $$
begin
  update apollo_platform.registration_settings as settings
  set operator_bootstrap_account_id = new.account_id,
      operator_bootstrap_completed_at = new.granted_at,
      revision = settings.revision + 1,
      updated_at = greatest(settings.updated_at, new.granted_at)
  where settings.singleton = true
    and settings.operator_bootstrap_account_id is null;

  return new;
end;
$$;

create trigger operator_roles_bootstrap_guard
before insert on apollo_platform.operator_roles
for each row execute function apollo_platform.record_operator_bootstrap();

revoke update on apollo_platform.registration_settings
  from apollo_platform_runtime;
grant update (mode, revision, updated_by_account_id, updated_at)
  on apollo_platform.registration_settings
  to apollo_platform_runtime;

revoke execute on function apollo_platform.record_operator_bootstrap()
  from public;
