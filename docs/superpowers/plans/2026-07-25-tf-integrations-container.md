# Apollo TF Integrations Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Spotify/Yandex provider-account operations into a separately deployable, encrypted, least-privilege `tf-integrations` application while preserving the authenticated Apollo TF browser API.

**Architecture:** `tf-api` remains the public cookie, CSRF, Platform policy, OAuth-state, and redirect boundary. It sends account-bound HMAC-signed commands to `tf-integrations`, which owns provider credentials, encrypted provider-token persistence, fixed provider egress, response normalization, readiness, and `account-integrations` heartbeats. The module, migrator, and dedicated PostgreSQL service use isolated Compose networks and file-backed secrets.

**Tech Stack:** TypeScript 5.9, Node.js 20, Express 5, Zod 3, PostgreSQL 16 with `pg`, AES-256-GCM from `node:crypto`, Pino, Vitest 4, Docker Compose, pnpm 10.33.2.

## Global Constraints

- The binding design is `docs/superpowers/specs/2026-07-25-tf-integrations-container-design.md`.
- `tf-api` derives canonical `accountId` from `request.tfPrincipal`; public input never chooses it.
- `tf-api` owns browser cookies, CSRF, live `tf.integrations` policy checks, Spotify OAuth state, and browser redirects.
- `tf-integrations` owns provider credentials, provider-token encryption/persistence/refresh, all Spotify/Yandex upstream calls, and normalized provider results.
- Provider tokens use AES-256-GCM with a fresh 96-bit nonce and associated data binding envelope version, provider, and canonical account ID.
- The integration database, migrator, runtime role, credentials, and networks are separate from the TF application database.
- Legacy TF `spotify_tokens` and `yandex_tokens` remain untouched and unused; no automatic migration is implemented.
- Internal commands use exact `POST /v1/commands`, strict JSON schemas, canonical UUID request/account IDs, existing raw-body HMAC headers, 60-second skew, replay rejection, and request/operation correlation.
- Command and heartbeat HMAC secrets are separate file-backed values.
- The module has no public host port and receives no browser, session, entitlement, Platform, TF database, Redis, Docker, SSH, Coolify, Caddy, or control-plane credential.
- Same-node HTTP is allowed only with an explicit local flag and a private service hostname. Otherwise the integration origin must be an exact HTTPS origin with redirects disabled and normal CA/SAN/hostname validation.
- Provider outage does not fail `/readyz`. Database/configuration/migration failure does.
- Heartbeats use module ID `account-integrations`, send immediately and every 30 seconds, and rely on the existing 90-second API freshness rule.
- The current public Spotify/Yandex status, logout, library, callback redirect, and error shapes remain compatible.
- Browser-managed Yandex onboarding remains disabled. `POST /api/yandex/token` is retained only as the existing policy/CSRF-protected server route.
- Provider tokens, OAuth codes, credentials, HMAC values, bodies, raw upstream responses, database URLs, and private inventory never appear in logs, errors, rendered Compose, command output, or committed files.
- HomeNode, Coolify, Caddy, UFW, DNS, Android, remote deployment, cross-node ingress, and `tf-download-worker` are not changed.
- Every production behavior follows RED -> verify RED -> GREEN -> verify GREEN -> refactor. Do not write production code before its covering failing test.

## File Structure

### Shared command contract

- `lib/tf-integrations-contract/src/index.ts`: strict command, success, error, and normalized provider schemas.
- `lib/tf-integrations-contract/src/index.test.ts`: schema bounds, strictness, correlation, and secret-exclusion tests.
- `lib/tf-integrations-contract/package.json`, `tsconfig.json`: workspace package configuration.

### Integration persistence

- `lib/tf-integrations-db/migrations/0001_integrations.sql`: immutable migration history and encrypted provider-account table.
- `lib/tf-integrations-db/src/migrations.ts`: migration manifest/checksum runner.
- `lib/tf-integrations-db/src/repository.ts`: parameterized provider-account repository and readiness probe.
- `lib/tf-integrations-db/src/*.test.ts`: migration, repository, and optional real-PostgreSQL integration tests.
- `lib/tf-integrations-db/package.json`, `tsconfig.json`: `pg`-based package.

### Integration runtime

