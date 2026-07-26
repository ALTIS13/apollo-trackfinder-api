# TF Download Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move normal web downloads from the public API process into a
dedicated, least-privilege, queue-driven `tf-download-worker` container while
keeping the API as the sole browser authorization and file-access boundary.

**Architecture:** The API is a fail-closed BullMQ producer/status/cancel client
for a dedicated queue Redis. A single-replica worker validates jobs again,
downloads into its own bounded volume, and serves completed bytes only through
an exact HMAC-signed internal POST that the API proxies without full buffering.
The web queues, polls, cancels, and downloads through the existing authenticated
API routes.

**Tech Stack:** TypeScript, Node.js, Express 5, BullMQ, ioredis, Zod, React 19,
TanStack Query, Vitest, pnpm, Docker Compose, Redis 7, `yt-dlp`, and `ffmpeg`.

## Global Constraints

- Baseline is `a6c7bca84e3334ef28022947b147d16ea3d283da`; design commit is
  `6c7403d`.
- Design source of truth:
  `docs/superpowers/specs/2026-07-26-tf-download-worker-design.md`.
- Every behavior change follows RED -> verify RED -> GREEN -> verify GREEN.
- The API remains the only browser session, CSRF, entitlement, queue admission,
  ownership, and public file authorization boundary.
- Normal web downloads use `tf-download-worker`; the foreground direct download
  and audio-stream routes remain only for deferred Android/playback
  compatibility.
- Production has no in-memory download worker and no silent queue fallback.
- Queue data is untrusted and is strictly revalidated by the worker.
- Queue name is `apollo-tf-downloads-v1`.
- Queue capacity is 200 waiting plus active jobs; public batches are at most 50.
- Worker concurrency is 2; job deadline is 30 minutes; hard output limit is
  1 GiB; completed-file TTL is 24 hours; default storage quota is 20 GiB.
- The first release has exactly one worker replica.
- Internal HMAC covers exact raw request bytes, exact method/path, Unix
  timestamp, canonical nonce, and SHA-256 body hash.
- Replay state is account-partitioned, bounded, retains live nonces for the
  complete signed validity window, and returns explicit capacity failure.
- Worker image runs as UID/GID `10001:10001`, read-only root, dropped
  capabilities, `no-new-privileges`, bounded tmpfs/PIDs/CPU/memory, and one
  writable owned volume.
- Secrets are file-backed. No source URL, account ID, child stderr, absolute
  path, queue URL, signature, or secret may appear in public output or logs.
- No HomeNode, Coolify, Caddy, UFW, DNS, domain, firewall, or Android mutation.
- Serious changes stay on `codex/feat/tf-download-worker`; merge to `main` only
  after independent review and full validation.

## File Structure

### Shared contract

- Create `lib/tf-download-contract/package.json`
- Create `lib/tf-download-contract/tsconfig.json`
- Create `lib/tf-download-contract/src/index.ts`
- Create `lib/tf-download-contract/src/index.test.ts`
- Modify `tsconfig.json`
- Modify `pnpm-lock.yaml`

### API boundary

- Modify `artifacts/api-server/package.json`
- Modify `artifacts/api-server/Dockerfile`
- Modify `artifacts/api-server/build.mjs`
- Modify `artifacts/api-server/src/index.ts`
- Modify `artifacts/api-server/src/lib/background-queue.ts`
- Modify `artifacts/api-server/src/lib/background-queue.test.ts`
- Replace `artifacts/api-server/src/lib/background-queue-ownership.test.ts`
  coverage with producer/status/cancel ownership tests
- Create `artifacts/api-server/src/lib/tf-download-worker-client.ts`
- Create `artifacts/api-server/src/lib/tf-download-worker-client.test.ts`
- Modify `artifacts/api-server/src/lib/admin-telemetry.ts`
- Modify `artifacts/api-server/src/lib/admin-telemetry.test.ts`
- Modify `artifacts/api-server/src/lib/module-heartbeat.ts`
- Modify `artifacts/api-server/src/lib/module-heartbeat.test.ts`
- Modify `artifacts/api-server/src/routes/tracks.ts`
- Modify `artifacts/api-server/src/routes/tracks.test.ts`
- Modify `artifacts/api-server/src/lib/tf-policy.ts`
- Modify `artifacts/api-server/src/lib/tf-policy.test.ts`
- Modify `artifacts/api-server/src/routes/policy-coverage.test.ts`

### Worker

