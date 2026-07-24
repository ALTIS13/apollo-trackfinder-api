# Apollo TF Search Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Apollo TF provider search into a signed, observable, independently deployable `tf-search` container while preserving the browser API and Platform `tf.search` policy boundary.

**Architecture:** `tf-api` remains the public cookie/CSRF/policy facade and dispatches strict HMAC-authenticated commands over a private control network. `tf-search` owns provider fan-out, normalization, ranking, a bounded process-local cache, suggestions, and signed `search-media` heartbeats; it has only provider egress and no database, Redis, Platform, provider-account, or control-plane credentials. Root and nested Compose keep a complete same-node stack, while exact HTTPS origins remain available for a later owner-approved cross-node Coolify placement.

**Tech Stack:** TypeScript 5.9, Node.js 20, Express 5, Zod 3.25, Pino 9, Vitest 4, esbuild 0.27, Docker Compose, Python/yt-dlp

## Global Constraints

- Binding design: `docs/superpowers/specs/2026-07-24-tf-search-container-design.md`.
- Browser paths, cookie auth, CSRF behavior, and Platform policy mappings remain in `tf-api`.
- `tf-api` must verify `tf.search` before dispatching a module request.
- The module receives no browser cookie, CSRF value, account/session/installation ID, entitlement assertion, TF/Platform database or Redis credential, Platform client secret, Spotify/Yandex/provider account secret, Docker socket, SSH key, Coolify/Caddy/UFW credential, or broad host mount.
- Compose service name is `tf-search`; dashboard heartbeat module ID remains `search-media`.
- Command authentication and heartbeat authentication use different file-backed secrets.
- Command requests use exact raw-body HMAC, plus/minus 60-second timestamp tolerance, one-use 43-character base64url nonce, a five-minute replay window, and a maximum of 256 live nonces.
- `tf-search` has no host-published port and is not attached to `tf-data` or `tf-edge`.
- Search cache is process-local, bounded to 2,048 entries and a one-hour TTL; the first release is one replica.
- Same-node HTTP requires an explicit local-only flag. Without that flag, module origins must be exact HTTPS origins and redirects remain disabled.
- Provider degradation never makes `/readyz` fail.
- No raw query, source URL, body, request header, signature, provider body/error, or account data may be logged.
- HomeNode, Coolify, Caddy, UFW, DNS, domains, Android, `tf-integrations`, and `tf-download-worker` are unchanged.

---

### Task 1: Shared Module Authentication And Search Contracts

**Files:**
- Create: `lib/module-runtime-contract/package.json`
- Create: `lib/module-runtime-contract/tsconfig.json`
- Create: `lib/module-runtime-contract/src/index.ts`
- Test: `lib/module-runtime-contract/src/index.test.ts`
- Create: `lib/tf-search-contract/package.json`
- Create: `lib/tf-search-contract/tsconfig.json`
- Create: `lib/tf-search-contract/src/index.ts`
- Test: `lib/tf-search-contract/src/index.test.ts`
- Modify: `tsconfig.json`
- Modify: `artifacts/api-server/package.json`
- Modify: `artifacts/api-server/src/lib/module-heartbeat.ts`
- Modify: `artifacts/api-server/src/lib/module-heartbeat.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces:

```ts
export interface SignedBodyInput {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly rawBody: Uint8Array;
  readonly secret: string;
}

export function createSignedBodySignature(input: SignedBodyInput): string;
export function hasMatchingSignedBodySignature(
  provided: string | undefined,
  expected: string,
): boolean;
export const canonicalNonceSchema: z.ZodString;
export const moduleHeartbeatPayloadSchema: z.ZodType<ModuleHeartbeatPayload>;
export function createModuleHeartbeatSignature(input: SignatureInput): string;
```

- Produces:

```ts
export const tfSearchSourceSchema: z.ZodEnum<["yt", "sc", "bc", "dz"]>;
export const tfSearchResultSourceSchema:
  z.ZodEnum<["youtube", "soundcloud", "bandcamp", "deezer"]>;
export const tfSearchCommandSchema: z.ZodType<TfSearchCommand>;
export const tfSearchResponseSchema: z.ZodType<TfSearchResponse>;
export const tfSearchSuggestionsCommandSchema:
  z.ZodType<TfSearchSuggestionsCommand>;
export const tfSearchSuggestionsResponseSchema:
  z.ZodType<TfSearchSuggestionsResponse>;
