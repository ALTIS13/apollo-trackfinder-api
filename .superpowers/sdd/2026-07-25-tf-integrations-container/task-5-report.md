# Task 5: TF API Gateway And Public Route Migration

## Result

Task 5 migrates the public Spotify and Yandex routes to the private
`tf-integrations` command gateway while preserving `tf-api` as the only
public session, entitlement/policy, CSRF, OAuth-state, callback, and response
boundary. The implementation consumes the committed
`@workspace/tf-integrations-contract` schemas through one
`TfIntegrationsGateway.execute` method. No Task 6 deployment work is included.

Base commit: `bc577c30ea04a2547034ed80e5141a4db70750bb`

## TDD Evidence

### Internal client

RED:

```powershell
pnpm --dir artifacts/api-server test -- src/lib/tf-integrations-client.test.ts
```

The first valid RED run failed because
`src/lib/tf-integrations-client.ts` did not exist. The six brief-mandated
tests had already been written and loaded the committed contract source.

GREEN:

```text
Test Files  1 passed (1)
Tests       6 passed (6)
```

The implementation proves:

- a distinct file-backed integrations command secret and exact origin;
- private-host-only HTTP with the explicit local-development flag;
- HMAC over the exact raw command bytes with fresh timestamp, nonce, and
  request ID;
- `POST /v1/commands`, `Accept: application/json`,
  `Accept-Encoding: identity`, `redirect: "error"`, and a 10-second abort;
- a 1 MiB bounded streaming response reader;
- rejection of non-200, oversized, malformed, uncorrelated, wrong-operation,
  wrong-provider, wrong-account, and wrong-request responses;
- one sanitized `integrations_unavailable` result for transport and protocol
  failures without command, token, code, or upstream-body leakage.

### Spotify route migration

RED:

```powershell
pnpm --dir artifacts/api-server test -- src/routes/spotify.test.ts
```

Against the direct-provider route, all six rewritten gateway-contract tests
failed: authorization did not dispatch the command, callback completion still
used direct token exchange/storage, account-bound operations did not reach the
gateway, and provider fetch/token-store behavior remained.

GREEN:

```text
Test Files  1 passed (1)
Tests       6 passed (6)
```

The route now:

- issues API-owned Spotify state before the authorize command;
- consumes state before callback completion;
- never dispatches denied, missing, invalid, or replayed callbacks;
- derives every command account only from `request.tfPrincipal.accountId`;
- preserves connected/disconnected, logout, library, error, and callback
  redirect shapes;
- implements liked-all using bounded 50-item liked-list commands and preserves
  already-fetched partial results if a later page fails;
- contains no Spotify credentials, provider fetch, refresh logic, or provider
  token-store access.

### Yandex route migration

RED:

```powershell
pnpm --dir artifacts/api-server test -- src/routes/yandex.test.ts
```

Against the direct-provider route, all five rewritten tests failed because
operations did not dispatch through the gateway and the route still imported
provider token-table/fetch behavior.

An intermediate run after route migration produced four passing tests and one
expected wiring failure (`503`) because the app router had not yet injected the
shared gateway.

GREEN after runtime wiring:

```text
Test Files  1 passed (1)
Tests       5 passed (5)
```

The existing server-managed `POST /api/yandex/token` remains available behind
policy and CSRF. Browser-managed onboarding was not added. The route keeps the
existing public keys and status/error mappings while dispatching the frozen
contract's `yandex.connect` command. Because the reviewed result schema exposes
`id` and `displayName`, not a provider login, the nullable public `login` key is
retained as `null` rather than fabricating an identifier.

### Authorization and dispatch ledger

RED:

```powershell
pnpm --dir artifacts/api-server test -- src/app-auth-boundary.test.ts
```

The two new valid-control cases initially failed because no shared integrations
gateway was wired. The blocked cases already established zero dispatch.

GREEN:

```text
Test Files  1 passed (1)
Tests       8 passed (8)
```

The ledger covers all applicable Spotify and Yandex provider operations,
including `POST /api/yandex/token`, and proves zero gateway dispatch for:

- missing session;
- missing Platform capability;
- suspended account;
- Platform policy outage;
- CSRF failure on unsafe operations.