- Create `artifacts/tf-download-worker/package.json`
- Create `artifacts/tf-download-worker/tsconfig.json`
- Create `artifacts/tf-download-worker/build.mjs`
- Create `artifacts/tf-download-worker/Dockerfile`
- Create `artifacts/tf-download-worker/container/start-worker.sh`
- Create `artifacts/tf-download-worker/container/start-queue-redis.sh`
- Create `artifacts/tf-download-worker/container/queue-redis-health.sh`
- Create `artifacts/tf-download-worker/src/config.ts`
- Create `artifacts/tf-download-worker/src/config.test.ts`
- Create `artifacts/tf-download-worker/src/logger.ts`
- Create `artifacts/tf-download-worker/src/internal-auth.ts`
- Create `artifacts/tf-download-worker/src/internal-auth.test.ts`
- Create `artifacts/tf-download-worker/src/cancellation.ts`
- Create `artifacts/tf-download-worker/src/storage.ts`
- Create `artifacts/tf-download-worker/src/storage.test.ts`
- Create `artifacts/tf-download-worker/src/downloader.ts`
- Create `artifacts/tf-download-worker/src/processor.ts`
- Create `artifacts/tf-download-worker/src/processor.test.ts`
- Create `artifacts/tf-download-worker/src/app.ts`
- Create `artifacts/tf-download-worker/src/app.test.ts`
- Create `artifacts/tf-download-worker/src/heartbeat.ts`
- Create `artifacts/tf-download-worker/src/heartbeat.test.ts`
- Create `artifacts/tf-download-worker/src/index.ts`
- Create `artifacts/tf-download-worker/src/index.runtime.test.ts`
- Create `artifacts/tf-download-worker/src/deployment-contract.test.ts`
- Create `artifacts/tf-download-worker/src/smoke.test.ts`

### Public contract and web

- Modify `lib/api-spec/openapi.yaml`
- Regenerate `lib/api-client-react/src/generated/*`
- Regenerate `lib/api-zod/src/generated/*`
- Create `artifacts/music-player/src/hooks/use-track-download.ts`
- Create `artifacts/music-player/src/hooks/use-track-download.test.tsx`
- Modify `artifacts/music-player/src/components/TrackCard.tsx`
- Create or modify `artifacts/music-player/src/components/TrackCard.test.tsx`

### Deployment and records

- Modify `docker-compose.yml`
- Modify `artifacts/api-server/docker-compose.yml`
- Modify `.dockerignore`
- Modify `MODULES.md`
- Modify `IMPLEMENTATION_STATUS.md`

---

### Task 1: Strict Download Contract

**Files:**

- Create: `lib/tf-download-contract/package.json`
- Create: `lib/tf-download-contract/tsconfig.json`
- Create: `lib/tf-download-contract/src/index.ts`
- Create: `lib/tf-download-contract/src/index.test.ts`
- Modify: `tsconfig.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces `DOWNLOAD_QUEUE_NAME = "apollo-tf-downloads-v1"`.
- Produces `DOWNLOAD_MAX_FILE_BYTES = 1_073_741_824`.
- Produces `downloadQualitySchema`, `downloadJobDataSchema`,
  `downloadJobResultSchema`, `downloadJobStatusSchema`,
  `downloadFileCommandSchema`, and all inferred TypeScript types.
- Produces `parseAllowedDownloadSourceUrl(value): URL | null`.
- Consumed by every later task.

- [ ] **Step 1: Create package metadata and a failing schema test**

Create the package with:

```json
{
  "name": "@workspace/tf-download-contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "zod": "catalog:" },
  "devDependencies": {
    "@types/node": "catalog:",
    "vitest": "^4.0.18"
  }
}
```

The first test must require exact strict parsing:

```ts
expect(() =>
  downloadJobDataSchema.parse({
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    trackId: "yt_example",
    artist: "Artist",
    title: "Title",
    quality: "320",
    sourceUrl: "https://www.youtube.com/watch?v=example",
    createdAt: "2026-07-26T00:00:00.000Z",
    unexpected: true,
  }),
).toThrow();
```

Add tests for UUID account IDs, each quality, all bounded strings, invalid
dates, `http`, credentials, ports, fragments, Unicode host confusion, and
allowed exact/subdomain hosts for YouTube, SoundCloud, Bandcamp, Deezer, and
`dzcdn.net`.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --dir lib/tf-download-contract test
```

Expected: FAIL because `src/index.ts` and exported schemas do not exist.

- [ ] **Step 3: Implement the strict versioned contract**

Use strict Zod objects and these public shapes:

```ts
export interface DownloadJobData {
  readonly schemaVersion: 1;
  readonly accountId: string;
  readonly trackId: string;
  readonly artist: string;
  readonly title: string;
  readonly quality: DownloadQuality;
  readonly sourceUrl: string;
  readonly createdAt: string;
}

export interface DownloadJobResult {
  readonly schemaVersion: 1;
  readonly storageKey: string;
  readonly fileSize: number;
  readonly mimeType: "audio/mpeg" | "audio/flac";
  readonly filename: string;
  readonly completedAt: string;
}

export interface DownloadFileCommand {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly accountId: string;
  readonly jobId: string;
  readonly range?: { readonly start: number; readonly end?: number };
}
```

Allow only `https`, empty credentials, default port, and empty hash. Compare
hostnames after URL parsing with exact or dot-boundary suffix matching. Storage
keys are UUID job IDs plus `.mp3` or `.flac`; filenames reject CR/LF, slash,
backslash, NUL, and lengths above 255.

- [ ] **Step 4: Verify GREEN and package integration**

Run:

```powershell
pnpm install --frozen-lockfile
pnpm --dir lib/tf-download-contract test
pnpm --dir lib/tf-download-contract typecheck
pnpm run typecheck:libs
git diff --check
```

Expected: all contract tests and typechecks pass; lockfile changes include only
the new workspace package closure.

- [ ] **Step 5: Commit**

```powershell
git add lib/tf-download-contract tsconfig.json pnpm-lock.yaml
git commit -m "feat(downloads): add strict worker contract"
```