export const TF_SEARCH_COMMAND_PATH = "/v1/search";
export const TF_SEARCH_SUGGESTIONS_PATH = "/v1/suggestions";
```

- `TfSearchResponse.results[]` includes internal `sourceUrl`; public API code must strip it.

- [ ] **Step 1: Add RED tests for canonical signatures**

Create tests asserting this exact canonical form:

```ts
const rawBody = Buffer.from('{"schemaVersion":1}', "utf8");
const signature = createSignedBodySignature({
  method: "post",
  path: "/v1/search",
  timestamp: "1784916000",
  nonce: "A".repeat(43),
  rawBody,
  secret: "s".repeat(32),
});
expect(signature).toMatch(/^v1=[a-f0-9]{64}$/);
expect(signature).toBe(
  createHmac("sha256", "s".repeat(32))
    .update([
      "POST",
      "/v1/search",
      "1784916000",
      "A".repeat(43),
      createHash("sha256").update(rawBody).digest("hex"),
    ].join("\n"))
    .digest("hex")
    .replace(/^/, "v1="),
);
```

Mutate method, path, timestamp, nonce, body, and secret separately and assert a
different signature. Assert constant-time comparison accepts only the exact
signature and canonical nonce accepts 43-character unpadded base64url only.

- [ ] **Step 2: Add RED tests for strict search DTOs**

Use a canonical command fixture and assert:

```ts
expect(tfSearchCommandSchema.parse(command)).toEqual(command);
expect(tfSearchCommandSchema.safeParse({ ...command, accountId: "secret" }).success)
  .toBe(false);
expect(tfSearchCommandSchema.safeParse({ ...command, maxResults: 41 }).success)
  .toBe(false);
expect(tfSearchCommandSchema.safeParse({ ...command, sources: ["yt", "yt"] }).success)
  .toBe(false);
expect(tfSearchResponseSchema.safeParse({
  ...response,
  requestId: "not-a-uuid",
}).success).toBe(false);
```

Cover every source/result-source enum, trimmed length bounds, strict unknown-field
rejection, maximum 40 results, HTTPS-only `sourceUrl`, finite numeric fields, and
strict provider status values `ok`, `failed`, `skipped`.

- [ ] **Step 3: Run the new tests and verify RED**

Run:

```bash
pnpm --filter @workspace/module-runtime-contract test
pnpm --filter @workspace/tf-search-contract test
```

Expected: both fail because the packages/exports do not exist.

- [ ] **Step 4: Implement the two contract packages**

Use `z.object(...).strict()`. `createSignedBodySignature` uppercases the method,
hashes the exact bytes, joins the five canonical lines with `\n`, and returns
`v1=<lowercase hex>`. Comparison hashes both full signature strings to fixed
32-byte digests before `timingSafeEqual`.

Make the API heartbeat implementation import and re-export the shared heartbeat
signature and payload schema so all existing API callers keep their names.

- [ ] **Step 5: Run focused and compatibility tests**

Run:

```bash
pnpm --filter @workspace/module-runtime-contract test
pnpm --filter @workspace/tf-search-contract test
pnpm --filter @workspace/api-server test -- src/lib/module-heartbeat.test.ts src/routes/module-heartbeats.test.ts
pnpm --filter @workspace/api-server typecheck
```

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add lib/module-runtime-contract lib/tf-search-contract tsconfig.json artifacts/api-server/package.json artifacts/api-server/src/lib/module-heartbeat.ts artifacts/api-server/src/lib/module-heartbeat.test.ts pnpm-lock.yaml
git commit -m "feat(tf-search): add signed module contracts"
```

---

### Task 2: Search Engine And Bounded Cache

**Files:**
- Create: `artifacts/tf-search/package.json`
- Create: `artifacts/tf-search/tsconfig.json`
- Create: `artifacts/tf-search/build.mjs`
- Create: `artifacts/tf-search/src/classifier.ts`
- Create: `artifacts/tf-search/src/ranker.ts`
- Create: `artifacts/tf-search/src/ytdlp-search.ts`
- Create: `artifacts/tf-search/src/adapters/youtube.ts`
- Create: `artifacts/tf-search/src/adapters/soundcloud.ts`
- Create: `artifacts/tf-search/src/adapters/bandcamp.ts`
- Create: `artifacts/tf-search/src/adapters/deezer.ts`
- Create: `artifacts/tf-search/src/cache.ts`
- Test: `artifacts/tf-search/src/cache.test.ts`
- Create: `artifacts/tf-search/src/search-service.ts`
- Test: `artifacts/tf-search/src/search-service.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes Task 1 `TfSearchCommand`, `TfSearchResponse`, and source/result schemas.
- Produces:

```ts
export interface SearchProvider {
  readonly source: TfSearchSource;
  search(query: string, limit: number): Promise<readonly InternalTrack[]>;
}