Valid Spotify and Yandex controls prove the same injected gateway is reached
only after those boundaries. Route tests separately prove query/body account
aliases cannot override the principal account.

### Readiness

`src/index.smoke.test.ts` proves startup constructs the integrations client
while `/readyz` remains based only on database and Redis readiness. Integration
or provider availability is not probed by API readiness.

## Implementation Notes

`HttpTfIntegrationsClient` follows the reviewed search-client transport
patterns without weakening limits: exact-origin validation, bounded streaming,
raw-byte HMAC, nonce/timestamp/request ID headers, redirect rejection, and the
10-second abort.

`src/index.ts` parses the integrations client configuration once and injects
one gateway into both routers. The command secret is loaded from
`TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE`, separate from the search command
secret.

The Spotify and Yandex runtime modules now perform only public input parsing,
API-owned state handling, command dispatch, and browser-response mapping.
Legacy database tables and migrations remain unchanged and unused.

## Compatibility And Build Changes

### `src/app-error.test.ts`

The former fixture injected a rejected Yandex token-store query. That
dependency no longer exists after the route migration, so retaining the
fixture would test an unreachable runtime path and fail type compatibility.
It now injects a rejected gateway operation and verifies the existing
disconnected public response plus response/log/stderr canary sanitization.

### `src/routes/auth.test.ts` and `src/routes/module-heartbeats.test.ts`

Both files dynamically imported the production app inside individual tests.
With the larger dependency graph and the full suite's eight parallel workers,
cold imports intermittently exceeded Vitest's five-second per-test timeout
even though each focused file passed. The import is now performed once in
`beforeAll`; no production behavior or timeout was changed.

### `tsconfig.json`

The API now imports the committed `tf-integrations-contract` package. Its
TypeScript project reference is required so typecheck treats that package as a
referenced workspace project rather than reporting a `rootDir`/project-source
boundary error.

### `package.json` and `pnpm-lock.yaml`

The contract is an explicit API workspace dependency. The corresponding
lockfile importer entry is required for the mandated frozen offline install.

### `build.mjs`

The initial production build still contained `spotifyTokensTable` and
`yandexTokensTable` even after all route imports were removed. The cause was
the broad `@workspace/db/schema` barrel imported by shared database setup.
The API build now resolves that barrel to only the four schema modules used by
the API (`trackCache`, `playHistory`, `likedTracks`, and `playlists`). This
keeps legacy schema and migrations intact while preventing provider token
tables from entering the API runtime bundle.

### `Dockerfile`

Only workspace metadata and the committed integrations contract package are
added to the API image build context. No integrations image, Compose service,
smoke deployment, DNS, Coolify, Caddy, UFW, remote, or Android work is present.

## Final Verification

Commands:

```powershell
pnpm install --offline --frozen-lockfile
pnpm --dir artifacts/api-server test -- src/lib/tf-integrations-client.test.ts src/routes/spotify.test.ts src/routes/yandex.test.ts src/app-auth-boundary.test.ts src/index.smoke.test.ts
pnpm --dir artifacts/api-server test
pnpm --dir artifacts/api-server typecheck
pnpm --dir artifacts/api-server build
rg -n "SPOTIFY_CLIENT_SECRET|spotifyTokensTable|yandexTokensTable" artifacts/api-server/src artifacts/api-server/dist
git diff --check
```

Results:

- frozen offline install: passed for all 21 workspace projects;
- focused client/routes/auth/readiness set: 5 files, 26 passed;
- full API suite: 26 files, 373 passed, 2 skipped;
- API typecheck: passed;
- API build: passed;
- required source/dist provider-secret and token-table scan: no matches;
- broader route/dist direct-provider endpoint, provider credential,
  token-store, and direct-fetch scan: no runtime matches;
- legacy migration diff: unchanged;
- Task 6 deployment-scope diff scan: no files;
- whitespace/error diff check: passed.

The final focused command's first eight-worker invocation experienced one
Vitest worker-process exit before a test file ran (22 tests passed and no
assertion failed). An immediate single-worker isolation run passed all 26
focused tests, and the subsequent mandated full suite passed all 26 files
under the normal eight-worker configuration. No timeout, runner, or production
setting was relaxed.