---

### Task 2: Fail-Closed API Queue Producer

**Files:**

- Modify: `artifacts/api-server/package.json`
- Modify: `artifacts/api-server/Dockerfile`
- Modify: `artifacts/api-server/build.mjs`
- Modify: `artifacts/api-server/src/index.ts`
- Modify: `artifacts/api-server/src/lib/background-queue.ts`
- Modify: `artifacts/api-server/src/lib/background-queue.test.ts`
- Modify: `artifacts/api-server/src/lib/background-queue-ownership.test.ts`
- Modify: `artifacts/api-server/src/lib/admin-telemetry.ts`
- Modify: `artifacts/api-server/src/lib/admin-telemetry.test.ts`

**Interfaces:**

- Consumes Task 1 job/result/status schemas.
- Produces `initBackgroundQueues`, `shutdownBackgroundQueues`,
  `enqueueDownload`, `getDownloadJobStatus`, `listSessionDownloadJobs`,
  `cancelDownloadJob`, and `getDownloadQueueTelemetry`.
- Produces `DownloadQueueUnavailableError` with public code
  `download_queue_unavailable`.
- No longer produces `getDownloadFilePath`.

- [ ] **Step 1: Write failing producer-only and fail-closed tests**

Tests must prove:

```ts
expect(queueRuntimeState()).toEqual({
  backend: "unavailable",
  workerEmbedded: false,
});
await expect(enqueueDownload(validJob)).rejects.toBeInstanceOf(
  DownloadQueueUnavailableError,
);
```

Add injected fake Queue/ioredis tests proving:

- no `Worker` is constructed or imported;
- config requires a readable 1..2,048 byte
  `TF_DOWNLOAD_QUEUE_REDIS_URL_FILE`;
- local `redis://tf-download-redis:6379/0` requires the explicit same-node flag;
- non-private and cross-node origins require `rediss://`;
- waiting plus active `>= 200` rejects before `add`;
- queue job data is Task 1 strict data with `accountId`, never `sessionId`;
- no in-memory enqueue/process fallback exists;
- telemetry failure stays `unknown` and never switches backend;
- list/status hide foreign and malformed-owner jobs;
- waiting cancellation removes the job;
- active cancellation writes
  `apollo-tf-downloads-v1:cancel:<jobId>` with bounded TTL;
- completed/canceled cancellation is idempotent;
- raw BullMQ/Redis errors are mapped to the sanitized unavailable error.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --dir artifacts/api-server exec vitest run `
  src/lib/background-queue.test.ts `
  src/lib/background-queue-ownership.test.ts
```

Expected: FAIL because the API still embeds `Worker`, local storage, downloader,
and in-memory processing.

- [ ] **Step 3: Implement the producer/status/cancel adapter**

Keep three isolated clients:

```ts
interface DownloadQueueClients {
  readonly producer: Queue<DownloadJobData, DownloadJobResult>;
  readonly telemetry: Queue<DownloadJobData, DownloadJobResult>;
  readonly cancellation: Redis;
}
```

Use bounded producer/telemetry connection settings. `initBackgroundQueues`
must validate config, create clients, and fail startup in production instead of
falling back. `shutdownBackgroundQueues` closes every owned client with
`Promise.allSettled`.

Set job options:

```ts
{
  attempts: 2,
  backoff: { type: "fixed", delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 200 },
  removeOnFail: { age: 86_400, count: 200 },
}
```

Map BullMQ states to `waiting | active | completed | failed | canceled |
unknown`. Treat the bounded non-retriable cancellation code as `canceled`.

- [ ] **Step 4: Update startup and telemetry boundaries**

Remove API-owned worker state and downloader ownership tests. Preserve separate
queue telemetry connection and coalesced admin behavior. Admin status is:

```ts
{
  depth?: number;
  status: "healthy" | "unknown";
  redisStatus: "healthy" | "unknown";
}
```

Queue startup failure must prevent API readiness; a later telemetry failure
must not destroy the producer client.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
pnpm --dir artifacts/api-server exec vitest run `
  src/lib/background-queue.test.ts `
  src/lib/background-queue-ownership.test.ts `
  src/lib/admin-telemetry.test.ts `
  src/lib/server-startup.test.ts
pnpm --dir artifacts/api-server typecheck
git diff --check
```

Expected: all selected tests pass and source/dependency scans find no
`new Worker` or background `spawnAudioDownload` in `background-queue.ts`.

- [ ] **Step 6: Commit**

```powershell
git add artifacts/api-server pnpm-lock.yaml
git commit -m "refactor(api): isolate download queue producer"
```

---

### Task 3: Worker Download Engine And Owned Storage

**Files:**