export interface SearchService {
  search(command: TfSearchCommand): Promise<TfSearchResponse>;
  suggestions(command: TfSearchSuggestionsCommand):
    Promise<TfSearchSuggestionsResponse>;
  telemetry(): {
    readonly requestsPerMinute: number;
    readonly status: "healthy" | "warning" | "degraded";
  };
}

export class BoundedSearchCache {
  constructor(options?: {
    readonly maxEntries?: number;
    readonly ttlMs?: number;
    readonly now?: () => number;
  });
}
```

- [ ] **Step 1: Write RED cache tests**

Assert exact key normalization, one-hour expiry, insertion-order refresh on hit,
2,048-entry eviction, replacement without cardinality growth, maximum 40 stored
results, and suggestions limited to five matching normalized artist/title pairs.
Use injected clocks; do not sleep.

- [ ] **Step 2: Write RED search-service parity tests**

Inject four provider fakes. Cover:

```ts
it("fans out only to selected sources and uses the approved limits");
it("preserves original/remix/live/cover tier ordering and source boosts");
it("returns partial results and sanitized failed provider statuses");
it("returns an empty successful response after total provider failure");
it("caches only all-source non-extended searches");
it("does not leak sourceUrl through a public projection helper");
it("reports bounded rolling RPM without retaining queries");
```

Use representative existing ranking fixtures copied from the current API behavior.
Assert no test log contains artist, title, `sourceUrl`, raw error message, or headers.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
pnpm --filter @workspace/tf-search test -- src/cache.test.ts src/search-service.test.ts
```

Expected: fail because the runtime files do not exist.

- [ ] **Step 4: Move and implement the search runtime**

Port classifier/ranker/provider behavior from `artifacts/api-server` without changing
public score/type/ID semantics. Split only metadata-search process functions from
the API `ytdlp.ts`; use `--no-cache-dir`, a 45-second child timeout, bounded stdout
collection, and sanitized error classes.

The service uses `Promise.allSettled`, strips provider exception text, computes the
existing median original duration, ranks, limits to `maxResults`, and caches only
the exact standard path from the design. Cache and telemetry retain no raw query
outside bounded cache keys/results.

- [ ] **Step 5: Run Task 2 validation**

```bash
pnpm --filter @workspace/tf-search test -- src/cache.test.ts src/search-service.test.ts
pnpm --filter @workspace/tf-search typecheck
```

Expected: focused tests and typecheck pass. The executable entry point and
production bundle are introduced and validated by Task 3.

- [ ] **Step 6: Commit Task 2**

```bash
git add artifacts/tf-search pnpm-lock.yaml
git commit -m "feat(tf-search): extract provider search engine"
```

---

### Task 3: Authenticated Search Service, Health, And Heartbeat

**Files:**
- Create: `artifacts/tf-search/src/config.ts`
- Test: `artifacts/tf-search/src/config.test.ts`
- Create: `artifacts/tf-search/src/internal-auth.ts`
- Test: `artifacts/tf-search/src/internal-auth.test.ts`
- Create: `artifacts/tf-search/src/app.ts`
- Test: `artifacts/tf-search/src/app.test.ts`
- Create: `artifacts/tf-search/src/heartbeat.ts`
- Test: `artifacts/tf-search/src/heartbeat.test.ts`
- Create: `artifacts/tf-search/src/logger.ts`
- Test: `artifacts/tf-search/src/logger.test.ts`
- Create: `artifacts/tf-search/src/index.ts`
- Create: `artifacts/tf-search/container/start-search.sh`
- Create: `artifacts/tf-search/Dockerfile`
- Modify: `artifacts/tf-search/package.json`
- Modify: `artifacts/tf-search/build.mjs`

**Interfaces:**
- Produces:

```ts
export interface TfSearchRuntimeConfig {
  readonly port: number;
  readonly internalAuthSecret: string;
  readonly heartbeatSecret: string;
  readonly heartbeatApiOrigin: string;
  readonly version: string;
  readonly deployedAt?: string;
}

export async function parseTfSearchRuntimeConfig(
  env: NodeJS.ProcessEnv,
  readSecret?: (path: string) => Promise<string>,
): Promise<TfSearchRuntimeConfig>;

export function createTfSearchApp(options: {
  readonly service: SearchService;
  readonly auth: InternalRequestAuthenticator;
  readonly ready: () => boolean;
}): Express;

export function startSearchHeartbeat(options: HeartbeatOptions): {
  stop(): Promise<void>;
};
```

- [ ] **Step 1: Write RED config and transport tests**

Assert:

- both secret files are required, readable, trimmed, and 32..512 characters;
- command and heartbeat secrets must differ;
- port is 1..65535;
- origins are exact origins without credentials/path/query/fragment;
- HTTP is rejected unless its matching `*_ALLOW_INSECURE_HTTP` flag is exactly
  `true` and hostname is a simple private service DNS name or loopback;
- HTTPS remains valid without the flag;
- deployed time is valid offset RFC3339 when present.

- [ ] **Step 2: Write RED internal-auth tests**

Use exact raw bodies and cover valid auth, every signature-field mutation,
timestamp `-61/+61` seconds, malformed timestamp, nonce shape, replay, expiry,
256-nonce saturation, distinct endpoint paths, constant generic unauthorized
responses, identity encoding, JSON content type, and 16 KiB body limit.

- [ ] **Step 3: Write RED app and logger tests**

Assert:

```ts
GET /healthz -> 200 {"status":"ok"}
GET /readyz when configured -> 200 {"status":"ok"}
GET /readyz when not ready -> 503 {"status":"unavailable"}
POST /v1/search without auth -> 401 {"error":"unauthorized"}
valid signed search -> strict 200 TfSearchResponse
valid signed invalid body -> 400 {"error":"invalid_request"}
service exception -> 503 {"error":"search_unavailable"}
```

Verify adapters are never invoked after failed authentication. Capture logs and
assert query, source URL, body, signatures, headers, and raw provider errors are
absent.

- [ ] **Step 4: Write RED heartbeat tests**

Use fake timers and a real `createModuleHeartbeatSignature` verifier. Assert:

- immediate send after readiness;
- every 30 seconds after the previous attempt completes;
- no overlapping sends;
- `redirect: "error"` and a 10-second timeout;
- exact `search-media` path/body/headers;
- RPM/status/version/deployedAt projection;
- failures do not change readiness or stop later attempts;
- `stop()` aborts/waits and leaves no timer.

- [ ] **Step 5: Run Task 3 tests and verify RED**

```bash
pnpm --filter @workspace/tf-search test -- src/config.test.ts src/internal-auth.test.ts src/app.test.ts src/logger.test.ts src/heartbeat.test.ts
```

Expected: fail because the service boundary is not implemented.

- [ ] **Step 6: Implement the runtime boundary and image**

Mount raw parsers only on signed command endpoints before JSON parsing. Use
case-sensitive/strict routing, `Cache-Control: no-store`, `X-Content-Type-Options:
nosniff`, `redirect: "error"`, and sanitized Pino serializers.

The Docker build uses pinned `pnpm@10.33.2`, builds only required workspace
packages, installs Python plus `yt-dlp`, creates UID/GID 10001, copies only the
bundle/start script, removes write permission, exposes 8080, and runs as 10001.

- [ ] **Step 7: Run Task 3 validation**

```bash
pnpm --filter @workspace/tf-search test
pnpm --filter @workspace/tf-search typecheck
pnpm --filter @workspace/tf-search build
node --check artifacts/tf-search/dist/index.mjs
```

Expected: all tests and checks pass.

- [ ] **Step 8: Commit Task 3**

```bash
git add artifacts/tf-search
git commit -m "feat(tf-search): serve signed search commands"
```

---

### Task 4: TF API Gateway And Public Contract Migration