## Self-Review

- Policy and capability checks precede provider dispatch.
- CSRF checks precede unsafe provider dispatch.
- Account IDs come only from `request.tfPrincipal`.
- Spotify state is issued before authorize and consumed before completion.
- Invalid and denied callbacks never dispatch.
- Client response correlation covers request, account, operation, and provider.
- Transport and gateway errors remain sanitized at the public boundary.
- Public statuses, payload keys, logout/library results, and callback redirects
  remain compatible.
- API readiness remains independent of integrations/provider availability.
- API source and bundle contain no provider client secret or provider
  token-table runtime use.
- Legacy database migrations are untouched.
- Task 6 deployment work was not started.

## Review Fix Round 1 Of 5

Review status: all six Important findings addressed. The two Minor findings
about `index.ts` wiring mutation coverage and `beforeAll` cold-import budgets
remain deferred as directed.

This section supersedes three conclusions above: API startup DDL still owned
legacy provider-token tables, failed status operations were incorrectly mapped
to disconnection, and connected Yandex responses incorrectly emitted a null
`login`.

### 1. Remove Legacy Provider-Token Tables From API Runtime

Tests were added first:

- `src/lib/migrate.test.ts` captures the startup SQL and rejects provider-token
  table or credential-column identifiers while retaining API-owned DDL.
- `src/build-runtime-boundary.test.ts` performs a real production build and
  scans every emitted file for snake_case and camelCase provider-token
  identifiers and the Spotify client-secret identifier.

RED:

```powershell
pnpm --dir artifacts/api-server test -- src/lib/migrate.test.ts src/build-runtime-boundary.test.ts
```

```text
Test Files  2 failed (2)
Tests       2 failed (2)
```

Both failures identified `spotify_tokens` in the startup SQL and fresh bundle.

Production change: removed only the obsolete provider-token `CREATE TABLE`
blocks from `src/lib/migrate.ts`. `runMigrations` remains for API-owned tables.
No `DROP`, delete, data migration, automatic import, or legacy schema/migration
change was added, so deployed provider tables and their data remain untouched.

GREEN:

```text
Test Files  2 passed (2)
Tests       2 passed (2)
```

### 2. Reject Equal Internal Command Secrets

The test supplies separate secret canaries, proves distinct values compose,
then proves equality fails with only `invalid runtime configuration`.

RED:

```powershell
pnpm --dir artifacts/api-server test -- src/lib/tf-integrations-client.test.ts
```

```text
Test Files  1 failed (1)
Tests       1 failed | 6 passed (7)
```

The failure showed the equality guard did not exist.

Production change: `assertDistinctTfCommandSecrets` compares the parsed secret
bytes with `timingSafeEqual` and is called immediately after integrations and
search config parsing, before Redis, database, listener, or gateway setup.
Errors contain neither secret.

GREEN:

```text
Test Files  1 passed (1)
Tests       7 passed (7)
```

### 3. Correlate Spotify Authorization Redirects

The route test substitutes each security-relevant component independently:
state, callback URI, origin, and path.

RED:

```powershell
pnpm --dir artifacts/api-server test -- src/routes/spotify.test.ts
```

```text
Test Files  1 failed (1)
Tests       1 failed | 6 passed (7)
```

The first substituted-state URL was blindly returned as a `302`.

Production change: the route parses the returned URL and requires Spotify's
exact `https://accounts.spotify.com/authorize` destination, no credentials or
fragment, exactly one state and callback parameter, and exact equality with
the API-issued state and API-derived callback URI. A mismatch returns the
existing sanitized `503 {"error":"spotify_unavailable"}`.

GREEN:

```text
Test Files  1 passed (1)
Tests       7 passed (7)
```

### 4. Preserve Status Outage Semantics

### 5. Preserve Connected Yandex Login Compatibility

These related response-boundary tests were written and run together. They
prove:

- only a valid disconnected success summary returns `200 connected:false`;
- typed gateway error results and integrations transport failures return the
  existing provider-specific `503` body;
- unexpected rejected operations reach the terminal sanitized
  `500 {"error":"internal_error"}` boundary without canary leakage;
- connected Yandex token acceptance and status responses retain a string
  `login`.