- Create: `artifacts/tf-download-worker/package.json`
- Create: `artifacts/tf-download-worker/tsconfig.json`
- Create: `artifacts/tf-download-worker/build.mjs`
- Create: `artifacts/tf-download-worker/src/logger.ts`
- Create: `artifacts/tf-download-worker/src/cancellation.ts`
- Create: `artifacts/tf-download-worker/src/storage.ts`
- Create: `artifacts/tf-download-worker/src/storage.test.ts`
- Create: `artifacts/tf-download-worker/src/downloader.ts`
- Create: `artifacts/tf-download-worker/src/processor.ts`
- Create: `artifacts/tf-download-worker/src/processor.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes Task 1 queue/job/result schemas.
- Produces `DownloadStorage`, `DownloadCancellationStore`,
  `createDownloadProcessor`, and `spawnYtDlpDownload`.
- Processor signature:

```ts
type DownloadProcessor = (
  job: Job<DownloadJobData, DownloadJobResult>,
  signal: AbortSignal,
) => Promise<DownloadJobResult>;
```

- [ ] **Step 1: Write failing storage tests**

Use a disposable owned directory and test:

- exclusive `<jobId>.<ext>.part` creation;
- path containment and opaque UUID storage keys;
- regular-file and no-symlink requirements;
- hard 1 GiB logical writer limit with a small injected test limit;
- close plus atomic rename before result visibility;
- partial removal on error/cancel;
- startup sweep removes `.part`;
- 24-hour expiry;
- 20 GiB quota with injected small quota;
- quota sweep orders expired/oldest owned files and never follows/removes
  foreign entries.

The RED assertion must call the wished-for API:

```ts
const output = await storage.begin(jobId, "mp3");
await output.write(Buffer.alloc(33));
await expect(output.commit(metadata)).rejects.toThrow("output_too_large");
```

- [ ] **Step 2: Verify storage RED**

Run:

```powershell
pnpm --dir artifacts/tf-download-worker exec vitest run src/storage.test.ts
```

Expected: FAIL because the worker package and storage implementation do not
exist.

- [ ] **Step 3: Implement minimal storage and verify GREEN**

Use `open` with exclusive creation, `lstat`, resolved-path containment,
streamed byte accounting, file handle sync/close, and same-directory `rename`.
All cleanup accepts only paths created and tracked by the current operation.

Run:

```powershell
pnpm --dir artifacts/tf-download-worker exec vitest run src/storage.test.ts
```

Expected: PASS.

- [ ] **Step 4: Write failing processor tests**

Inject a fake downloader process and cancellation store. Prove:

- strict job parse and source revalidation precede spawn;
- progress starts at 5 and reaches 100 only after commit;
- cancellation before spawn never creates a child;
- active cancellation is observed within the 250 ms polling contract and kills
  the child;
- abort/deadline kills child and removes partial output;
- output limit failure is non-retriable;
- process failure removes partial output and emits bounded categorical error;
- one success returns strict metadata with no absolute path;
- source URL, account ID, filename, and stderr are absent from logger calls.

Use a named `DownloadProcessingError`:

```ts
new DownloadProcessingError(
  "download_canceled" |
  "invalid_job" |
  "source_not_allowed" |
  "download_failed" |
  "output_too_large" |
  "deadline_exceeded" |
  "storage_quota_exceeded" |
  "storage_unavailable",
  { retriable: boolean },
);
```

- [ ] **Step 5: Verify processor RED**

Run:

```powershell
pnpm --dir artifacts/tf-download-worker exec vitest run src/processor.test.ts
```

Expected: FAIL because processor/downloader do not exist.

- [ ] **Step 6: Implement processor and verify GREEN**

Use one absolute deadline, one `AbortController`, a 250 ms cancellation poll,
and child termination escalation. Never retain or emit stderr; consume it into
a bounded sink. Map non-retriable errors to BullMQ `UnrecoverableError` at the
runtime adapter, not inside storage.

Run:

```powershell
pnpm --dir artifacts/tf-download-worker test
pnpm --dir artifacts/tf-download-worker typecheck
git diff --check
```

Expected: storage/processor tests and package typecheck pass.

- [ ] **Step 7: Commit**

```powershell
git add artifacts/tf-download-worker pnpm-lock.yaml
git commit -m "feat(downloads): add worker download engine"
```

---

### Task 4: Signed Internal File Stream

**Files:**

- Create: `artifacts/tf-download-worker/src/internal-auth.ts`
- Create: `artifacts/tf-download-worker/src/internal-auth.test.ts`
- Create: `artifacts/tf-download-worker/src/app.ts`
- Create: `artifacts/tf-download-worker/src/app.test.ts`
- Create: `artifacts/api-server/src/lib/tf-download-worker-client.ts`
- Create: `artifacts/api-server/src/lib/tf-download-worker-client.test.ts`
- Modify: `artifacts/api-server/src/routes/tracks.ts`
- Modify: `artifacts/api-server/src/routes/tracks.test.ts`

**Interfaces:**

- Worker produces exact `POST /v1/files`, `GET /healthz`, and `GET /readyz`.
- API produces:

```ts
interface TfDownloadWorkerGateway {
  openFile(input: {
    accountId: string;
    jobId: string;
    range?: { start: number; end?: number };
    signal: AbortSignal;
  }): Promise<{
    status: 200 | 206;
    body: ReadableStream<Uint8Array>;
    contentLength: number;
    contentType: "audio/mpeg" | "audio/flac";
    contentDisposition: string;
    contentRange?: string;
  }>;
}
```

- [ ] **Step 1: Write failing raw-byte authentication tests**

Tests must prove signature-first behavior, exact target, no query/trailing
slash, stale/future timestamp rejection, canonical 32-byte nonce, duplicate
rejection, full 60-second live retention, account partition isolation, and
explicit partition/account capacity outcome.

Use two-phase API:

```ts
const verified = authenticator.verifySignature(rawRequest);
const admitted = authenticator.claim({
  accountId: command.accountId,
  nonce: verified.nonce,
});
```

Capacity is not reported as generic unauthorized. No live nonce is evicted.

- [ ] **Step 2: Verify auth RED, implement, and verify GREEN**

Run RED, implement only the authenticator, then run:

```powershell
pnpm --dir artifacts/tf-download-worker exec vitest run src/internal-auth.test.ts
```

Expected GREEN: all authentication/replay tests pass.

- [ ] **Step 3: Write failing worker file-app tests**

Inject fake queue lookup and storage. Prove:

- auth precedes JSON parsing;
- malformed/extra command fields return `400` only after valid auth;
- replay/invalid signature returns `401`;
- replay-capacity returns `503`;
- unknown, foreign, expired, missing, metadata-mismatch, symlink, and
  non-regular output all return indistinguishable `404`;
- waiting/active returns `409`;
- completed exact owner streams `200`;
- valid single range streams `206`;
- invalid/multiple/out-of-bounds range returns `416`;
- body length never exceeds strict result metadata or 1 GiB;
- disconnect abort closes the owned file stream;
- response headers contain no path/account/source/internal values.

- [ ] **Step 4: Implement file app and verify GREEN**

Capture exact raw JSON bytes before parsing. Claim replay only after strict
command/account parse. Use bounded headers:

```text
Content-Type
Content-Length
Content-Disposition
Accept-Ranges: bytes
Content-Range (206 only)
Cache-Control: private, no-store
```

Run:

```powershell
pnpm --dir artifacts/tf-download-worker exec vitest run `
  src/internal-auth.test.ts src/app.test.ts
```

