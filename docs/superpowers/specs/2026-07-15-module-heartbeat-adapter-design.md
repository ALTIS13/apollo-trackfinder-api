# Authenticated Module Heartbeat Adapter Design

**Date:** 2026-07-15
**Status:** Approved direction, implementation pending

## Context

Apollo TF already exposes an authenticated admin snapshot assembled by the API process. That snapshot can report local HTTP counters, database readiness, Redis state, and queue telemetry, but independent Coolify modules have no truthful way to publish their own version or health. Unobserved containers therefore remain `unknown`, while several logical modules still inherit the API process state.

This stage adds a narrow module-to-API heartbeat boundary. It must not give the application container access to the Docker socket, SSH, the Coolify API, Caddy, UFW, or HomeNode inventory.

## Considered Approaches

### 1. Signed push heartbeat with an in-memory registry (selected)

Each independently deployed module sends a small authenticated heartbeat to the API. The API verifies a per-module HMAC signature, records the server receipt time, and overlays fresh observations onto the existing admin snapshot. State is intentionally process-local and disappears on API restart.

This approach is selected because it keeps infrastructure credentials outside application containers, supports independently networked Coolify applications through the existing API ingress, prevents one module from reporting another module's identity, and fails truthfully to `unknown` after missed heartbeats or an API restart.

### 2. Per-module bearer token

This has a simpler client, but a captured request can be replayed for the lifetime of the token. TLS remains mandatory in either design, but bearer authentication provides weaker request authenticity and replay resistance. It is not selected.

### 3. Redis persistence or API-side pull probes

Redis persistence could restore stale observations after an API restart, while pull probes would require the API to know every module URL and network. Both add operational coupling and can make old state look authoritative. They are deferred.

## Goals

- Accept authenticated health/version heartbeats from explicitly configured module IDs.
- Bind each credential to exactly one module ID.
- Use server receipt time, not the module clock, to determine freshness.
- Mark managed modules `unknown` after 90 seconds without an accepted heartbeat.
- Mark managed modules `unknown` with no observation after an API restart.
- Surface the last accepted heartbeat time in the shared dashboard contract and deployment table.
- Preserve the existing local telemetry behavior for module IDs that are not configured as heartbeat-managed.
- Keep request bodies, signatures, secrets, and internal failures out of logs and responses.
- Allow modules to be connected one at a time without requiring a shared Docker network.

## Non-goals

- Persisting heartbeat state in Redis, PostgreSQL, or files.
- Discovering containers through Docker, Coolify, SSH, DNS enumeration, or HomeNode access.
- Deploying or changing HomeNode, Coolify, Caddy, Remnawave, or UFW.
- Adding provider probes for Spotify, Yandex Music, YouTube, SoundCloud, Bandcamp, or Deezer.
- Sending incidents or arbitrary logs through heartbeat payloads.
- Building the first search/account/provider worker container. This adapter is the prerequisite for those stages.
- Replacing the existing `/api/healthz` liveness endpoint.

## Configuration

The API receives one runtime-only variable:

```text
APOLLO_MODULE_HEARTBEAT_KEYS={"search-media":"<secret>","account-integrations":"<secret>"}
```

The value is a strict JSON object with at most 128 entries. Keys are existing dashboard module IDs; values are secrets from 32 through 512 characters. Invalid or empty configuration disables heartbeat ingestion with `503 heartbeat_disabled`; it must not prevent the API or `/api/healthz` from starting.

Each module receives only its own secret and the public API base URL. The browser, admin nginx, web player, and unrelated containers never receive the key map. The root and nested Compose files pass the key map only to the API. Future module Compose definitions will pass a single module secret only to its owning container.

`.env`, `.env.*`, and `.ops-private` are excluded from Git and Docker build contexts so runtime secrets and private operations notes cannot be sent to a builder accidentally. Existing sample env files may remain tracked through explicit negation rules.

## HTTP Contract

### Endpoint

```http
POST /api/internal/modules/:moduleId/heartbeat
Content-Type: application/json
X-Apollo-Heartbeat-Timestamp: <unix-seconds>
X-Apollo-Heartbeat-Nonce: <16-64 ASCII characters>
X-Apollo-Heartbeat-Signature: v1=<64 lowercase hex characters>
```

The route accepts only `POST` with JSON no larger than 8 KiB. The path module ID must exist in the configured key map. The route is excluded from user request-rate and error-rate telemetry.

### Payload

```json
{
  "schemaVersion": 1,
  "status": "healthy",
  "version": "2.15.0",
  "deployedAt": "2026-07-15T04:30:00.000Z",
  "requestsPerMinute": 42
}
```

Rules:

- The object is strict; unknown fields are rejected.
- `schemaVersion` is exactly `1`.
- `status` is `healthy`, `warning`, `degraded`, or `unknown`.
- `version` is trimmed, non-empty, and at most 128 characters.
- `deployedAt` is optional ISO 8601 with an offset.
- `requestsPerMinute` is optional, finite, non-negative, and bounded to `1_000_000`.
- The payload does not contain module ID, credentials, incidents, provider tokens, log excerpts, URLs, or free-form metadata.

### Signature

The signature is lower-case HMAC-SHA256 over this UTF-8 canonical string:

```text
POST\n
/api/internal/modules/<moduleId>/heartbeat\n
<timestamp>\n
<nonce>\n
<sha256-hex-of-exact-request-body>
```