- `artifacts/tf-integrations/src/token-keyring.ts`: strict keyring loading and AES-256-GCM token vault.
- `artifacts/tf-integrations/src/providers/spotify.ts`: fixed Spotify Accounts/Web API adapter.
- `artifacts/tf-integrations/src/providers/yandex.ts`: fixed Yandex Music adapter.
- `artifacts/tf-integrations/src/service.ts`: account-bound command orchestration and encrypted persistence.
- `artifacts/tf-integrations/src/internal-auth.ts`: signed raw-body verification and replay cache.
- `artifacts/tf-integrations/src/app.ts`: `/healthz`, `/readyz`, and `/v1/commands`.
- `artifacts/tf-integrations/src/config.ts`: strict file-backed runtime configuration.
- `artifacts/tf-integrations/src/heartbeat.ts`: immediate/30-second signed heartbeat.
- `artifacts/tf-integrations/src/index.ts`, `migrate.ts`, `logger.ts`: runtime and one-shot migration entrypoints.
- `artifacts/tf-integrations/src/*.test.ts`: focused TDD tests.
- `artifacts/tf-integrations/package.json`, `tsconfig.json`, `build.mjs`, `Dockerfile`, `container/*`: build and hardened runtime.

### TF API migration

- `artifacts/api-server/src/lib/tf-integrations-client.ts`: strict HMAC client and configuration parser.
- `artifacts/api-server/src/lib/tf-integrations-client.test.ts`: transport, response bounds, and correlation tests.
- `artifacts/api-server/src/routes/spotify.ts`, `spotify.test.ts`: public Spotify adapter over the internal gateway.
- `artifacts/api-server/src/routes/yandex.ts`, `yandex.test.ts`: public Yandex adapter over the internal gateway.
- `artifacts/api-server/src/routes/index.ts`, `src/index.ts`: runtime dependency wiring.
- `artifacts/api-server/package.json`, `build.mjs`, `Dockerfile`: contract dependency and build closure.

### Deployment and evidence

- `docker-compose.yml` and `artifacts/api-server/docker-compose.yml`: isolated integration services, networks, migrations, and secrets.
- `artifacts/tf-integrations/src/deployment-contract.test.ts`: root/nested Compose least-privilege assertions.
- `artifacts/tf-integrations/src/smoke.test.ts`: disposable real-container command/heartbeat smoke.
- `MODULES.md`, `IMPLEMENTATION_STATUS.md`: final architecture and validation record.

---

### Task 1: Strict TF Integrations Command Contract

**Files:**

- Create: `lib/tf-integrations-contract/package.json`
- Create: `lib/tf-integrations-contract/tsconfig.json`
- Create: `lib/tf-integrations-contract/src/index.ts`
- Create: `lib/tf-integrations-contract/src/index.test.ts`
- Modify: `tsconfig.json`

**Interfaces:**

- Produces `TF_INTEGRATIONS_COMMAND_PATH = "/v1/commands"`.
- Produces `tfIntegrationsCommandSchema`, `tfIntegrationsSuccessResponseSchema`, and `tfIntegrationsErrorResponseSchema`.
- Produces inferred `TfIntegrationsCommand`, `TfIntegrationsSuccessResponse`, `TfIntegrationsErrorResponse`, normalized track/playlist/account-summary types, and `TfIntegrationOperation`.
- Every command/result uses `schemaVersion: 1`, canonical lowercase UUID `requestId`, canonical lowercase UUID `accountId`, exact operation, and strict operation-specific `input`/`result`.

- [ ] **Step 1: Write failing contract tests**

Add tests with these exact behavioral names:

```ts
it("accepts every documented operation with canonical account and request IDs");
it(
  "rejects unknown keys, noncanonical UUID aliases, and mismatched operation payloads",
);
it(
  "bounds provider codes, tokens, state, callback URI, identifiers, offsets, limits, and arrays",
);
it("accepts only the exact HTTPS TF Spotify callback URI shape");
it(
  "correlates success and error responses by schema version, request ID, and operation",
);
it(
  "cannot serialize provider tokens or credentials in any success or error result",
);
```

The callback schema accepts only an exact HTTPS URL whose pathname is
`/api/spotify/callback`, with no credentials, query, or fragment. Operation
schemas must use a discriminated union, not a permissive record.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
pnpm --dir lib/tf-integrations-contract test
```

Expected: FAIL because the package and exported schemas do not exist.

- [ ] **Step 3: Implement the contract**

Use these operation literals:

```ts
type TfIntegrationOperation =
  | "spotify.oauth.authorize"
  | "spotify.oauth.complete"
  | "spotify.status"
  | "spotify.disconnect"
  | "spotify.liked.list"
  | "spotify.playlists.list"
  | "spotify.playlist-tracks.list"
  | "spotify.top-tracks.list"
  | "yandex.token.upsert"
  | "yandex.status"
  | "yandex.disconnect"
  | "yandex.liked.list"
  | "yandex.playlists.list"
  | "yandex.playlist-tracks.list";