- [ ] **Step 5: Write failing API gateway/proxy tests**

Prove exact file command serialization/signature, no redirects, exact origin,
HTTPS-by-default, bounded timeout to response headers, browser abort
propagation, strict status/header parsing, max length, no full-file buffering,
sanitized error mapping, and range forwarding.

Modify route dependencies so file serving uses `TfDownloadWorkerGateway`; remove
all `existsSync`, `statSync`, `path`, and `createReadStream` file access from
the public file route.

- [ ] **Step 6: Implement API gateway/proxy and verify GREEN**

Configuration:

```text
TF_DOWNLOAD_WORKER_ORIGIN
TF_DOWNLOAD_WORKER_ALLOW_INSECURE_HTTP
TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE
```

The public route maps worker `404/409/416/503`, forwards only allowlisted
headers, and pipes via `Readable.fromWeb` or equivalent backpressure-aware
streaming. Client disconnect aborts the worker fetch.

Run:

```powershell
pnpm --dir artifacts/api-server exec vitest run `
  src/lib/tf-download-worker-client.test.ts src/routes/tracks.test.ts
pnpm --dir artifacts/api-server typecheck
pnpm --dir artifacts/tf-download-worker typecheck
git diff --check
```

- [ ] **Step 7: Commit**

```powershell
git add artifacts/tf-download-worker artifacts/api-server
git commit -m "feat(downloads): add signed worker file stream"
```

---

### Task 5: Runtime, Heartbeat, And Hardened Image

**Files:**

- Create: `artifacts/tf-download-worker/src/config.ts`
- Create: `artifacts/tf-download-worker/src/config.test.ts`
- Create: `artifacts/tf-download-worker/src/heartbeat.ts`
- Create: `artifacts/tf-download-worker/src/heartbeat.test.ts`
- Create: `artifacts/tf-download-worker/src/index.ts`
- Create: `artifacts/tf-download-worker/src/index.runtime.test.ts`
- Create: `artifacts/tf-download-worker/container/start-worker.sh`
- Create: `artifacts/tf-download-worker/build.mjs`
- Create: `artifacts/tf-download-worker/Dockerfile`
- Modify: `artifacts/api-server/src/lib/module-heartbeat.ts`
- Modify: `artifacts/api-server/src/lib/module-heartbeat.test.ts`
- Modify: `artifacts/api-server/Dockerfile`
- Modify: `artifacts/api-server/build.mjs`

**Interfaces:**

- Worker config uses only file-backed Redis, internal command, and heartbeat
  secrets.
- Runtime starts one BullMQ Worker at concurrency 2, one internal HTTP server,
  one sweeper, and one heartbeat loop.
- API startup requires configured heartbeat keys for `search-media`,
  `account-integrations`, and `download-worker`.

- [ ] **Step 1: Write failing configuration tests**

Require:

```text
TF_DOWNLOAD_QUEUE_REDIS_URL_FILE
TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE
TF_DOWNLOAD_HEARTBEAT_SECRET_FILE
TF_DOWNLOAD_HEARTBEAT_API_ORIGIN
TF_DOWNLOAD_STORAGE_ROOT
```

Optional bounded version/deploy time and numeric limits must accept only exact
documented ranges. Secrets are 32..512 bytes; files are bounded and read once.
Storage root must be absolute, normalized, and exactly the configured value.
Cross-node origins require HTTPS/rediss; private same-node HTTP/redis require
explicit flags.

- [ ] **Step 2: Verify config RED, implement, verify GREEN**

```powershell
pnpm --dir artifacts/tf-download-worker exec vitest run src/config.test.ts
```

- [ ] **Step 3: Write failing heartbeat/runtime tests**

Heartbeat tests copy established module-runtime signing and prove exact
`download-worker` path, 30-second interval, first send after readiness, stop
ordering, bounded counters, no post-shutdown send, and sanitized statuses.

Runtime tests prove:

- storage sweep and queue readiness complete before listen;
- Worker is configured with exact queue name/concurrency;
- non-retriable processing errors become `UnrecoverableError`;
- SIGTERM stops admission, closes HTTP, waits bounded active work, closes
  BullMQ/Redis/storage, then stops heartbeat;
- a shutdown timeout aborts active jobs and removes owned partial output;
- provider reachability is absent from readiness;
- configuration errors are generic.

- [ ] **Step 4: Implement heartbeat/runtime and verify GREEN**

Run:

```powershell
pnpm --dir artifacts/tf-download-worker exec vitest run `
  src/config.test.ts src/heartbeat.test.ts src/index.runtime.test.ts
```