RED:

```powershell
pnpm --dir artifacts/api-server test -- src/routes/spotify.test.ts src/routes/yandex.test.ts src/app-error.test.ts
```

```text
Test Files  3 failed (3)
Tests       5 failed | 17 passed (22)
```

The failures were the two masked status outages, both null Yandex login
responses, and the terminal-error fixture still receiving disconnected
success.

Production change: Spotify and Yandex status routes distinguish successful
disconnected summaries from failures. `TfIntegrationsUnavailableError` and
contract error results map to `spotify_unavailable`/`yandex_unavailable` with
status 503; unexpected errors are rethrown to the terminal sanitizer. Yandex
uses the contract-validated account display name for the public `login`
string, never the provider account ID. A separate Yandex test explicitly
accepts a validated disconnected summary as `200 {"connected":false}`.

GREEN:

```text
Test Files  3 passed (3)
Tests       22 passed (22)
```

### 6. Cancel Non-200 Internal Response Bodies

The test creates a `503` response body that emits a private canary and never
closes, then checks body cancellation, sanitized failure, and zero retained
timers.

RED:

```powershell
pnpm --dir artifacts/api-server test -- src/lib/tf-integrations-client.test.ts
```

```text
Test Files  1 failed (1)
Tests       1 failed | 7 passed (8)
```

The body cancellation callback had zero calls.

Production change: non-200 responses now receive best-effort awaited body
cancellation before the sanitized availability error is raised. The existing
`finally` clears the 10-second abort timer afterward. Cancellation errors do
not expose internal response details.

GREEN:

```text
Test Files  1 passed (1)
Tests       8 passed (8)
```

### Covering Focused Run

```powershell
pnpm --dir artifacts/api-server test -- src/lib/migrate.test.ts src/build-runtime-boundary.test.ts src/lib/tf-integrations-client.test.ts src/routes/spotify.test.ts src/routes/yandex.test.ts src/app-error.test.ts src/app-auth-boundary.test.ts src/index.smoke.test.ts
```

```text
Test Files  8 passed (8)
Tests       42 passed (42)
```

This reruns the policy/CSRF zero-dispatch ledger and readiness independence
alongside all six fixes.

### Round 1 Final Verification

```powershell
pnpm install --offline --frozen-lockfile
pnpm --dir artifacts/api-server test
pnpm --dir artifacts/api-server typecheck
pnpm --dir artifacts/api-server build
rg -n "spotify_tokens|yandex_tokens|oauth_token|refresh_token|spotifyTokensTable|yandexTokensTable|SPOTIFY_CLIENT_SECRET" artifacts/api-server/src artifacts/api-server/dist
git diff --check
```

Results:

- frozen offline install: passed for all 21 workspace projects;
- full API suite: 28 files passed, 379 tests passed, 2 skipped;
- API typecheck: passed;
- API production build: passed;
- expanded source/dist provider-token and credential scan: no matches;
- direct Spotify/Yandex provider route fetch/endpoint/token-store scan:
  no matches;
- legacy `lib/db` schema and migrations: unchanged;
- Task 6 deployment/infra scope scan: no files;
- diff whitespace/error check: passed.

The first full-suite run had 378 passing tests and one test-only timeout:
the new production-bundle boundary test completed its child build just beyond
Vitest's default five-second limit under eight-worker load. That one test now
has a bounded 15-second budget and the normal full suite passes. No deferred
cold-import budget, application timeout, or production transport timeout was
changed.

Round 1 self-review:

- API startup DDL has no provider-token table ownership and performs no
  destructive or import operation against deployed legacy tables.
- integrations and search command secrets are distinct by value, not only by
  file path, before runtime resources initialize.
- Spotify authorize redirects are fixed-destination and correlated to the
  API-owned state and callback.
- OAuth state issue/consume ordering is unchanged.
- policy, capability, CSRF, and principal-account ordering is unchanged.
- valid disconnected status remains distinct from provider/storage outage.
- unexpected status errors retain terminal canary sanitization.
- connected Yandex public `login` remains a validated string without using
  provider account IDs.
- non-200 internal response bodies are canceled before the abort deadline is
  cleared.
- no Task 6 or deferred Minor work was started.