```

Define normalized tracks with bounded ID/title/artist/album/duration/HTTPS
thumbnail and provider URL fields. Define Spotify playlists with
`id/name/description/trackCount/thumbnailUrl/owner`; define Yandex playlists
with `uid/kind/title/description/trackCount/thumbnailUrl/owner`. Use
`z.object(...).strict()` at every object boundary and array limits that keep one
response below 1 MiB.

- [ ] **Step 4: Verify GREEN and workspace typecheck**

Run:

```powershell
pnpm --dir lib/tf-integrations-contract test
pnpm --dir lib/tf-integrations-contract typecheck
pnpm run typecheck:libs
```

Expected: all contract tests and library typechecks pass.

- [ ] **Step 5: Commit**

```powershell
git add lib/tf-integrations-contract tsconfig.json
git commit -m "feat(tf-integrations): define signed command contract"
```

---

### Task 2: Encrypted Provider Account Store

**Files:**

- Create: `lib/tf-integrations-db/package.json`
- Create: `lib/tf-integrations-db/tsconfig.json`
- Create: `lib/tf-integrations-db/migrations/0001_integrations.sql`
- Create: `lib/tf-integrations-db/src/index.ts`
- Create: `lib/tf-integrations-db/src/migrations.ts`
- Create: `lib/tf-integrations-db/src/migrations.test.ts`
- Create: `lib/tf-integrations-db/src/migration-manifest.test.ts`
- Create: `lib/tf-integrations-db/src/repository.ts`
- Create: `lib/tf-integrations-db/src/repository.test.ts`
- Create: `lib/tf-integrations-db/src/integration.test.ts`
- Create: `artifacts/tf-integrations/package.json`
- Create: `artifacts/tf-integrations/tsconfig.json`
- Create: `artifacts/tf-integrations/src/token-keyring.ts`
- Create: `artifacts/tf-integrations/src/token-keyring.test.ts`
- Modify: `tsconfig.json`

**Interfaces:**

- Produces `EncryptedTokenEnvelopeV1`, `ProviderAccountRecord`, `ProviderAccountRepository`, `PostgresProviderAccountRepository`, `createIntegrationsPool`, `runIntegrationsMigrations`, and `probeIntegrationsDatabase`.
- Produces `parseProviderTokenKeyring(raw: string)` and `ProviderTokenVault.encrypt/decrypt`.
- Repository methods are `get(accountId, provider)`, `upsert(record)`, `delete(accountId, provider)`, and `isMigrationCurrent()`.

- [ ] **Step 1: Write failing keyring and encryption tests**

Add tests named:

```ts
it("loads one to four strict 32-byte base64url keys and one active key");
it("rejects duplicate, unknown, oversized, padded, or missing key material");
it(
  "encrypts with a fresh 96-bit nonce and decrypts for the same provider account",
);
it(
  "rejects ciphertext tampering, provider substitution, account substitution, and unknown keys",
);
it("reads an old-key envelope and rewrites with the active key");
it("never exposes plaintext tokens or key bytes through thrown errors");
```

Use random canaries and assert that serialized envelopes and error messages do
not contain them.

- [ ] **Step 2: Run keyring tests and verify RED**

Run:

```powershell
pnpm --dir artifacts/tf-integrations test -- src/token-keyring.test.ts
```

Expected: FAIL because the token vault does not exist.

- [ ] **Step 3: Implement the token vault**

Use `aes-256-gcm`, a fresh `randomBytes(12)` nonce, a 16-byte authentication
tag, and associated data:

```text
apollo-tf-integrations-token:v1:<provider>:<canonical-account-id>
```

Encode nonce, ciphertext, and tag with unpadded base64url. The decrypted
plaintext is strict bounded JSON:

```ts
type SpotifySecret = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