The API computes the signature from the exact raw body and compares fixed-length digests with `timingSafeEqual`. Unknown module IDs follow the same digest-comparison path with a process-local dummy key before rejection, so the response does not expose configured IDs. A timestamp must be within 60 seconds of API time. A nonce is accepted once per module within a five-minute replay window capped at 128 entries. A request with an old timestamp, reused nonce, invalid signature, unknown module, malformed auth headers, or mismatched credential returns the same sanitized `401 unauthorized` and never mutates registry state.

Valid but schema-invalid JSON returns `400 invalid_heartbeat`. A valid heartbeat older than the most recently accepted signed timestamp for that module returns `409 stale_heartbeat`. Equal timestamps are permitted when nonces differ because Unix seconds are not unique enough for normal retries.

A successful request returns:

```http
HTTP/1.1 202 Accepted
Cache-Control: no-store
Content-Type: application/json

{"accepted":true,"receivedAt":"2026-07-15T04:31:02.123Z"}
```

`receivedAt` is generated by the API after authentication and validation.

## Registry and Freshness

`ModuleHeartbeatRegistry` is an in-memory, dependency-free component with an injected clock for deterministic tests. Its cardinality is bounded by the configured module key map; it never creates entries for unconfigured IDs.

For each managed module it stores only:

- the validated payload;
- the server-generated `receivedAt` timestamp;
- the accepted signed timestamp;
- a bounded nonce replay set.

Freshness is calculated when the dashboard snapshot is requested:

- age `<= 90 seconds`: use reported status, version, deployment time, and request rate;
- age `> 90 seconds`: status becomes `unknown`, request rate becomes `0`, while the last reported version/deployment metadata and `lastHeartbeatAt` remain visible as historical facts;
- no entry: status is `unknown`, version falls back to `unknown`, and `lastHeartbeatAt` is absent;
- API restart: the empty registry produces the same no-entry state until the next accepted heartbeat.

The client timestamp is used only for signature freshness and ordering. It never becomes `lastHeartbeatAt` and never extends module health freshness.

## Dashboard Integration

The shared `ServiceModule` schema gains optional `lastHeartbeatAt`. Missing observation time remains valid and renders as `Нет данных`.

The API snapshot assembler receives a heartbeat snapshot dependency. Only module IDs present in the configured registry are heartbeat-managed. Their observations overlay the existing module definitions before active-module metrics and edge states are derived, so topology colors and counts update automatically. Unmanaged IDs retain the current local probe behavior.

The deployment table gains a compact `Последний сигнал` column using the existing Moscow-time formatter and table styling. No new page, navigation item, card, topology node, or decorative visual language is introduced.

Provider rows remain unchanged and `unknown` until a separate provider-health stage.

## Error Handling and Logging

- Empty/invalid server configuration disables only the ingestion endpoint.
- Authentication failures use one generic `401` body and do not reveal whether a module ID or signature was wrong.
- Schema failures return only a stable error code, never Zod details or request content.
- Unexpected failures return `503 heartbeat_unavailable` and log only error type plus a fixed event name.
- Request logging continues to omit bodies and query strings.
- Heartbeat signature headers and any future authorization header are explicitly redacted.
- Dashboard collection cannot fail because one heartbeat is missing or stale.
- All heartbeat responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## Test Strategy

### Shared contract

- Accept valid optional `lastHeartbeatAt`.
- Reject invalid timestamps and unknown module fields.
- Preserve snapshots with no heartbeat time for unobserved modules.

### Registry and authentication

- RED/GREEN tests for fresh, stale, missing, restarted, and fake-clock transitions.
- Per-module credential isolation.
- Exact raw-body HMAC verification and constant-time digest comparison.
- Missing/wrong signatures, future/expired timestamps, replayed nonces, out-of-order timestamps, equal-timestamp retries, oversized bodies, strict schemas, and bounded metrics.
- No registry mutation before successful auth and validation.
- Bounded nonce and module cardinality.

### Snapshot and UI

- Managed fresh observations overlay status/version/RPM/deployment time.
- Managed stale/missing observations become `unknown` without fabricated timestamps.
- Unmanaged modules preserve existing local telemetry.
- Edges and the active-module metric derive from the overlaid status.
- HTTP adapter accepts `lastHeartbeatAt`; deployment table renders real time or `Нет данных`.

### Configuration and runtime

- Heartbeat key map reaches only the API container and is absent from browser build inputs.
- Signature headers are redacted and heartbeat requests are excluded from user telemetry.
- `.env` and `.ops-private` are excluded from Git/Docker contexts.
- API tests, admin tests, contract tests, workspace typecheck, production builds, Compose config, `git diff --check`, and a local signed-request smoke test pass.
- HomeNode/Coolify remain unchanged during local validation.

## Rollout

1. Ship the adapter disabled by default.
2. Configure one per-module secret for the first independently deployed module.
3. Start heartbeats at a 30-second interval, leaving two missed intervals before the 90-second stale boundary.
4. Confirm fresh status/version and `lastHeartbeatAt` in the admin dashboard.
5. Stop the module and confirm it becomes `unknown` after TTL without affecting the API dashboard endpoint.
6. Connect search, account, download, and provider-facing containers one at a time in later stages.
