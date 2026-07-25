# Apollo TF Integrations Container Design

Date: 2026-07-25
Status: approved follow-up to the reviewed `tf-search` extraction

## Goal

Extract Spotify and Yandex Music account integrations from `tf-api` into an
independently deployable `tf-integrations` application. The module owns provider
credentials, provider-token persistence, refresh, upstream calls, and response
normalization. It must work in the root and nested Docker Compose stacks and
remain deployable as a separate Coolify application on another node.

`tf-api` remains the only public browser, cookie, CSRF, Apollo Platform policy,
OAuth-state, and redirect boundary.

## Binding Decisions

- `tf-api` derives the canonical account ID from `request.tfPrincipal`. Public
  query strings and bodies never choose the command account.
- Spotify OAuth state remains one-time, account-bound, and stored in the TF
  authentication Redis store. `tf-api` issues state before the authorization
  command and consumes it before the completion command.
- `tf-integrations` owns Spotify client credentials and all Spotify/Yandex
  provider tokens. `tf-api` no longer receives Spotify access/refresh tokens and
  no longer reads or writes provider-token tables.
- Provider tokens are encrypted at rest. Plaintext provider tokens may exist
  only in bounded process memory while accepting a protected command or calling
  a provider.
- The integration database is separate from the TF application database and
  uses separate bootstrap, migrator, and runtime credentials.
- The browser API shapes, policy capability `tf.integrations`, CSRF behavior,
  Spotify redirect workflow, and existing Yandex server-side legacy-token route
  remain compatible.
- Browser-managed Yandex onboarding stays disabled in the web client. Adding
  Yandex browser OAuth is a separate feature.
- Existing legacy `spotify_tokens` and `yandex_tokens` tables remain untouched
  and unused. No automatic identity or token migration is allowed. A later
  authenticated, audited, idempotent migration may import explicitly confirmed
  legacy data.
- `tf-integrations` is not a general proxy. Every upstream operation and URL is
  fixed by code.
- Android, HomeNode, Coolify, Caddy, UFW, DNS mutation, and remote deployment
  are outside this local implementation stage.

## Trust Boundaries

### Public boundary

`tf-api` owns:

- Apollo Platform session and live entitlement checks;
- host-only browser cookies and CSRF validation;
- provider OAuth state issuance and consumption;
- public request parsing and public error/redirect mapping;
- creation of signed internal commands from the authenticated account.

### Integration boundary

`tf-integrations` owns:

- Spotify client ID and client secret;
- provider-token validation, encryption, storage, refresh, and revocation;
- Spotify and Yandex Music upstream calls;
- provider response validation and normalization;
- integration-specific database migrations;
- `account-integrations` heartbeat publication.

The module receives only a canonical account ID and operation-specific values in
signed commands. It never receives browser cookies, CSRF tokens, TF session
handles, entitlement snapshots, Platform credentials, TF database credentials,
Redis credentials, Docker socket access, SSH credentials, or control-plane
credentials.

## Internal Command Contract

The only command endpoint is:

```text
POST /v1/commands
```

Requests use a strict discriminated Zod union. Every command includes:

```json
{
  "schemaVersion": 1,
  "requestId": "canonical-uuid",
  "accountId": "canonical-uuid",
  "operation": "provider.operation",
  "input": {}
}
```

The supported operations are:

| Operation                      | Input                                       | Result                                    |
| ------------------------------ | ------------------------------------------- | ----------------------------------------- |
| `spotify.oauth.authorize`      | `state`, exact callback URI                 | exact Spotify authorization URL           |
| `spotify.oauth.complete`       | provider code, exact callback URI           | connected account summary                 |
| `spotify.status`               | empty                                       | disconnected or connected account summary |
| `spotify.disconnect`           | empty                                       | `{ ok: true }`                            |
| `spotify.liked.list`           | offset `0..1000000`, limit `1..50`          | normalized page                           |
| `spotify.playlists.list`       | empty                                       | normalized playlists                      |
| `spotify.playlist-tracks.list` | bounded playlist ID, offset, limit          | normalized page                           |
| `spotify.top-tracks.list`      | `short_term`, `medium_term`, or `long_term` | normalized tracks                         |
| `yandex.token.upsert`          | token `10..8192` characters                 | connected account summary                 |
| `yandex.status`                | empty                                       | disconnected or connected account summary |
| `yandex.disconnect`            | empty                                       | `{ ok: true }`                            |
| `yandex.liked.list`            | offset `0..1000000`, limit `1..50`          | normalized page                           |
| `yandex.playlists.list`        | empty                                       | normalized playlists                      |
| `yandex.playlist-tracks.list`  | positive bounded UID/kind, offset, limit    | normalized page                           |