type YandexSecret = {
  oauthToken: string;
};
```

- [ ] **Step 4: Write failing migration and repository tests**

Add tests named:

```ts
it("applies immutable numbered migrations once and rejects checksum drift");
it(
  "creates only integrations migration history and encrypted provider account tables",
);
it("uses parameterized SQL and never sends a plaintext token parameter");
it("maps one canonical account-provider row and updates metadata atomically");
it("deletes only the requested account-provider row");
it("reports readiness only when the expected migration is recorded");
it("persists no plaintext canary in a disposable PostgreSQL database");
```

The SQL table stores `token_envelope JSONB`, not token columns. It has a
provider check constraint, canonical UUID `account_id`, bounded metadata, unique
`(account_id, provider)`, and timestamps.

- [ ] **Step 5: Run repository tests and verify RED**

Run:

```powershell
pnpm --dir lib/tf-integrations-db test
```

Expected: FAIL because migrations and repository do not exist.

- [ ] **Step 6: Implement migrations and repository**

Follow `lib/platform-db/src/migrations.ts` for manifest ordering, advisory
locking, checksums, immutable history, and transaction behavior. The runtime
repository never runs migrations. Map PostgreSQL constraint/availability errors
to stable storage errors without including SQL, parameters, or connection
details.

- [ ] **Step 7: Verify GREEN**

Run:

```powershell
pnpm --dir artifacts/tf-integrations test -- src/token-keyring.test.ts
pnpm --dir lib/tf-integrations-db test
pnpm --dir lib/tf-integrations-db typecheck
pnpm --dir artifacts/tf-integrations typecheck
```

Expected: unit tests pass; the real PostgreSQL test is gated when its dedicated
test URL is absent and passes when the disposable test database is supplied.

- [ ] **Step 8: Commit**

```powershell
git add lib/tf-integrations-db artifacts/tf-integrations/package.json artifacts/tf-integrations/tsconfig.json artifacts/tf-integrations/src/token-keyring* tsconfig.json
git commit -m "feat(tf-integrations): add encrypted provider store"
```

---

### Task 3: Spotify And Yandex Provider Service

**Files:**

- Create: `artifacts/tf-integrations/src/providers/spotify.ts`
- Create: `artifacts/tf-integrations/src/providers/spotify.test.ts`
- Create: `artifacts/tf-integrations/src/providers/yandex.ts`
- Create: `artifacts/tf-integrations/src/providers/yandex.test.ts`
- Create: `artifacts/tf-integrations/src/service.ts`
- Create: `artifacts/tf-integrations/src/service.test.ts`
- Create: `artifacts/tf-integrations/src/logger.ts`

**Interfaces:**

- Consumes Task 1 commands/results and Task 2 repository/token vault.
- Produces `SpotifyProvider`, `YandexProvider`, `TfIntegrationsService`, and `execute(command)`.
- Provider adapters accept only typed operation inputs; callers cannot supply arbitrary URL, method, headers, or provider path.

- [ ] **Step 1: Write failing Spotify adapter tests**

Add tests named:

```ts
it(
  "builds the fixed authorization URL with existing read scopes and exact callback",
);
it("exchanges a bounded code and requires access, refresh, and expiry values");
it(
  "refreshes within 60 seconds of expiry and preserves a missing replacement refresh token",
);
it("calls only fixed Spotify HTTPS endpoints with bounded query values");
it(
  "strictly validates and normalizes liked tracks, playlists, playlist tracks, and top tracks",
);
it(
  "returns stable provider errors without raw body, token, code, URL query, or credentials",
);
```

Use a recording `fetch` implementation and provider canaries. Assert
`redirect: "error"` for every provider request.

- [ ] **Step 2: Verify Spotify RED, implement, and verify GREEN**

Run before implementation:

```powershell
pnpm --dir artifacts/tf-integrations test -- src/providers/spotify.test.ts
```

Expected: FAIL because the adapter is missing.

Implement fixed origins `https://accounts.spotify.com` and
`https://api.spotify.com`; then rerun the same command and expect PASS.

- [ ] **Step 3: Write failing Yandex adapter tests**

Add tests named:

```ts
it("validates a token only through the fixed account status endpoint");
it("uses fixed Yandex Music headers and HTTPS endpoint templates");
it("bounds liked pagination and fetches only the requested track detail page");
it("strictly validates and normalizes playlists and playlist tracks");
it(
  "returns stable provider errors without token, raw response, or private path values",
);
```

- [ ] **Step 4: Verify Yandex RED, implement, and verify GREEN**

Run before implementation:

```powershell
pnpm --dir artifacts/tf-integrations test -- src/providers/yandex.test.ts
```

Expected: FAIL because the adapter is missing. Implement only fixed
`https://api.music.yandex.net` endpoint templates and rerun for PASS.

- [ ] **Step 5: Write failing service tests**

Add tests named:

```ts
it("stores Spotify exchange tokens encrypted and returns only account summary");
it("refreshes and persists Spotify tokens before a library result");
it("returns disconnected without a stored provider account");
it("disconnects only the signed command account");
it("validates and encrypts a Yandex legacy token before returning summary");
it("routes every documented operation and rejects operation/result mismatches");
it(
  "never logs or returns token, code, credential, envelope key, or provider body canaries",
);
```

- [ ] **Step 6: Verify service RED, implement, and verify GREEN**

Run:

```powershell
pnpm --dir artifacts/tf-integrations test -- src/service.test.ts
```