- [ ] **Step 5: Write failing image/build boundary tests**

Tests inspect Dockerfile/build output and require:

- pinned `pnpm@10.33.2`;
- pinned/hash-verified `yt-dlp` version from the existing API image;
- `ffmpeg`;
- UID/GID `10001`;
- immutable app tree;
- owned storage directory;
- no shell package manager at runtime after build;
- runtime bundle imports no TF/Platform DB, session/cache Redis, provider
  credentials, Docker, SSH, Caddy, or Coolify library;
- API image includes the shared download contract/client but does not include
  worker engine/storage files.

- [ ] **Step 6: Implement build/image and verify GREEN**

Build `dist/index.mjs` and any Pino worker assets needed by the logger. The
entrypoint verifies file readability and storage ownership without printing
values.

Run:

```powershell
pnpm --dir artifacts/tf-download-worker build
pnpm --dir artifacts/tf-download-worker typecheck
pnpm --dir artifacts/api-server build
pnpm --dir artifacts/api-server typecheck
git diff --check
```

- [ ] **Step 7: Commit**

```powershell
git add artifacts/tf-download-worker artifacts/api-server pnpm-lock.yaml
git commit -m "feat(downloads): add worker runtime and heartbeat"
```

---

### Task 6: Public Queue Contract And Web Cutover

**Files:**

- Modify: `artifacts/api-server/src/routes/tracks.ts`
- Modify: `artifacts/api-server/src/routes/tracks.test.ts`
- Modify: `artifacts/api-server/src/lib/tf-policy.ts`
- Modify: `artifacts/api-server/src/lib/tf-policy.test.ts`
- Modify: `artifacts/api-server/src/routes/policy-coverage.test.ts`
- Modify: `lib/api-spec/openapi.yaml`
- Regenerate: `lib/api-client-react/src/generated/*`
- Regenerate: `lib/api-zod/src/generated/*`
- Create: `artifacts/music-player/src/hooks/use-track-download.ts`
- Create: `artifacts/music-player/src/hooks/use-track-download.test.tsx`
- Modify: `artifacts/music-player/src/components/TrackCard.tsx`
- Create or modify: `artifacts/music-player/src/components/TrackCard.test.tsx`

**Interfaces:**

- Produces OpenAPI operation IDs:
  `queueTrackDownloads`, `listDownloadJobs`, `getDownloadJobStatus`,
  `getDownloadJobFile`, and `cancelDownloadJob`.
- Web hook produces:

```ts
interface TrackDownloadController {
  readonly state:
    | "idle" | "waiting" | "active" | "completed"
    | "failed" | "canceled";
  readonly progress: number;
  readonly start: (track: TrackResult, quality?: DownloadQuality) => Promise<void>;
  readonly cancel: () => Promise<void>;
}
```

- [ ] **Step 1: Write failing API route/policy tests**

Prove:

- strict body and max 50;
- invalid quality is rejected, not normalized;
- source URL is derived server-side and raw caller URL cannot bypass allowlist;
- Deezer fallback asks `tf-search` only with live `tf.search` entitlement;
- queue unavailable/capacity errors are sanitized `503`;
- exact account ID is supplied to every operation;
- list/status/file/cancel hide foreign jobs;
- file waiting is `409`, unknown is `404`, invalid range is `416`;
- cancel requires CSRF and `tf.downloads`;
- route registry/policy coverage has every exact method/path.

- [ ] **Step 2: Verify API RED, implement, verify GREEN**

Run:

```powershell
pnpm --dir artifacts/api-server exec vitest run `
  src/routes/tracks.test.ts `
  src/lib/tf-policy.test.ts `
  src/routes/policy-coverage.test.ts