**Files:**
- Create: `artifacts/api-server/src/lib/tf-search-client.ts`
- Test: `artifacts/api-server/src/lib/tf-search-client.test.ts`
- Modify: `artifacts/api-server/src/routes/tracks.ts`
- Modify: `artifacts/api-server/src/routes/tracks.test.ts`
- Modify: `artifacts/api-server/src/routes/index.ts`
- Modify: `artifacts/api-server/src/app.ts`
- Modify: `artifacts/api-server/src/index.ts`
- Modify: `artifacts/api-server/src/lib/background-queue.ts`
- Modify: `artifacts/api-server/src/lib/ytdlp.ts`
- Delete: `artifacts/api-server/src/lib/cache.ts`
- Delete: `artifacts/api-server/src/lib/classifier.ts`
- Delete: `artifacts/api-server/src/lib/ranker.ts`
- Delete: `artifacts/api-server/src/adapters/youtube.ts`
- Delete: `artifacts/api-server/src/adapters/soundcloud.ts`
- Delete: `artifacts/api-server/src/adapters/bandcamp.ts`
- Delete: `artifacts/api-server/src/adapters/deezer.ts`
- Modify: `lib/api-spec/openapi.yaml`
- Modify generated: `lib/api-client-react/src/generated/**`
- Modify generated: `lib/api-zod/src/generated/**`
- Modify: `artifacts/api-server/package.json`
- Modify: `artifacts/api-server/Dockerfile`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces:

```ts
export interface TfSearchGateway {
  search(input: Omit<TfSearchCommand, "schemaVersion" | "requestId">):
    Promise<TfSearchResponse>;
  suggestions(query: string, limit: number):
    Promise<TfSearchSuggestionsResponse>;
}

export async function parseTfSearchClientConfig(
  env: NodeJS.ProcessEnv,
  readSecret?: (path: string) => Promise<string>,
): Promise<TfSearchClientConfig>;

export class HttpTfSearchClient implements TfSearchGateway {
  constructor(config: TfSearchClientConfig, dependencies?: ClientDependencies);
}
```

- `createTracksRouter` receives `searchGateway` through `TrackRouteDependencies`.
- [ ] **Step 1: Write RED client tests**

Assert exact origin validation and exact signed request shape. Verify:

- credentials/cookies/CSRF/account/session/entitlements are absent;
- fresh UUID/nonce/timestamp are generated per command;
- `redirect: "error"` and bounded timeout are used;
- response schema and request ID must match;
- transport, timeout, 401, malformed JSON/schema, ID mismatch, and 5xx all become
  typed `search_unavailable`;
- no automatic retry occurs.

- [ ] **Step 2: Write RED route migration tests**

Inject a fake gateway and cover `/search`, `/batch-search`, `/suggest`,
`/recommendations`, and Deezer fallback paths. Assert the existing browser response
shapes, batch concurrency 8, maximum 100 items, five-result batch truncation,
`bestScore >= 80`, empty recommendation fallback, and no public `sourceUrl` or
internal provider status.