The API implements the existing `/spotify/liked-all` route by repeatedly
dispatching bounded `spotify.liked.list` commands. This preserves the current
partial-result behavior without allowing an unbounded internal response.

Success responses contain the same `schemaVersion`, `requestId`, and
`operation`. Error responses contain only a stable internal error code:

- `not_connected`
- `provider_rejected`
- `provider_unavailable`
- `storage_unavailable`
- `invalid_provider_response`

No success or error response contains an access token, refresh token, OAuth
token, provider credential, raw upstream body, request signature, database
detail, or free-form upstream error.

## Command Authentication

Reuse `@workspace/module-runtime-contract` signed raw-body authentication:

- exact method and path;
- Unix-second timestamp with at most 60 seconds of skew;
- at least 32 bytes of nonce entropy;
- HMAC-SHA-256 over the existing canonical string;
- timing-safe signature comparison;
- bounded replay cache;
- exact `application/json` with identity content encoding;
- no redirects.

The API client uses a 10-second timeout for one command and a 1 MiB maximum
response body. It validates the response schema, request ID, and operation
before returning data to a public route. All transport, malformed-response, and
timeout failures become a sanitized integration-unavailable result.

Same-node HTTP requires an explicit local flag and a private service hostname.
Without that flag the origin must be an exact HTTPS origin with normal CA, SAN,
and hostname verification.

## Provider Token Encryption

The module loads a file-backed JSON keyring:

```json
{
  "activeKeyId": "2026-07",
  "keys": {
    "2026-07": "<base64url encoded 32-byte key>"
  }
}
```

The keyring is strict, contains one to four unique keys, and has exactly one
active key. Tokens are encrypted with AES-256-GCM using a fresh 96-bit nonce.
Associated data binds ciphertext to schema version, provider, and account ID.
The stored envelope contains only:

- envelope version;
- key ID;
- base64url nonce;
- base64url ciphertext;
- base64url authentication tag.

Reads reject unknown keys, invalid lengths, authentication failure, provider or
account substitution, malformed plaintext, and oversized token payloads.
Writing a provider account always uses the active key. Reading with an older
key and rewriting with the active key provides the rotation path.

Logger redaction and tests must prove that raw tokens, ciphertext keys, OAuth
codes, internal signatures, and provider credentials do not appear in logs,
errors, rendered Compose, build output, or committed files.

## Persistence

`tf-integrations-postgres` is a private PostgreSQL service with no host port.
Immutable numbered SQL migrations create a migration history table and one
account-provider table:

- canonical `account_id`;
- provider enum (`spotify`, `yandex`);
- encrypted token envelope;
- bounded provider user ID and display metadata;
- created and updated timestamps;
- unique `(account_id, provider)`.

The runtime role can select, insert, update, and delete only integration-owned
rows. It cannot create or alter schema. A one-shot migrator runs before the
module becomes ready. Readiness requires the expected migration version and a
successful bounded database probe; provider availability is not a readiness
condition.

## Provider Behavior

### Spotify

- Authorization uses the existing read scopes and the callback URI supplied by
  `tf-api`, after exact HTTPS callback validation.
- Code exchange requires a refresh token and a valid bounded token response.
- Token refresh happens inside `tf-integrations` 60 seconds before expiry and
  is persisted before the provider operation continues.
- Only fixed Spotify Accounts and Web API HTTPS origins are permitted.
- Provider responses are strictly validated before normalization.

### Yandex Music

- The existing policy-protected token acceptance command validates the token
  against account status before storage.
- The web client continues to expose no provider-token input.
- Only fixed Yandex Music HTTPS origins and fixed endpoint templates are
  permitted.
