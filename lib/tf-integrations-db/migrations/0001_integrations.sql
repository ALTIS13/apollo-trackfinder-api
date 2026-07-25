create table apollo_tf_integrations.provider_accounts (
  account_id uuid not null,
  provider text not null,
  token_envelope jsonb not null,
  provider_user_id varchar(512) not null,
  display_name varchar(500) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint provider_accounts_pkey primary key (account_id, provider),
  constraint provider_accounts_provider_check
    check (provider in ('spotify', 'yandex')),
  constraint provider_accounts_token_envelope_check check (
    jsonb_typeof(token_envelope) = 'object'
    and token_envelope = jsonb_build_object(
      'version', token_envelope -> 'version',
      'keyId', token_envelope -> 'keyId',
      'nonce', token_envelope -> 'nonce',
      'ciphertext', token_envelope -> 'ciphertext',
      'tag', token_envelope -> 'tag'
    )
    and token_envelope -> 'version' = '1'::jsonb
    and jsonb_typeof(token_envelope -> 'keyId') = 'string'
    and token_envelope ->> 'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    and jsonb_typeof(token_envelope -> 'nonce') = 'string'
    and token_envelope ->> 'nonce' ~ '^[A-Za-z0-9_-]{16}$'
    and jsonb_typeof(token_envelope -> 'ciphertext') = 'string'
    and char_length(token_envelope ->> 'ciphertext') between 1 and 32768
    and token_envelope ->> 'ciphertext' ~ '^[A-Za-z0-9_-]+$'
    and jsonb_typeof(token_envelope -> 'tag') = 'string'
    and token_envelope ->> 'tag' ~ '^[A-Za-z0-9_-]{22}$'
  ),
  constraint provider_accounts_provider_user_id_check
    check (char_length(btrim(provider_user_id)) between 1 and 512),
  constraint provider_accounts_display_name_check
    check (char_length(btrim(display_name)) between 1 and 500)
);