Add an app-level test with a counting gateway proving absent/revoked `tf.search`
returns the existing policy response and the gateway call count remains zero.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
pnpm --filter @workspace/api-server test -- src/lib/tf-search-client.test.ts src/routes/tracks.test.ts src/app-auth-boundary.test.ts src/routes/policy-coverage.test.ts
```

Expected: fail because the client/gateway does not exist and routes still call
providers directly.

- [ ] **Step 4: Implement the client and migrate all provider-search callers**

Construct one configured `HttpTfSearchClient` during API startup and inject it
through app/router options. Public validation and Platform policy remain before the
gateway. Map unavailable module calls to:

```json
{"error":"search_unavailable"}
```

with status 503. Strip internal `sourceUrl` and provider status from browser
responses. Recommendations keep TF database artist selection but request candidates
from the module. Stream/download Deezer fallbacks request private candidates from
the module. Suggestions use the module cache.

Remove API provider adapters, ranking/classification, PostgreSQL search-cache
runtime, and stale-cache queue cleanup. Keep the historical database schema/table
and all stream/download `yt-dlp` functions.

- [ ] **Step 5: Correct and regenerate the public API**

Update `SearchRequest` with bounded `mode`, `sources`, and `maxResults`; update
`TrackSource` to four source values; update `SearchResponse` with `sources` and
`fallbackAvailable`. Run:

```bash
pnpm --filter @workspace/api-spec codegen
```

Do not manually edit generated files after codegen.

- [ ] **Step 6: Run Task 4 validation**

```bash
pnpm --filter @workspace/api-server test -- src/lib/tf-search-client.test.ts src/routes/tracks.test.ts src/app-auth-boundary.test.ts src/routes/policy-coverage.test.ts
pnpm --filter @workspace/music-player test
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/music-player typecheck
pnpm --filter @workspace/api-server build
node --check artifacts/api-server/dist/index.mjs
rg -n "searchYouTube|searchSoundCloud|searchBandcamp|searchDeezer|trackSearchCacheTable" artifacts/api-server/src
```

Expected: tests/typechecks/build/syntax pass and the final scan has no API runtime
matches.

- [ ] **Step 7: Commit Task 4**

```bash
git add artifacts/api-server lib/api-spec lib/api-client-react lib/api-zod pnpm-lock.yaml
git commit -m "feat(tf-api): dispatch search to module"
```

---

### Task 5: Compose Isolation, File Secrets, And Disposable Smoke

**Files:**
- Modify: `docker-compose.yml`
- Modify: `artifacts/api-server/docker-compose.yml`
- Modify: `artifacts/api-server/container/start-tf.sh`
- Modify: `artifacts/api-server/src/deployment-contract.test.ts`
- Modify: `artifacts/api-server/src/admin-config-contract.test.ts`
- Create: `artifacts/tf-search/src/deployment-contract.test.ts`
- Create: `artifacts/tf-search/scripts/smoke.mjs`
- Test: `artifacts/tf-search/src/smoke.test.ts`
- Modify: `.dockerignore`
- Modify: `MODULES.md`

**Interfaces:**
- Consumes Task 3 image and Task 4 API client.
- Produces root/nested services and exact file-backed secret names:
  `tf_search_internal_auth_secret`, `tf_search_heartbeat_secret`,
  `tf_module_heartbeat_keys`.

- [ ] **Step 1: Write RED Compose contract tests**

Parse both YAML templates and assert:

```ts
expect(Object.keys(template.services).sort()).toEqual([
  // existing identities plus "tf-search"
]);
expect(search.ports).toBeUndefined();
expect(search.networks).toEqual(["tf-search-control", "tf-search-egress"]);
expect(api.networks).toContain("tf-search-control");
expect(search.networks).not.toContain("tf-data");
expect(search.networks).not.toContain("tf-edge");
```

Assert exact secret ownership, no literal value/digest in rendered config, no
DB/Redis/Platform/provider/control-plane env, UID 10001, read-only/init/cap-drop,
tmpfs, PID/resource/stop limits, healthcheck, and no volume.

- [ ] **Step 2: Write RED startup/file-secret tests**

Test `start-tf.sh` with disposable files. It must load the heartbeat map only from
the configured file, reject unreadable/empty/oversized content, and avoid printing
it. Existing database URL loading remains unchanged. Search startup must similarly
load only its two owning secrets without exposing them.

- [ ] **Step 3: Write the RED smoke contract**

The smoke script must:

1. reject non-local Docker selectors before Docker invocation;
2. generate a unique Compose project and three new canary secrets plus existing TF
   secrets in a verified workspace-local temporary directory;
3. build/start API dependencies, API, and `tf-search`;
4. use deterministic fixture adapters, not public network providers;
5. verify module `/healthz` and `/readyz`;
6. verify invalid/stale/replayed signed commands fail before adapters;
7. exercise a real public Platform-policy-gated search path;
8. observe `search-media` heartbeat version/RPM in admin snapshot;
9. restart API, observe unknown, then healthy after heartbeat;
10. inspect rendered config/logs for secret/query/account leakage;
11. always run project-scoped `down -v --remove-orphans`;
12. remove temporary files and verify zero matching containers, networks, volumes,
    or temporary directories.

Container execution remains gated behind an explicit environment flag in unit
tests; fake-Docker behavior runs by default.

- [ ] **Step 4: Run focused tests and verify RED**

```bash
pnpm --filter @workspace/api-server test -- src/deployment-contract.test.ts src/admin-config-contract.test.ts
pnpm --filter @workspace/tf-search test -- src/deployment-contract.test.ts src/smoke.test.ts
```

Expected: fail because service/secrets/networks/smoke are absent.

- [ ] **Step 5: Implement Compose and smoke delivery**

Add `tf-search-control` as internal and `tf-search-egress` only for the module.
Pass local-only flags explicitly. Add health-dependent API startup only where it
does not create a heartbeat dependency cycle: API may wait for search readiness,
while search never waits for API readiness.

Document one-replica/cache/replay limitations, exact secrets, same-node DNS,
HTTPS-only cross-node mode, clock synchronization, and the no-domain/no-remote
mutation status.

- [ ] **Step 6: Run Task 5 validation**

```bash
pnpm --filter @workspace/api-server test -- src/deployment-contract.test.ts src/admin-config-contract.test.ts
pnpm --filter @workspace/tf-search test
pnpm --filter @workspace/tf-search typecheck
pnpm --filter @workspace/api-server typecheck
docker compose config
docker compose -f artifacts/api-server/docker-compose.yml config
```

Use disposable canary secret files for both Compose renders and remove them after
absolute-path containment checks. Then run the explicit local smoke and verify its
cleanup audit.

- [ ] **Step 7: Commit Task 5**

```bash
git add docker-compose.yml artifacts/api-server/docker-compose.yml artifacts/api-server/container/start-tf.sh artifacts/api-server/src/deployment-contract.test.ts artifacts/api-server/src/admin-config-contract.test.ts artifacts/tf-search .dockerignore MODULES.md
git commit -m "feat(tf-search): add isolated container stack"
```

---

### Task 6: Integrated Validation And Release Record

**Files:**
- Modify: `IMPLEMENTATION_STATUS.md`
- Modify: `docs/superpowers/plans/2026-07-24-tf-search-container.md`

**Interfaces:**
- Consumes all Task 1-5 behavior.
- Produces an independently reviewed feature branch ready for merge to `main`.

- [ ] **Step 1: Run the complete local matrix**

```bash
pnpm install --frozen-lockfile
pnpm --filter @workspace/module-runtime-contract test
pnpm --filter @workspace/tf-search-contract test
pnpm --filter @workspace/tf-search test
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/music-player test
pnpm run typecheck
pnpm --filter @workspace/tf-search build
pnpm --filter @workspace/api-server build
pnpm --filter @workspace/music-player build
node --check artifacts/tf-search/dist/index.mjs
node --check artifacts/api-server/dist/index.mjs
git diff --check
```

Run both exact Compose renders and the Task 5 disposable smoke with verified
cleanup. Scan both production bundles for unresolved `@workspace/` imports and
scan tracked/runtime files for browser secrets, database credentials in
`tf-search`, legacy in-process provider imports in `tf-api`, raw secret values,
and control-plane access.

- [ ] **Step 2: Record exact implementation state**

Update `IMPLEMENTATION_STATUS.md` in the existing output format:

- `Что сделано`
- `Validation`
- `Commit/push`
- `Следующий логичный этап реализации`

Record exact test counts, build/bundle sizes, Compose/smoke cleanup evidence,
review verdicts, branch/commit hashes, no-domain status, and the fact that
HomeNode/Coolify/Caddy/UFW/DNS were not changed. Set the next stage to
`tf-integrations` container extraction using the same reviewed boundary.

- [ ] **Step 3: Commit the release record**

```bash
git add IMPLEMENTATION_STATUS.md docs/superpowers/plans/2026-07-24-tf-search-container.md
git commit -m "docs: record tf search container validation"
```

- [ ] **Step 4: Independent whole-branch review**

Generate a merge-base-to-HEAD review package. The reviewer must return:

```text
SPEC PASS
QUALITY APPROVED
READY TO MERGE YES
```

Fix all Critical and Important findings in one consolidated pass, rerun their
covering tests, and request re-review. Do not merge with an open finding.

- [ ] **Step 5: Publish, merge, and revalidate**

Push `codex/feat/tf-search-container`, fast-forward merge into `main`, rerun the
Task 6 matrix on merged `main`, push `main`, and confirm both remote refs. Do not
remove the worktree until publication and merged-result validation are confirmed.

---

## Self-Review

- Spec coverage: public policy preservation, strict signed contracts, complete
  provider-search ownership, bounded cache, heartbeat, secret scope, Compose
  isolation, cross-node HTTPS, local smoke, and remote-mutation gates map to Tasks
  1 through 6.
- Scope: only `tf-search` is extracted; integrations, download worker, remote
  rollout, domains, Caddy, UFW, HomeNode, and Android remain separate.
- Type consistency: command/response paths, secret names, service/module IDs,
  headers, schemas, and gateway names are consistent across tasks.
- Completeness scan: every error, validation, test, and cleanup behavior required
  by this stage is assigned to an exact task.
