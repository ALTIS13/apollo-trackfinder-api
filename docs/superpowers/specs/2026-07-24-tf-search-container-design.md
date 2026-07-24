# Apollo TF Search Container Design

**Date:** 2026-07-24
**Status:** Approved by the existing Apollo Coolify release specification and the owner's standing authorization to implement the next server/web stage

## Goal

Extract provider search from the Apollo TF API into an independently deployable
`tf-search` container. The module must work in the root Docker Compose stack,
remain deployable as a separate Coolify application on another node, and preserve
the current browser API and Platform entitlement boundary.

This is the first module-separation slice. `tf-integrations` and
`tf-download-worker` remain separate follow-up plans that reuse the service-auth,
heartbeat, container-hardening, and deployment patterns established here.

## Existing Approved Constraints

- `tf-api` remains the only public browser API and the only component that accepts
  the Apollo TF session cookie, CSRF token, or Platform policy result.
- `tf.search` is checked by `tf-api` before any search-module request is sent.
- `tf-search` receives no Platform or TF database credentials, Redis credentials,
  browser cookies, account/session/installation IDs, provider account tokens,
  Spotify/Yandex secrets, Docker socket, SSH key, Coolify credential, Caddy access,
  UFW access, or broad host mount.
- The existing dashboard identity stays `search-media`; the deployable service and
  Compose service are named `tf-search`.
- Local same-node communication uses private Docker DNS. Cross-node communication
  requires an exact owner-approved HTTPS origin with normal certificate and
  hostname validation. Plain HTTP is allowed only with an explicit flag for the
  same-node private Compose network.
- HomeNode, Coolify, Caddy, UFW, DNS, domains, and Android are not mutated in this
  stage.

## Approaches Considered

### 1. Provider adapter only

Move provider calls into `tf-search` but keep ranking and the PostgreSQL-backed
search cache in `tf-api`.

This is the smallest code move, but it leaves search behavior split across two
processes and keeps the old database cache coupled to the API. It does not satisfy
the approved requirement that `tf-search` own its runtime/cache.

### 2. Complete search runtime with a bounded process-local cache

Move provider fan-out, normalization, ranking, search-result caching, suggestions,
and batch item execution into `tf-search`. Keep public routing, policy, history,
streaming, download queues, and personalization data in `tf-api`.

This is selected. It creates one clear runtime boundary, needs no data-service
credential, starts cleanly on another node, and gives later modules a reusable
internal-auth and heartbeat pattern.

### 3. Search runtime with a dedicated Redis service

This permits multiple replicas and cache persistence, but adds another credential,
network, volume, backup surface, and cross-node dependency before there is evidence
that search-cache persistence is required. It is deferred.

## Runtime Topology

The root and nested TF Compose templates add:

```text
tf-api --(tf-search-control, internal)--> tf-search
tf-search --(tf-search-egress)----------> public media sources
tf-search --(tf-search-control)---------> tf-api heartbeat endpoint
```

`tf-search` has no published host port and is not attached to `tf-data` or
`tf-edge`. `tf-search-control` is `internal: true`. `tf-search-egress` is attached
only to `tf-search` and exists solely for outbound provider access.

The module runs as UID/GID `10001:10001` with:

- `read_only: true`
- `init: true`
- `no-new-privileges`
- `cap_drop: ALL`
- `pids_limit: 128`
- `/tmp` tmpfs limited to 32 MiB
- `/tmp/yt-dlp` tmpfs limited to 64 MiB
- one replica
- one CPU / 512 MiB limit
- 0.25 CPU / 256 MiB reservation
- 20-second stop grace period

The image contains Node.js, Python, and `yt-dlp`. It does not need FFmpeg because
the module reads provider metadata and never streams or transcodes media.

## Secret Scope

Three file-backed secrets are added:

| Secret | `tf-api` | `tf-search` | Purpose |
|---|---:|---:|---|
| `tf_search_internal_auth_secret` | yes | yes | HMAC authentication for API-to-search commands |
| `tf_search_heartbeat_secret` | no | yes | HMAC heartbeat identity for `search-media` |
| `tf_module_heartbeat_keys` | yes | no | API-side JSON map containing the matching `search-media` key |

The command-auth and heartbeat secrets are distinct and contain 32 through 512
characters. Compose renders file paths, never secret values. The API loads the
heartbeat map from `APOLLO_MODULE_HEARTBEAT_KEYS_FILE`; the legacy environment
map remains available for non-Compose development but is not used by production
templates.

