create policy accounts_operator_overview_select
  on apollo_platform.accounts
  for select to apollo_platform_migrator
  using (
    current_setting('app.operator_overview_capability', true)
      = 'platform.accounts.manage'
    and exists (
      select 1
      from apollo_platform.operator_roles as operator_role
      where operator_role.account_id = nullif(
              current_setting('app.account_id', true),
              ''
            )::uuid
        and operator_role.capability = 'platform.accounts.manage'
        and operator_role.revoked_at is null
    )
  );

create policy auth_sessions_operator_overview_select
  on apollo_platform.auth_sessions
  for select to apollo_platform_migrator
  using (
    current_setting('app.operator_overview_capability', true)
      = 'platform.accounts.manage'
    and exists (
      select 1
      from apollo_platform.operator_roles as operator_role
      where operator_role.account_id = nullif(
              current_setting('app.account_id', true),
              ''
            )::uuid
        and operator_role.capability = 'platform.accounts.manage'
        and operator_role.revoked_at is null
    )
  );

create policy account_module_entitlements_operator_overview_select
  on apollo_platform.account_module_entitlements
  for select to apollo_platform_migrator
  using (
    current_setting('app.operator_overview_capability', true)
      = 'platform.accounts.manage'
    and exists (
      select 1
      from apollo_platform.operator_roles as operator_role
      where operator_role.account_id = nullif(
              current_setting('app.account_id', true),
              ''
            )::uuid
        and operator_role.capability = 'platform.accounts.manage'
        and operator_role.revoked_at is null
    )
  );

create function apollo_platform.admin_account_overview(
  operator_account_id uuid,
  observed_at timestamptz,
  account_limit integer
)
returns table (
  total bigint,
  active_now bigint,
  pending bigint,
  suspended bigint,
  account_id uuid,
  email text,
  display_name text,
  status text,
  latest_activity_at timestamptz,
  active_session_count integer,
  module_keys text[]
)
language plpgsql
security definer
set search_path = pg_catalog, apollo_platform
set row_security = on
as $$
declare
  previous_account_id text := current_setting('app.account_id', true);
  previous_capability text := current_setting(
    'app.operator_overview_capability',
    true
  );
begin
  if operator_account_id is null or observed_at is null
     or account_limit is null
     or account_limit < 1 or account_limit > 100 then
    raise exception 'invalid admin account overview request'
      using errcode = '22023';
  end if;

  perform set_config('app.account_id', operator_account_id::text, true);

  if not exists (
    select 1
    from apollo_platform.accounts as operator_account
    join apollo_platform.operator_roles as operator_role
      on operator_role.account_id = operator_account.id
    where operator_account.id = operator_account_id
      and operator_account.status = 'active'
      and operator_role.capability = 'platform.accounts.manage'
      and operator_role.revoked_at is null
  ) then
    raise exception 'admin account overview denied'
      using errcode = '42501';
  end if;

  perform set_config(
    'app.operator_overview_capability',
    'platform.accounts.manage',
    true
  );

  return query
  with active_sessions as (
    select session.account_id,
           count(*)::integer as active_session_count
    from apollo_platform.auth_sessions as session
    where session.revoked_at is null
      and session.expires_at > observed_at
      and session.last_seen_at >= observed_at - interval '15 minutes'
    group by session.account_id
  ),
  summary as (
    select count(*) as total,
           count(*) filter (
             where account.status = 'active'
               and active_session.account_id is not null
           ) as active_now,
           count(*) filter (where account.status = 'pending') as pending,
           count(*) filter (where account.status = 'suspended') as suspended
    from apollo_platform.accounts as account
    left join active_sessions as active_session
      on active_session.account_id = account.id
  ),
  listed_accounts as (
    select account.id as account_id,
           account.email,
           account.display_name,
           account.status::text as status,
           max(session.last_seen_at) as latest_activity_at,
           coalesce(active_session.active_session_count, 0)::integer
             as active_session_count,
           coalesce(
             array_agg(distinct module.module_key) filter (
               where entitlement.revoked_at is null
                 and (
                   entitlement.expires_at is null
                   or entitlement.expires_at > observed_at
                 )
                 and module.state = 'active'
             ),
             '{}'::text[]
           ) as module_keys
    from apollo_platform.accounts as account
    left join apollo_platform.auth_sessions as session
      on session.account_id = account.id
    left join active_sessions as active_session
      on active_session.account_id = account.id
    left join apollo_platform.account_module_entitlements as entitlement
      on entitlement.account_id = account.id
    left join apollo_platform.modules as module
      on module.id = entitlement.module_id
    group by account.id, active_session.active_session_count
    order by latest_activity_at desc nulls last, account.id
    limit account_limit
  )
  select summary.total,
         summary.active_now,
         summary.pending,
         summary.suspended,
         listed.account_id,
         listed.email,
         listed.display_name,
         listed.status,
         listed.latest_activity_at,
         listed.active_session_count,
         listed.module_keys
  from summary
  left join listed_accounts as listed on true
  order by listed.latest_activity_at desc nulls last, listed.account_id;

  perform set_config(
    'app.operator_overview_capability',
    coalesce(previous_capability, ''),
    true
  );
  perform set_config(
    'app.account_id',
    coalesce(previous_account_id, ''),
    true
  );
exception
  when others then
    perform set_config(
      'app.operator_overview_capability',
      coalesce(previous_capability, ''),
      true
    );
    perform set_config(
      'app.account_id',
      coalesce(previous_account_id, ''),
      true
    );
    raise;
end;
$$;

revoke all on function apollo_platform.admin_account_overview(
  uuid,
  timestamptz,
  integer
) from public;

grant execute on function apollo_platform.admin_account_overview(
  uuid,
  timestamptz,
  integer
) to apollo_platform_runtime;