Expected before implementation: FAIL because the service is missing.

Implement exhaustive operation dispatch. Decrypt only after repository lookup,
zero avoidable temporary buffers after use, persist refresh before returning,
and convert storage/provider failures to Task 1 error codes. Rerun provider and
service tests for PASS.

- [ ] **Step 7: Typecheck and commit**

```powershell
pnpm --dir artifacts/tf-integrations test -- src/providers src/service.test.ts
pnpm --dir artifacts/tf-integrations typecheck
git add artifacts/tf-integrations/src/providers artifacts/tf-integrations/src/service* artifacts/tf-integrations/src/logger.ts
git commit -m "feat(tf-integrations): implement provider account service"
```

---

### Task 4: Authenticated Runtime, Readiness, And Heartbeat

**Files:**

- Create: `artifacts/tf-integrations/src/internal-auth.ts`
- Create: `artifacts/tf-integrations/src/internal-auth.test.ts`
- Create: `artifacts/tf-integrations/src/config.ts`
- Create: `artifacts/tf-integrations/src/config.test.ts`
- Create: `artifacts/tf-integrations/src/app.ts`
- Create: `artifacts/tf-integrations/src/app.test.ts`
- Create: `artifacts/tf-integrations/src/heartbeat.ts`
- Create: `artifacts/tf-integrations/src/heartbeat.test.ts`
- Create: `artifacts/tf-integrations/src/index.ts`
- Create: `artifacts/tf-integrations/src/migrate.ts`
- Create: `artifacts/tf-integrations/src/index.smoke.test.ts`
- Create: `artifacts/tf-integrations/build.mjs`

**Interfaces:**

- Consumes Task 3 `TfIntegrationsService.execute`.
- Produces strict runtime `parseTfIntegrationsConfig`, `createTfIntegrationsApp`, and bundled `index.mjs`/`migrate.mjs`.
- Configuration file variables are `TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE`, `TF_INTEGRATIONS_HEARTBEAT_SECRET_FILE`, `TF_INTEGRATIONS_DATABASE_URL_FILE`, `TF_INTEGRATIONS_TOKEN_KEYRING_FILE`, `TF_INTEGRATIONS_SPOTIFY_CLIENT_ID_FILE`, and `TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET_FILE`.
- Exact non-secret variables are `PORT`, `TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI`, `TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN`, `TF_INTEGRATIONS_HEARTBEAT_ALLOW_INSECURE_HTTP`, `APOLLO_API_VERSION`, and optional `APOLLO_DEPLOYED_AT`.

- [ ] **Step 1: Write failing authentication/configuration tests**

Add tests named:

```ts
it("accepts a valid signed raw JSON body once within 60 seconds");
it(
  "rejects replay, stale/future time, malformed nonce/signature, wrong path, and modified body",
);
it("loads every secret from a file and rejects equal command/heartbeat keys");
it(
  "accepts local HTTP only with the explicit flag and a private service hostname",
);
it("requires exact HTTPS callback and cross-node heartbeat origins otherwise");
it("fails closed without database, keyring, or Spotify credential files");
```

- [ ] **Step 2: Verify RED, implement auth/config, verify GREEN**

Run:

```powershell
pnpm --dir artifacts/tf-integrations test -- src/internal-auth.test.ts src/config.test.ts
```

Expected before implementation: FAIL. Reuse the reviewed `tf-search`
canonical authentication and origin rules without weakening limits. Rerun for
PASS.

- [ ] **Step 3: Write failing app and heartbeat tests**

Add tests named:

```ts
it("reports liveness independently from database readiness");
it("reports ready only after current migrations and a bounded database probe");
it(
  "rejects unsupported encoding, non-JSON, oversized, unsigned, replayed, and malformed commands",
);
it("returns a schema-validated correlated success or sanitized internal error");
it("does not make readiness depend on Spotify or Yandex availability");
it(
  "sends account-integrations immediately and every 30 seconds with the separate heartbeat key",
);
it("stops heartbeat timers and closes the pool during graceful shutdown");
```

- [ ] **Step 4: Verify RED, implement app/heartbeat, verify GREEN**

Run:

```powershell
pnpm --dir artifacts/tf-integrations test -- src/app.test.ts src/heartbeat.test.ts
```

Expected before implementation: FAIL. Use a 64 KiB command body limit,
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, case-sensitive
strict routing, and no request-body logging. Rerun for PASS.

- [ ] **Step 5: Write failing startup/bundle tests**

Add tests that spawn the built bundle with temporary secret files and a fake
repository/provider set:

```ts
it("starts only after configuration and migration readiness are established");
it("prints one sanitized startup failure without secret canaries");
it(
  "builds runtime and migrator bundles without source or workspace resolution",
);
```

- [ ] **Step 6: Implement entrypoints and verify**

Build `index` and `migrate` entrypoints with esbuild, externalize runtime
dependencies, handle `SIGTERM`/`SIGINT` once, and close listener, heartbeat,
and pool in order.

Run:

```powershell
pnpm --dir artifacts/tf-integrations test
pnpm --dir artifacts/tf-integrations typecheck
pnpm --dir artifacts/tf-integrations build
```

Expected: all Task 2-4 tests pass and both bundles exist.

- [ ] **Step 7: Commit**

```powershell
git add artifacts/tf-integrations
git commit -m "feat(tf-integrations): add authenticated service runtime"
```

---

### Task 5: TF API Gateway And Public Route Migration

**Files:**

- Create: `artifacts/api-server/src/lib/tf-integrations-client.ts`
- Create: `artifacts/api-server/src/lib/tf-integrations-client.test.ts`
- Modify: `artifacts/api-server/src/routes/spotify.ts`
- Modify: `artifacts/api-server/src/routes/spotify.test.ts`
- Modify: `artifacts/api-server/src/routes/yandex.ts`
- Modify: `artifacts/api-server/src/routes/yandex.test.ts`
- Modify: `artifacts/api-server/src/routes/index.ts`
- Modify: `artifacts/api-server/src/index.ts`
- Modify: `artifacts/api-server/src/index.smoke.test.ts`
- Modify: `artifacts/api-server/src/app-auth-boundary.test.ts`
- Modify: `artifacts/api-server/package.json`
- Modify: `artifacts/api-server/build.mjs`
- Modify: `artifacts/api-server/Dockerfile`

**Interfaces:**

- Consumes Task 1 schemas through `TfIntegrationsGateway.execute`.
- Produces `parseTfIntegrationsClientConfig` and `HttpTfIntegrationsClient`.
- Routes receive one gateway dependency and never receive provider client credentials, provider fetch, or provider token stores.

- [ ] **Step 1: Write failing internal client tests**

Add tests named:

```ts
it("loads a distinct file-backed command secret and exact origin");
it("allows local HTTP only for a private hostname with the explicit flag");
it("signs the exact command bytes with fresh timestamp, nonce, and request ID");
it(
  "uses POST, exact path, JSON identity encoding, redirect error, and a 10 second abort",
);
it(
  "rejects non-200, oversized, malformed, uncorrelated, and wrong-operation responses",
);
it(
  "maps every transport failure to integrations_unavailable without leaking command values",
);
```

- [ ] **Step 2: Verify client RED, implement, and verify GREEN**

Run:

```powershell
pnpm --dir artifacts/api-server test -- src/lib/tf-integrations-client.test.ts
```

Expected before implementation: FAIL because the client is missing. Implement
the same bounded streaming JSON reader and exact-origin rules as the reviewed
search client, using the integration contract. Rerun for PASS.

- [ ] **Step 3: Rewrite Spotify tests before production routes**

Replace provider-fetch/token-store expectations with gateway expectations.
Tests must prove:

```ts
it(
  "issues API-owned state before dispatching the account-bound authorization command",
);
it(
  "consumes state before completion and never dispatches an invalid or denied callback",
);
it("derives accountId only from tfPrincipal for every Spotify command");
it(
  "preserves connected, disconnected, logout, library, and callback redirect shapes",
);
it(
  "implements liked-all through bounded liked-list commands and preserves partial results",
);
it("maps integration errors to existing sanitized public Spotify errors");
```

Run the Spotify tests and verify they fail against the current direct provider
implementation.

- [ ] **Step 4: Rewrite Spotify route over the gateway**

Remove client ID, client secret, provider `fetch`, token parsing/refresh, and DB
token-store code from `spotify.ts`. Keep public parsing, OAuth state, redirect
mapping, and browser response mapping. Run:

```powershell
pnpm --dir artifacts/api-server test -- src/routes/spotify.test.ts
```

Expected: PASS.

- [ ] **Step 5: Rewrite Yandex tests before production routes**

Tests must prove:

```ts
it("derives accountId only from tfPrincipal for every Yandex command");
it(
  "keeps token acceptance behind policy and CSRF and returns the existing public shape",
);
it("preserves status, logout, liked, playlists, and playlist-track shapes");
it("maps integration errors to existing sanitized Yandex errors");
it("never imports or calls the TF provider token tables");
```

Run the Yandex tests and verify RED against the current direct provider code.

- [ ] **Step 6: Rewrite Yandex route over the gateway**