```

- [ ] **Step 3: Update OpenAPI and regenerate clients**

Define strict component schemas for queue inputs/results, job status, list,
cancel response, errors, and binary file response with Range header. Then run:

```powershell
pnpm --dir lib/api-spec codegen
pnpm run typecheck:libs
git diff --check
```

Do not manually edit generated files after codegen.

- [ ] **Step 4: Write failing web hook/card tests**

With fake timers and mocked generated calls, prove:

- click queues exactly one track;
- one poll is active at a time;
- polling occurs only in waiting/active and uses bounded backoff;
- progress is clamped 0..100;
- completed creates one authenticated API file navigation;
- cancel mutation stops polling and renders canceled;
- failure renders bounded user feedback;
- `401/403/409` are forwarded through `reportTfAuthError`;
- unmount aborts polling and never starts a stale download;
- button uses Download, Loader, and X icons with accessible labels and stable
  dimensions.

- [ ] **Step 5: Verify web RED, implement, verify GREEN**

Use the existing card style and `apiUrl` helper. Do not add a page or redesign
the card. The progress label stays inside the existing action area and cannot
resize the card.

Run:

```powershell
pnpm --dir artifacts/music-player exec vitest run `
  src/hooks/use-track-download.test.tsx `
  src/components/TrackCard.test.tsx
pnpm --dir artifacts/music-player typecheck
pnpm --dir artifacts/music-player build
```

- [ ] **Step 6: Run compatibility set**

```powershell
pnpm --dir artifacts/api-server exec vitest run `
  src/routes/tracks.test.ts `
  src/lib/tf-policy.test.ts `
  src/routes/policy-coverage.test.ts `
  src/app-auth-boundary.test.ts
pnpm --dir artifacts/music-player test
git diff --check
```

- [ ] **Step 7: Commit**

```powershell
git add artifacts/api-server artifacts/music-player lib/api-spec `
  lib/api-client-react lib/api-zod
git commit -m "feat(web): use queued download worker"
```

---

### Task 7: Compose, Real Smoke, And Operations Contract

**Files:**

- Create: `artifacts/tf-download-worker/container/start-queue-redis.sh`
- Create: `artifacts/tf-download-worker/container/queue-redis-health.sh`
- Create: `artifacts/tf-download-worker/src/deployment-contract.test.ts`
- Create: `artifacts/tf-download-worker/src/smoke.test.ts`
- Modify: `artifacts/tf-download-worker/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `artifacts/api-server/docker-compose.yml`
- Modify: `.dockerignore`
- Modify: `MODULES.md`

**Interfaces:**

- Produces services `tf-download-redis` and `tf-download-worker`.
- Produces networks `tf-download-queue`, `tf-download-control`, and
  `tf-download-egress`.
- Produces volume `tf-download-worker-data`.
- Produces file-backed secrets for queue password/URLs, internal command, and
  heartbeat.

- [ ] **Step 1: Write failing deployment-contract tests**

Parse root and nested YAML and require:

- identical worker/queue service contract;
- no host ports for worker or queue Redis;
- API and worker only on exact internal control/queue networks;
- worker alone on egress;
- worker has no TF data, integrations data, search control, or edge network;
- exact secrets assigned only to owners;
- no secret value in environment;
- read-only root, non-root user, init, cap drop, no-new-privileges, tmpfs,
  healthcheck, stop grace, PID/CPU/memory limits;
- exactly one worker replica;
- worker-owned volume only on worker;
- queue Redis has authentication, no host port, internal network, healthcheck,
  read-only root, and owned data volume;
- API no longer mounts `/tmp/tf-downloads`;
- API depends on healthy queue/worker and uses exact same-node private origins;
- no Docker socket, host mount, SSH, Caddy, Coolify, provider-account, TF DB, or
  Platform DB credential on worker.

- [ ] **Step 2: Verify deployment RED**

```powershell
pnpm --dir artifacts/tf-download-worker exec vitest run `
  src/deployment-contract.test.ts
```

Expected: FAIL because services/secrets/networks do not exist.

- [ ] **Step 3: Implement Redis image/startup and Compose**

Add a separate Dockerfile target based on `redis:7-bookworm`. Its entrypoint
reads the password file without echoing it and execs Redis with append-only
persistence. The health script reads the same file and runs a bounded local
PING without embedding the value in rendered Compose.

Root and nested API Compose use file-backed full queue URLs for API/worker and
distinct command/heartbeat secrets. Same-node insecure HTTP/redis flags are
explicit. The worker volume is mounted at the configured storage root.

- [ ] **Step 4: Verify deployment GREEN**

```powershell
pnpm --dir artifacts/tf-download-worker exec vitest run `
  src/deployment-contract.test.ts