- Provider responses are strictly validated before normalization.

## Availability and Heartbeat

- `GET /healthz` reports process liveness.
- `GET /readyz` reports validated runtime configuration, migration state, and
  database readiness.
- Spotify or Yandex outage does not make `/readyz` fail.
- After readiness the module sends a signed `account-integrations` heartbeat
  immediately and every 30 seconds.
- Command and heartbeat secrets are different file-backed values.
- The existing API heartbeat adapter marks the module stale after 90 seconds
  and unknown after API restart until a new heartbeat arrives.
- `tf-api` startup and readiness do not depend on provider availability.
  Protected integration routes return their existing sanitized unavailable
  behavior when the module cannot be reached.

## Container and Network Model

The same-node Compose stack uses:

```text
tf-api --(tf-integrations-control, internal)--> tf-integrations
tf-integrations --(tf-integrations-data, internal)--> tf-integrations-postgres
tf-integrations --(tf-integrations-egress)----------> Spotify/Yandex
tf-integrations --(tf-integrations-control)---------> tf-api heartbeat endpoint
```

`tf-integrations` and its database publish no host ports. The module is not
attached to `tf-data`, `tf-edge`, Platform networks, or search networks. The
database and migrator are not attached to the control or egress networks.

The runtime image:

- runs as UID/GID `10001:10001`;
- has a read-only root filesystem;
- drops all Linux capabilities;
- enables `no-new-privileges`;
- uses bounded `tmpfs`;
- has an init process and bounded health checks;
- contains no shell-only runtime dependency;
- contains no host, Docker, SSH, Coolify, or Caddy mount.

## Secrets

| Secret                            | API  | Module | Migrator | Database |
| --------------------------------- | ---- | ------ | -------- | -------- |
| integration command HMAC          | read | read   | no       | no       |
| integration heartbeat HMAC        | no   | read   | no       | no       |
| module heartbeat key map          | read | no     | no       | no       |
| runtime database URL              | no   | read   | no       | no       |
| migrator database URL             | no   | no     | read     | no       |
| PostgreSQL bootstrap password     | no   | no     | no       | read     |
| provider-token encryption keyring | no   | read   | no       | no       |
| Spotify client ID                 | no   | read   | no       | no       |
| Spotify client secret             | no   | read   | no       | no       |

All sensitive values are file-backed. Compose environment variables contain
only secret file paths, exact origins, versions, timestamps, ports, and explicit
local-mode flags.

## Coolify Placement and Domains

No new domain is required for the same-node implementation. Private Docker DNS
uses `http://tf-integrations:8080`.

A future cross-node placement requires either:

1. an owner-approved private overlay route; or
2. a separately approved exact TLS hostname, expected to be
   `integrations.tf.apollot.ru`.

The current published DNS set does not include that hostname. Do not create,
bind, or expose it during this local stage. If approved later, only `tf-api`
may reach the command endpoint, and public/browser access must remain denied.

## Validation

TDD and release validation must cover:

- strict command/result schemas and operation/request correlation;
- absence of provider tokens and credentials from result schemas;
- HMAC skew, replay, malformed body, content encoding, and body-size rejection;
- encryption round-trip, tamper rejection, associated-data binding, old-key
  read, active-key rewrite, and plaintext canary absence;
- parameterized repository operations and immutable migrations;
- fixed provider origins, response validation, refresh, and sanitized errors;
- API policy and CSRF rejection before any internal command;
- API-derived account IDs and API-owned OAuth state;
- public route compatibility for status, disconnect, library, and redirects;
- process/readiness behavior and heartbeat recovery;
- root and nested Compose secret/network/port/mount ownership;
- independent image build and disposable real-container smoke;
- scans of source, bundles, rendered Compose, logs, responses, and command
  output for secret canaries.

## Out of Scope

- Remote HomeNode/Coolify/Caddy/UFW/DNS changes.
- Public integration ingress or cross-node deployment.
- Automatic migration of legacy provider tokens.
- New Yandex browser OAuth.
- Multi-region integration database replication.
- `tf-download-worker` extraction.
- Android work.