Remove provider `fetch`, token validation, mapping, and DB token-store code from
`yandex.ts`. Keep public validation and public response mapping. Run:

```powershell
pnpm --dir artifacts/api-server test -- src/routes/yandex.test.ts
```

Expected: PASS.

- [ ] **Step 7: Prove policy/CSRF order and runtime wiring**

Add/adjust tests so missing session, missing capability, suspended account,
policy outage, and CSRF failure produce no gateway call. Parse integration
client config at API startup and inject one gateway into both routers. API
readiness continues to check only its Redis/database dependencies, not provider
availability.

Run:

```powershell
pnpm --dir artifacts/api-server test
pnpm --dir artifacts/api-server typecheck
pnpm --dir artifacts/api-server build
rg -n "SPOTIFY_CLIENT_SECRET|spotifyTokensTable|yandexTokensTable" artifacts/api-server/src artifacts/api-server/dist
```

Expected: API tests/typecheck/build pass; the final scan finds no provider
client secret or provider token table use in API source/bundle.

- [ ] **Step 8: Commit**

```powershell
git add artifacts/api-server
git commit -m "feat(tf-api): route provider accounts through integrations"
```

---

### Task 6: Compose Isolation, Images, And Disposable Smoke

**Files:**

- Create: `artifacts/tf-integrations/Dockerfile`
- Create: `artifacts/tf-integrations/container/start-integrations.sh`
- Create: `artifacts/tf-integrations/container/init-roles.sh`
- Create: `artifacts/tf-integrations/src/deployment-contract.test.ts`
- Create: `artifacts/tf-integrations/src/smoke.test.ts`
- Modify: `docker-compose.yml`
- Modify: `artifacts/api-server/docker-compose.yml`
- Modify: `.dockerignore`
- Modify: `pnpm-lock.yaml`
- Modify: `MODULES.md`

**Interfaces:**

- Produces Compose services `tf-integrations-postgres`, `tf-integrations-migrate`, and `tf-integrations`.
- Produces networks `tf-integrations-control`, `tf-integrations-data`, and `tf-integrations-egress`.
- API origin is `http://tf-integrations:8080` only with `TF_INTEGRATIONS_ALLOW_INSECURE_HTTP=true`.
- Heartbeat origin is `http://api:8080` only with `TF_INTEGRATIONS_HEARTBEAT_ALLOW_INSECURE_HTTP=true`.

- [ ] **Step 1: Write failing deployment contract tests**

Parse both Compose files with `yaml` and assert:

```ts
it(
  "defines the same integration service names and images in root and nested Compose",
);
it("publishes no integration module, database, or migrator host port");
it("attaches API and module only to the internal integration control network");
it(
  "attaches module and database/migrator only through the isolated data network",
);
it("attaches only the module to integration egress");
it(
  "mounts command, heartbeat, database, keyring, and Spotify secrets to exact owners",
);
it("passes no provider secret value through environment variables");
it(
  "passes no TF/Platform DB, Redis, browser, Docker, SSH, Caddy, or Coolify credential to the module",
);
it(
  "uses non-root read-only runtime, dropped capabilities, no-new-privileges, init, bounded tmpfs, and health checks",
);
it(
  "keeps migration one-shot and gates readiness on successful migration/database health",
);
```

- [ ] **Step 2: Verify deployment RED**

Run:

```powershell
pnpm --dir artifacts/tf-integrations test -- src/deployment-contract.test.ts
```

Expected: FAIL because services, image, networks, and secrets do not exist.

- [ ] **Step 3: Implement images and Compose**

Follow the platform role-init/migrator pattern and tf-search runtime hardening.
Use PostgreSQL 16 Bookworm, runtime UID/GID `10001:10001`, a read-only app tree,
and file paths under `/run/secrets`. Remove `SPOTIFY_CLIENT_ID` and
`SPOTIFY_CLIENT_SECRET` from API environments. Keep provider availability out
of Compose health checks.

Run:

```powershell
docker compose config --quiet
docker compose -f artifacts/api-server/docker-compose.yml config --quiet
pnpm --dir artifacts/tf-integrations test -- src/deployment-contract.test.ts
```

Expected: both rendered configs and deployment tests pass without warnings.

- [ ] **Step 4: Write failing disposable smoke**

The smoke creates a temporary secret directory with random canaries, renders a
unique Compose project, starts integration PostgreSQL/migrator/module/API
dependencies, and proves:

```ts
it(
  "becomes ready after one-shot migrations and accepts one valid signed command",
);
it(
  "rejects replay, tampered body, wrong key, unsupported encoding, and unsigned command",
);
it("stores a provider-token fixture only as authenticated ciphertext");
it(
  "sends account-integrations heartbeat and recovers after API heartbeat state reset",
);
it("keeps provider outage out of readiness");
it(
  "leaves no secret canary in config, logs, responses, inspect output, or tracked files",
);
it(
  "removes all project containers, images, networks, volumes, and temporary directories",
);
```

Fixture providers are permitted only when
`TF_INTEGRATIONS_SMOKE_FIXTURES=true` and `NODE_ENV=test`; production rejects
that flag.

- [ ] **Step 5: Verify smoke RED, implement, and verify GREEN**

Run before implementation:

```powershell
pnpm --dir artifacts/tf-integrations test -- src/smoke.test.ts
```

Expected: FAIL because the smoke fixture/runtime contract is absent.

Implement bounded smoke orchestration with `try/finally` cleanup and explicit
post-cleanup resource checks. Rerun for PASS.

- [ ] **Step 6: Update module documentation**

Document exact service names, command path, operation list, HMAC variables,
keyring format, encryption/AAD behavior, 30/90-second heartbeat behavior,
network memberships, same-node/cross-node origin rules, no-shared-DB rule, and
the future optional `integrations.tf.apollot.ru` gate. Do not include real
addresses or secret values.

- [ ] **Step 7: Verify and commit**

```powershell
pnpm install --frozen-lockfile
pnpm --dir artifacts/tf-integrations test
pnpm --dir artifacts/tf-integrations typecheck
pnpm --dir artifacts/tf-integrations build
docker compose config --quiet
docker compose -f artifacts/api-server/docker-compose.yml config --quiet
git diff --check
git add artifacts/tf-integrations docker-compose.yml artifacts/api-server/docker-compose.yml .dockerignore pnpm-lock.yaml MODULES.md
git commit -m "feat(tf-integrations): add isolated container stack"
```

---

### Task 7: Integrated Validation And Release Record

**Files:**

- Modify: `IMPLEMENTATION_STATUS.md`
- Modify: `MODULES.md` only if final validation changes an exact operational fact.

**Interfaces:**

- Consumes the complete Task 1-6 branch.
- Produces a durable validation record and names `tf-download-worker` as the next server stage.

- [ ] **Step 1: Run focused and full validation**

Run:

```powershell
pnpm --dir lib/tf-integrations-contract test
pnpm --dir lib/tf-integrations-db test
pnpm --dir artifacts/tf-integrations test
pnpm --dir artifacts/api-server test
pnpm --dir artifacts/tf-search test
pnpm --dir artifacts/music-player test
pnpm run typecheck
pnpm --dir artifacts/tf-integrations build
pnpm --dir artifacts/api-server build
pnpm --dir artifacts/music-player build
docker compose config --quiet
docker compose -f artifacts/api-server/docker-compose.yml config --quiet
git diff --check
```

Expected: every non-gated test passes; only explicitly documented disposable
PostgreSQL/real-container gates may skip when their prerequisites are absent.

- [ ] **Step 2: Run secret and ownership scans**

Use random canaries and scan source, bundles, rendered Compose, container
inspect, logs, responses, and Git diff. Verify:

```text
api has no Spotify client secret or provider-token table dependency
module has no TF/Platform database or Redis credential
no provider token or key canary appears outside bounded process memory
all integration resources have zero host ports
no HomeNode/Coolify/Caddy/UFW/DNS command was executed
```

- [ ] **Step 3: Record exact evidence**

Update `IMPLEMENTATION_STATUS.md` with:

- exact test counts and gated/skipped counts;
- bundle/image/config sizes where available;
- disposable smoke project identifier and zero-residue checks;
- per-task review verdicts and commit ranges;
- DNS propagation confirmation for the eight owner-created records;
- no remote infrastructure mutation;
- next stage `tf-download-worker`, followed by read-only HomeNode/Coolify/Caddy
  preflight and explicit approval before rollout.

- [ ] **Step 4: Commit the release record**

```powershell
git add IMPLEMENTATION_STATUS.md MODULES.md
git commit -m "docs: record tf integrations validation"
```

## Self-Review

- Every design requirement is assigned to Tasks 1-7.
- Contract, encryption/persistence, providers, runtime, API migration,
  deployment, and release evidence have independent test/review boundaries.
- The plan contains no automatic legacy-token migration and no cross-node or
  remote infrastructure mutation.
- The API remains the sole browser/session/policy/OAuth-state boundary.
- The module receives only canonical account IDs and operation-specific signed
  data and owns all provider tokens and credentials.
- Every production step has a preceding named failing test and explicit RED and
  GREEN commands.
