# Apollo Platform Architecture Design

**Date:** 2026-07-15
**Status:** Approved

## Context

Apollo becomes the umbrella brand for independently operated products. Apollo TF is the music search, collection, playback, and account-integration product. Apollo GA represents the Gate-Altas infrastructure product. The current repository contains Apollo TF and its admin dashboard; the running GA, Remnawave, Caddy, Coolify, and UFW infrastructure must remain operationally isolated.

The first release is a closed web beta. Android is deferred until the web platform, server modules, database, and access policy are working.

## Selected Architecture

Use a hybrid platform:

- Apollo Platform owns identity, registration, invitations, product catalog, release metadata, changelog, and module entitlements.
- Apollo TF owns music data and independently deployable search, integration, and download workers.
- Apollo GA remains a separate runtime. The portal may display a sanitized project/version summary, but Platform and TF cannot control or become a dependency of GA.
- Each product validates access on its server. A downloaded client or known endpoint cannot bypass an account entitlement.

This gives the beta fewer moving parts than full microservices while retaining service boundaries that can be split later.

## Public Domains

| Host | Responsibility |
| --- | --- |
| `apollot.ru` | Apollo portal, sign-in, registration state, projects, releases, and changelog |
| `api.apollot.ru` | Apollo Identity/Policy API and authorization endpoints |
| `admin.apollot.ru` | Restricted operator dashboard |
| `tf.apollot.ru` | Apollo TF web client |
| `api.tf.apollot.ru` | Apollo TF API, streaming/download gateway, and provider OAuth callbacks |
| `ga.apollot.ru` | Apollo GA project entry and sanitized status/version surface |

`www.apollot.ru` redirects to the apex. Databases, Redis, search adapters, integration workers, and download workers have private Coolify names only.

## Runtime Components

### Apollo Platform

- `platform-web`: portal and account UI.
- `platform-api`: identity, authorization, registration, invitations, policy, catalog, and audit API.
- `platform-postgres`: account and platform data.
- `platform-redis`: sessions, one-time authorization state, rate limits, and bounded revocation cache.
- `admin-web`: the existing operator dashboard extended with registration, account, entitlement, project, release, and invite management.

### Apollo TF

- `tf-web`: operational music client.
- `tf-api`: account-aware search orchestration, collections, playback metadata, provider callbacks, and download authorization.
- `tf-search`: search adapters and normalization.
- `tf-integrations`: Spotify/Yandex account token handling and parsing jobs.
- `tf-download-worker`: queued media download/transcode work.
- `tf-postgres`: TF-owned catalog, collection, provider, and job metadata.
- `tf-redis`: TF sessions, cache, queue, WebSocket fan-out, and rate limits.

Every independent module publishes the already specified signed heartbeat to `tf-api`; no application container receives Docker socket, SSH, Coolify API, Caddy, UFW, or host inventory access.

## Authentication Flow

1. `tf-web` starts Authorization Code + PKCE with `api.apollot.ru`.
2. Platform binds the transaction-specific `state`, `code_challenge`, browser session, client ID, and exact redirect URI.
3. Platform returns a short-lived one-time code to the registered TF callback.
4. `tf-api` exchanges the code using the verifier and confidential client authentication.
5. Platform returns a short-lived signed assertion containing `account_id`, account status, audience, installation ID, and entitlements.
6. `tf-api` validates issuer, audience, signature, time bounds, and nonce, then creates a server-side session in `tf-redis` and returns a Secure, HttpOnly, host-only cookie.
7. TF refreshes the entitlement snapshot before expiry. Revoked or suspended accounts fail closed on protected operations.

The browser never stores long-lived bearer or provider tokens. The flow follows PKCE and redirect-flow guidance in [RFC 9700](https://www.rfc-editor.org/info/rfc9700/).

## Data Ownership

Platform and TF use separate PostgreSQL databases and credentials. Platform is authoritative for identity and entitlements. TF stores the stable Platform `account_id` on user-owned rows but has no cross-database foreign key. Provider credentials are encrypted at rest with a runtime key and never returned to the browser after acceptance.

Legacy `session_id` data remains isolated until an authenticated user explicitly confirms a one-time migration. The migration is audited and idempotent; ambiguous legacy identities are not merged automatically.

## Failure Isolation

- Platform outage blocks new login, refresh, registration, and policy changes but does not stop GA.
- Existing TF sessions may continue only until their short entitlement assertion expires; protected actions then fail closed.
- A search/integration/download worker outage affects only its capability and is represented truthfully in the admin dashboard.
- Missing provider credentials or health observations render `unknown`/unavailable rather than healthy.
- Database migrations run as explicit versioned jobs before application rollout and never from multiple app replicas concurrently.

## Observability and Audit

- Structured logs contain request/event IDs and stable error codes, never passwords, tokens, invite secrets, cookies, provider credentials, request bodies, or private host inventory.
- Security-sensitive account, invite, entitlement, registration-mode, and operator actions append immutable audit events.
- Admin topology consumes authenticated snapshots and signed module heartbeats.
- Product status is not inferred from container existence alone.

## Delivery Order

1. Admin topology alignment and routing correction.
2. Apollo Identity/Policy database and API.
3. Apollo portal and operator management screens.
4. TF account migration, entitlement enforcement, and client-zone redesign.
5. Container separation and local release validation.
6. Read-only HomeNode preflight, owner approval, Coolify rollout, DNS/Caddy cutover, and rollback validation.

## Validation

- Contract, unit, integration, authorization, migration, and browser tests described in the focused specifications must pass.
- Container images run as non-root where practical, expose health/readiness endpoints, and receive only their own secrets.
- Compose validation proves that PostgreSQL and Redis are not host-published and web/API ports bind only to loopback/private ingress.
- A local end-to-end flow covers invite registration, approval, login, entitlement denial/grant, TF search, and session revocation.
- No HomeNode, Coolify, Caddy, UFW, DNS, Remnawave, or GA mutation occurs without an explicit final approval immediately before the remote change.

## Out of Scope for Release 1

- Android APK and ADB validation.
- Billing, subscriptions, public social/news feeds, or open marketplace behavior.
- Portal-driven deployment or control of Apollo GA.
- Public exposure of internal module endpoints, databases, Redis, or infrastructure inventory.
