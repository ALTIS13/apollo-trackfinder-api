alter table apollo_tf_integrations.provider_accounts
  add column provider_login varchar(500);

alter table apollo_tf_integrations.provider_accounts
  add constraint provider_accounts_provider_login_check check (
    (
      provider = 'spotify'
      and provider_login is null
    )
    or (
      provider = 'yandex'
      and (
        provider_login is null
        or char_length(btrim(provider_login)) between 1 and 500
      )
    )
  );