docker compose config --quiet
docker compose -f artifacts/api-server/docker-compose.yml config --quiet
git diff --check
```

- [ ] **Step 5: Write failing offline real-Docker smoke**

The smoke must create an owner-scoped random project and generated canary
secrets in a private temporary directory, then prove:

- queue Redis, worker, and API become healthy;
- worker heartbeat reaches API and recovers after reset;
- one signed/owned fixture job reaches completed;
- worker stores authenticated nonempty bytes only in its volume;
- status/progress and file stream work;
- range returns exact bytes;
- replay/tamper/wrong-key/foreign-owner requests fail;
- waiting/active cancellation removes partial output;
- size/deadline/quota fixtures fail with bounded codes;
- API/worker inspect contains no forbidden secret or credential;
- source/account/signature/path/stderr canaries are absent from config, logs,
  responses, image history, tracked files, and inspect;
- no service publishes a host port;
- cleanup removes all owned containers, images, networks, volumes, and temp
  directories in `finally`.

Fixtures activate only under exact `NODE_ENV=test` plus
`TF_DOWNLOAD_SMOKE_FIXTURES=true`; production rejects the flag.

- [ ] **Step 6: Verify smoke RED, implement, verify GREEN**

```powershell
$env:TF_DOWNLOAD_SMOKE_REAL_DOCKER='1'
pnpm --dir artifacts/tf-download-worker exec vitest run src/smoke.test.ts
Remove-Item Env:TF_DOWNLOAD_SMOKE_REAL_DOCKER
```

Expected GREEN: all real smoke assertions pass and the post-test residue scan
reports zero owned resources.

- [ ] **Step 7: Document exact module contract**

Update `MODULES.md` with queue/HTTP/heartbeat paths, secret ownership,
same-node/cross-node rules, one-replica/storage limitation, public API flow,
limits, cancellation, cleanup, and explicit remote rollout gate. Do not include
real secret values, host addresses, or private inventory.

- [ ] **Step 8: Commit**

```powershell
git add artifacts/tf-download-worker docker-compose.yml `
  artifacts/api-server/docker-compose.yml .dockerignore MODULES.md
git commit -m "feat(downloads): add isolated worker stack"
```

---

### Task 8: Integrated Validation And Release Record

**Files:**

- Modify: `IMPLEMENTATION_STATUS.md`
- Modify: `MODULES.md` only if validation changes an operational fact
- Use ignored:
  `.superpowers/sdd/2026-07-26-tf-download-worker/*`

**Interfaces:**

- Consumes the complete Task 1-7 branch.
- Produces durable exact validation/review evidence and the next-stage record.

- [ ] **Step 1: Run independent task and whole-branch review**

Every task receives a fresh implementation review. After Task 7, generate an
authoritative `main..HEAD` review package and dispatch a fresh final reviewer.
No Critical or Important finding may remain. Scoped fixes follow the SDD
five-round cap and are rerun through focused review.

- [ ] **Step 2: Run full package validation**

```powershell
pnpm --dir lib/tf-download-contract test
pnpm --dir lib/tf-integrations-contract test
pnpm --dir lib/tf-integrations-db test
pnpm --dir artifacts/tf-download-worker test
pnpm --dir artifacts/tf-integrations test
pnpm --dir artifacts/api-server test
pnpm --dir artifacts/tf-search test
pnpm --dir artifacts/music-player test
pnpm run typecheck
pnpm --dir artifacts/tf-download-worker build
pnpm --dir artifacts/tf-integrations build
pnpm --dir artifacts/api-server build
pnpm --dir artifacts/music-player build
docker compose config --quiet
docker compose -f artifacts/api-server/docker-compose.yml config --quiet
git diff --check
```

Only explicit real-Redis/PostgreSQL/real-Docker gates may skip in the no-env
pass; every new download gate must then pass in its real integration run.

- [ ] **Step 3: Run real integration and security evidence**

Run:

- disposable authenticated Redis integration;
- real download Docker smoke;
- existing PostgreSQL 17 integration to prove no regression;
- DNS read-only checks `16/16` through `1.1.1.1` and `8.8.8.8`;
- exact source, bundle, rendered Compose, image, inspect, response, log, and Git
  diff canary scans;
- dependency scans proving worker has no forbidden credential/data/control
  packages and API has no worker engine/storage bundle;
- exact project container/network/volume/temp residue scan.

Do not mutate HomeNode/Coolify/Caddy/UFW/DNS.

- [ ] **Step 4: Record exact evidence**

Update the top current section of `IMPLEMENTATION_STATUS.md` with:

- immutable reviewed implementation tip;
- exact package pass/skip/fail/file counts;
- real Redis and Docker smoke counts;
- typecheck/build/Compose/diff results and bundle sizes;
- review verdicts;
- zero-residue and secret-scan counts;
- DNS `16/16`;
- no remote mutation;
- the next stage: read-only HomeNode/Coolify/Caddy preflight for the now-complete
  web/server stack, followed by explicit owner approval before rollout.

Preserve historical records.

- [ ] **Step 5: Commit release evidence**

```powershell
git add IMPLEMENTATION_STATUS.md MODULES.md
git commit -m "docs: record download worker validation"
```

- [ ] **Step 6: Publish and merge only after the gate**

```powershell
git fetch origin --prune
git push origin codex/feat/tf-download-worker
git merge-base --is-ancestor origin/main HEAD
```

If refs are unchanged and both worktrees are clean, fast-forward local `main`,
rerun the merged-result package/typecheck/build/Compose checks on the exact
same object ID, push `main`, and verify both remote refs with `git ls-remote`.
No force push.

## Plan Self-Review

- Tasks 1-7 cover every architecture, contract, cancellation, storage,
  streaming, health, heartbeat, web, container, and rollout requirement in the
  design.
- Task 8 covers independent review, complete validation, release evidence,
  push, merge, and remote-ref verification.
- Types are defined in Task 1 before use by API, worker, and web tasks.
- API queue interfaces are defined in Task 2 before worker/file/public route
  integration.
- Worker storage/processor exists before internal file serving and runtime.
- Public OpenAPI/web cutover occurs only after queue and file boundaries exist.
- Android, public worker ingress, object storage, multi-replica routing, and
  remote infrastructure mutation remain explicitly out of scope.