## Internal Search Contract

`tf-api` calls exact `POST /v1/search`. The body is strict JSON no larger than
16 KiB:

```json
{
  "schemaVersion": 1,
  "requestId": "10000000-0000-4000-8000-000000000001",
  "artist": "Artist",
  "title": "Track",
  "mode": "auto",
  "sources": ["yt", "sc", "bc", "dz"],
  "maxResults": 20
}
```

Constraints:

- `requestId`: canonical UUID
- `artist`: trimmed, 1 through 200 characters
- `title`: trimmed, 1 through 300 characters
- `mode`: `auto` or `manual`
- `sources`: one through four unique values from `yt`, `sc`, `bc`, `dz`
- `maxResults`: integer from 1 through 40

The response is strict and bounded:

```json
{
  "schemaVersion": 1,
  "requestId": "10000000-0000-4000-8000-000000000001",
  "query": "Artist Track",
  "results": [],
  "cached": false,
  "sources": ["yt", "sc", "bc", "dz"],
  "fallbackAvailable": false,
  "providerStatus": {
    "yt": "ok",
    "sc": "ok",
    "bc": "ok",
    "dz": "ok"
  }
}
```

Each result contains the existing public fields plus an internal `sourceUrl`.
`tf-api` strips `sourceUrl` before returning browser responses. The result schema
accepts all four source names: `youtube`, `soundcloud`, `bandcamp`, and `deezer`.
No raw provider response or provider error text crosses the boundary.

Batch search remains a public `tf-api` orchestration loop. Each item invokes the
same one-query internal endpoint with the existing concurrency of eight, preserving
the current per-item fallback behavior without introducing an unbounded internal
batch body.

`tf-search` also exposes exact signed endpoints:

- `POST /v1/suggestions` with `{ "schemaVersion": 1, "requestId": "<uuid>", "query": "<2..200 chars>", "limit": 5 }`
- `POST /v1/candidates` with the search body plus a source subset; this is used by
  recommendations and Deezer stream/download fallbacks while keeping private
  `sourceUrl` out of browser responses.

`GET /healthz` reports process liveness. `GET /readyz` reports only valid local
configuration and initialized runtime state; external provider availability never
makes readiness fail.

## Internal Authentication

Every command endpoint receives:

```text
X-Apollo-Internal-Timestamp: <Unix seconds>
X-Apollo-Internal-Nonce: <43-character canonical base64url>
X-Apollo-Internal-Signature: v1=<64 lowercase hex characters>
```

The exact canonical string is:

```text
<UPPERCASE METHOD>
<EXACT PATH>
<TIMESTAMP>
<NONCE>
<LOWERCASE SHA-256 HEX OF EXACT RAW BODY>
```

The module:

1. accepts only identity content encoding and exact JSON content type;
2. enforces the raw-body limit before parsing;
3. computes the expected HMAC even for malformed header input;
4. compares fixed-length digests with `timingSafeEqual`;
5. accepts timestamps within plus or minus 60 seconds;
6. accepts each nonce once in a five-minute window;
7. caps live nonces at 256 and fails closed when full;
8. parses the strict operation schema only after authentication.

Missing, stale, replayed, malformed, or incorrectly signed authentication always
returns `401 {"error":"unauthorized"}`. Valid authentication with an invalid body
returns `400 {"error":"invalid_request"}`. A missing/invalid runtime key makes
`/readyz` return 503 and command endpoints return
`503 {"error":"search_unavailable"}`.

`tf-api` creates a fresh request ID, timestamp, and nonce for each dispatch. It
uses `redirect: "error"`, validates exact response schemas and matching request
IDs, and does not automatically retry provider work. Transport timeout, internal
authentication failure, invalid response, or module `5xx` is mapped to the stable
public `503 {"error":"search_unavailable"}` without internal details.

No account reference is sent because provider search is account-independent.
Account access remains bound and fail-closed at `tf-api`; tests must prove that a
missing/revoked `tf.search` entitlement prevents internal dispatch.

## Search Runtime

The module owns:

- YouTube, SoundCloud, Bandcamp, and Deezer adapters;
- `yt-dlp` metadata search;
- result normalization and ID encoding;
- classification and ranking;
- partial-provider-failure handling;
- bounded result cache and suggestions;
- rolling accepted-search request count for heartbeat telemetry.

