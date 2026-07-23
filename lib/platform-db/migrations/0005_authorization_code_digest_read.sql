create policy authorization_codes_digest_select
  on apollo_platform.authorization_codes
  for select to apollo_platform_runtime
  using (
    code_digest = nullif(
      current_setting('app.authorization_code_digest', true),
      ''
    )
  );