The cache is an LRU-like insertion-ordered map with:

- at most 2,048 entries;
- one-hour TTL;
- at most 40 normalized results per entry;
- deterministic eviction of expired entries followed by the oldest entry;
- no disk, database, or Redis persistence.

Only standard all-source, non-extended searches are cached. A restart cold-starts
the cache and suggestions. This is acceptable for the first single-replica release.

The runtime does not log query text, result URLs, raw bodies, request headers,
signatures, provider response bodies, provider exception messages, or account data.
Logs contain only request ID, source status category, duration bucket, result count,
and sanitized error class.

## Heartbeat

After readiness, `tf-search` sends the existing signed
`search-media` heartbeat immediately and every 30 seconds. It uses the existing
canonical heartbeat contract and reports:

- `schemaVersion: 1`
- `status: healthy`, `warning`, or `degraded`
- module version
- optional deployed timestamp
- rolling accepted-search requests per minute

Provider failure changes heartbeat state only from bounded aggregate observations:
partial provider failures produce `warning`; repeated total search failures produce
`degraded`. No provider name, URL, query, error, or credential is included.

Heartbeat failure does not stop search readiness. API restart correctly shows the
module as unknown until the next accepted heartbeat.

## Public API Compatibility

Browser paths and Platform policy mappings remain unchanged:

- `POST /api/tracks/search`
- `POST /api/tracks/batch-search`
- `GET /api/tracks/suggest`
- `GET /api/tracks/recommendations`
- existing stream/download paths

The public OpenAPI source and generated clients are corrected to include the
already implemented `mode`, `sources`, all four source values,
`fallbackAvailable`, and bounded `maxResults`. The browser never sees internal
auth headers, `sourceUrl`, provider status, heartbeat keys, or module origins.

The historical `track_search_cache` database table is left in place for migration
compatibility, but runtime search and background cleanup stop using it. Removal is
a separate future database migration.

## Cross-Node Coolify Mode

Same-node production Compose uses:

```text
TF_SEARCH_ORIGIN=http://tf-search:8080
TF_SEARCH_ALLOW_INSECURE_HTTP=true
TF_SEARCH_HEARTBEAT_API_ORIGIN=http://api:8080
TF_SEARCH_HEARTBEAT_ALLOW_INSECURE_HTTP=true
```

An independently placed Coolify module must use exact `https://` origins. HTTP is
rejected when the explicit local-only flag is absent. Redirects are rejected.
Normal CA, SAN, and hostname verification remain enabled. Caddy/domain changes,
ingress allowlisting, certificate distribution, and HMAC rotation require a
separate read-only preflight and immediate owner approval before mutation.

No additional domain is required for local implementation or validation.

## Validation

- Contract tests cover strict schemas, source values, signature-field mutation,
  timestamp skew, replay, nonce capacity, response request-ID matching, and public
  error mapping.
- Search tests cover rank parity, source selection, max-result bounds, partial and
  total provider failure, cache hit/miss/TTL/eviction, suggestions, and query-free
  logging.
- API tests prove policy and CSRF run before dispatch, browser responses never
  contain `sourceUrl`, and search failures do not expose internal details.
- Heartbeat tests use the real API ingestion contract and prove immediate/periodic
  delivery, RPM, stale state, and API-restart recovery.
- Compose contract tests prove secret ownership, no public module port, network
  isolation, no DB/Redis/Platform/provider/control-plane credentials, and runtime
  hardening/resource limits.
- A disposable local smoke builds the API and search images, sends a real signed
  internal request, exercises the public policy-gated search path with deterministic
  provider fixtures, observes the heartbeat in the admin snapshot, restarts the API,
  observes unknown then healthy, and removes all containers, networks, volumes, and
  temporary secret files.
- Workspace typecheck, API/search builds, selected/full tests, bundle syntax/import
  scans, Compose rendering, formatting, and `git diff --check` pass.

## Out of Scope

- `tf-integrations` and `tf-download-worker` extraction.
- Multi-replica search or persistent search cache.
- Provider account OAuth or shared provider credentials in `tf-search`.
- Public search-module ingress or a public search hostname.
- Remote Coolify deployment, HomeNode mutation, Caddy reload, DNS records, UFW
  changes, or domain cutover.
- Android/APK work.
