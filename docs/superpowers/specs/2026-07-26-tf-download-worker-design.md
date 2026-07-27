# TF Download Worker Design

Date: 2026-07-26

Status: approved for implementation by the owner's direction to continue with
the next logical server stage. This design resolves implementation details from
the existing Apollo TF isolation, entitlement, Coolify, and web-first
requirements without reopening previously approved choices.

Amended: 2026-07-27 after release review to record the verified non-destructive
BullMQ cancellation protocol, lifecycle-fenced admission slots, and explicit
streaming `yt-dlp -> ffmpeg` conversion pipeline.

## Goal

Move queued audio downloads out of the public API process into a dedicated,
least-privilege `tf-download-worker` container that can run on the same Coolify
node or on a separately approved node. Keep the API as the only browser
session, CSRF, entitlement, queue admission, and file authorization boundary.

The first release must make the web download action use the queued worker path.
Android remains deferred. No HomeNode, Coolify, Caddy, UFW, DNS, or domain
mutation is part of local implementation.

## Existing State

- `artifacts/api-server/src/lib/background-queue.ts` currently creates the
  BullMQ producer and worker, invokes `yt-dlp`, stores absolute local paths, and
  silently falls back to an in-memory worker.
- Queue routes already bind enqueue, list, status, and file access to the
  canonical authenticated account and the `tf.downloads` capability.
- The web `TrackCard` still calls the legacy generated direct-download client
  and expects JSON while the current API route streams bytes.
- Module heartbeat and admin topology already know the logical
  `download-worker`, `queue-redis`, and `media-storage` module IDs, but no
  external download worker currently reports heartbeat.

## Approaches Considered

### 1. Shared API/worker filesystem

The API and worker would mount one volume and the API would serve completed
files directly.

Rejected: a Docker volume does not cross Coolify nodes, creates shared
filesystem ownership, and makes worker placement dependent on the API host.

### 2. Public worker download endpoint

The worker would expose one-time browser URLs and serve files directly.

Rejected: this makes the worker another public session/authorization boundary,
requires immediate ingress and domain work, and expands credential and abuse
surface.

### 3. Private signed worker stream

The API produces and observes jobs through a dedicated queue Redis. The worker
stores files in its own volume and exposes an internal signed file command.
The API verifies the browser session and ownership, signs the internal request,
and streams the bounded worker response to the browser.

Selected: this preserves API ownership, avoids shared filesystems, supports
same-node private DNS, and permits a later owner-approved HTTPS connection to a
worker on another node.

## Architecture

```text
Browser
  |
  | cookie session + CSRF + tf.downloads policy
  v
TF API
  |                         \
  | BullMQ producer/status   \ signed POST /v1/files
  v                           v
Dedicated queue Redis <--- TF Download Worker
                              |
                              | yt-dlp + ffmpeg
                              v
                       worker-owned volume
```

### Trust boundaries

- The browser never receives queue Redis, worker HMAC, worker filesystem, or
  source URL credentials.
- The API receives only the queue producer/status URL and worker command key.
- The worker receives only the queue worker URL, worker command key, heartbeat
  key, and its own storage.
- The worker receives no TF database, Platform database, session Redis, cache
  Redis, provider-account, Docker, SSH, Coolify, Caddy, or control-plane
  credential.
- Queue data is treated as untrusted input and is schema and source-allowlist
  validated again by the worker.

## Packages And Components

### `lib/tf-download-contract`

The shared contract defines:

- queue name `apollo-tf-downloads-v1`;
- quality enum `128 | 192 | 256 | 320 | flac`;
- strict versioned job data with canonical `accountId`, bounded track metadata,
  HTTPS source URL, and creation timestamp;
- strict completed result with opaque storage key, bounded filename, MIME type,
  byte size, and completion timestamp;
- public queue/status/cancel response schemas;
- signed internal file command and response metadata schemas;
- source-host allowlist and URL validation shared by API and worker.

Absolute filesystem paths, cookies, access tokens, provider-account IDs, and
browser installation IDs are forbidden in the contract.

### API queue gateway

`background-queue.ts` becomes a producer/status/cancel adapter only:

- production requires `TF_DOWNLOAD_QUEUE_REDIS_URL_FILE`;
- there is no production in-memory worker or silent fallback;
- queue unavailability is an explicit sanitized `503`;
- global non-terminal queue capacity is `200`;
- admission is reserved in a same-slot exact-owner ledger; pending reservations
  have a `30s` Redis-time lease so a crash before BullMQ job creation cannot
  consume capacity permanently;
- each accepted reservation owns one of exactly `200` deterministic private
  capacity-slot IDs. The BullMQ add uses that slot as an unexpired lifecycle
  deduplication key, so a late producer whose lease was reassigned can only
  resolve to the replacement job and cannot create a `201`st non-terminal job;
- slot reservations, leases, and queue-state counts are inspected atomically in
  one same-slot Redis script. An un-slotted intent is never expired
  automatically because an older producer could still add after expiry; it
  remains fail-closed until an operator has stopped old producers and reconciled
  the namespace. BullMQ removes a matching slot deduplication key atomically on
  finalization or removal;
- one enqueue request accepts at most `50` tracks;
- jobs are retained for at most 24 hours, with bounded completed/failed counts;
- job ownership uses only exact canonical account IDs;
- status never exposes source URL, Redis failure details, absolute paths, or raw
  worker errors;
- a public waiting position is emitted only when the job is inside the first
  `200` combined waiting/delayed entries;
- cancel is worker-mediated and non-destructive: waiting and active jobs stay
  under BullMQ ownership, and an exact namespaced marker is stored in the
  retained job hash;
- an active cancellation is accepted only while the worker has atomically armed
  that job hash; before returning success the worker atomically removes the
  armed marker, while an already-requested cancellation wins the same
  compare-and-set and rolls back committed output;
- DELETE returns the factual BullMQ state until
  `failedReason=download_canceled` confirms `canceled`; job retention owns
  cancellation-marker cleanup, with no separate TTL key or event-stream
  receipt.

The API does not create a BullMQ `Worker` and does not execute background
`yt-dlp`.

### `artifacts/tf-download-worker`

The new package contains:

- strict file-backed configuration;
- BullMQ worker with concurrency `2`;
- downloader process adapter;
- cancellation watcher;
- worker-owned storage and TTL/quota sweeper;
- signed internal file streaming app;
- heartbeat sender;
- runtime entrypoint, build, Dockerfile, and offline real-container smoke
  fixtures.

The worker runs as UID/GID `10001:10001`, with a read-only application
filesystem, dropped capabilities, `no-new-privileges`, bounded tmpfs, PID/CPU/
memory limits, and one writable named download volume. The image pins and
hash-verifies `yt-dlp` and includes `ffmpeg`.

The first release is exactly one worker replica. Local files and internal file
routing make horizontal replicas unsafe until object storage or deterministic
worker routing is designed separately.

## Job Lifecycle

Public states are:

```text
waiting -> active -> completed
                  -> failed
                  -> canceled
```

1. API validates entitlement, CSRF, batch size, quality, track ID, and source
   URL. It writes strict job data with the canonical account ID.
2. Worker revalidates the strict job and source host before spawning anything.
3. `yt-dlp` streams the selected source container to an explicit `ffmpeg`
   process. `ffmpeg` maps the first audio stream, removes video and metadata,
   and emits the requested MP3 or FLAC bytes into an exclusive `.part` file
   under the owned storage directory.
4. The worker enforces a 30-minute job deadline and a hard 1 GiB output limit.
5. Cancellation is armed before spawn and checked at most every 250 ms while
   active. Cancellation terminates both downloader and transcoder, removes
   partial or not-yet-finalized output, and becomes a non-retriable `canceled`
   result. A same-hash completion fence decides the final DELETE/completion
   race atomically.
6. On success the worker fsyncs/closes the file, atomically renames it to an
   opaque job-based storage key, records strict result metadata, and reports
   100 percent progress.
7. Retriable transport/process failures get at most two attempts. Invalid job,
   cancellation, size, deadline, and path-safety failures never retry.
8. Partial files are removed on every error and during startup/scheduled sweep.
9. Completed files expire after 24 hours. The storage quota defaults to 20 GiB;
   the worker sweeps expired files first and rejects new work when the quota
   remains exhausted.

Logs contain job ID, bounded categorical error code, state, duration, and size.
They do not contain source URLs, signed headers, account IDs, filenames supplied
by users, or child stderr.

## Internal File Streaming

The API sends an exact HMAC-signed `POST /v1/files` command containing:

```text
schemaVersion, requestId, accountId, jobId, optional single byte range
```

The signature covers method, exact path, Unix timestamp, canonical nonce, and
the SHA-256 hash of the exact raw JSON bytes. Redirects, query strings,
alternate paths, stale timestamps, malformed nonces, replays, and unknown body
fields are rejected.

Replay state is partitioned by canonical account. Live nonces are retained for
the complete signed validity window without eviction. Capacity exhaustion is
an explicit `503`, not an authentication downgrade.

After authentication, the worker:

- loads the job from queue Redis;
- requires exact account ownership and completed state;
- validates completed result metadata;
- resolves the opaque storage key under the configured root and rejects path,
  symlink, non-regular-file, size, and metadata mismatches;
- returns `200` or single-range `206`, strict content headers, and a bounded
  stream;
- returns the same `404` for unknown, foreign, expired, or missing output.

The API validates response status and headers, applies the hard byte limit,
forwards only allowlisted content headers, aborts the internal request when the
browser disconnects, and never buffers the complete audio file.

## Public API And Web Cutover

The existing queue routes become the supported web contract and are added to
the OpenAPI source and generated clients:

- `POST /tracks/download/queue`
- `GET /tracks/download/jobs`
- `GET /tracks/download/status/{jobId}`
- `GET /tracks/download/file/{jobId}`
- `DELETE /tracks/download/jobs/{jobId}`

All routes require a live `tf.downloads` entitlement. Mutations require CSRF.
Unknown and foreign jobs use indistinguishable responses.

The web track card:

- queues one track instead of calling the legacy JSON download client;
- shows waiting, active progress, completed, canceled, and failed states in the
  existing card control;
- polls only while waiting/active, with one in-flight request and bounded
  backoff;
- offers cancel while waiting/active;
- starts the authenticated file download only after completed state;
- preserves auth-error forwarding and user-facing toast feedback.

The existing foreground `/tracks/:id/download` and `/audio-stream` paths remain
temporarily for the deferred Android/playback compatibility boundary. The web
does not use the foreground download path after this stage. Removing that
legacy path and removing `yt-dlp` from the API image require a separate Android
cutover decision.

## Health, Readiness, And Heartbeat

- `/healthz` is process liveness only.
- `/readyz` requires a bounded queue Redis probe, writable owned storage, and
  configured downloader executable. Provider internet reachability is not a
  readiness dependency.
- The worker sends `download-worker` heartbeat every 30 seconds and becomes
  stale in API state after 90 seconds.
- API startup requires the `download-worker` heartbeat key once the worker
  stack is enabled.
- Heartbeat status is `healthy`, `warning`, or `degraded` from bounded queue,
  storage, and worker observations. Raw failures and secrets are not sent.
- Queue Redis and worker status remain separate in the admin snapshot.

## Compose And Coolify Contract

Root and nested API Compose receive:

- `tf-download-redis`, with no host port;
- `tf-download-worker`, with no host port;
- a worker-owned named volume;
- internal queue and API/worker control networks;
- a worker-only egress network;
- file-backed queue URL, internal command, and heartbeat secrets;
- exact dependency and health gates.

Same-node Compose may use explicit insecure HTTP and Redis only on private
service DNS. A worker placed on another Coolify node requires separately
approved HTTPS for the worker origin and TLS Redis connectivity. No new public
domain is required for local validation. Any remote hostname/DNS/Caddy plan is
written to `.ops-private` after the read-only infrastructure preflight and
before an owner-approved rollout.

## Failure Semantics

- Invalid public input: `400`.
- Missing entitlement: existing `401/403` policy behavior.
- Queue or worker unavailable/capacity exhausted: sanitized `503`.
- Unknown/foreign/expired file: indistinguishable `404`.
- Invalid range: `416`.
- Waiting/active file request: `409`.
- Canceled job: public `canceled`, without child error details.
- Failed job: public bounded error code, never raw stderr.
- Storage quota or output-size failure: non-retriable bounded error.

API and worker shutdown stop admission, cancel or drain active work within the
grace period, close queue clients, stop heartbeat, and remove only owned
partial files.

## Validation

Every behavior change follows RED, verified RED, GREEN, verified GREEN.

Required evidence:

- contract schema and source-allowlist tests;
- API producer/status/cancel ownership, capacity, fail-closed, policy, and
  signed-stream proxy tests;
- worker job validation, process cancellation, timeout, size, atomic storage,
  cleanup, quota, and log-redaction tests;
- a gated production-image media probe that generates an offline AAC source,
  executes the real pinned `yt-dlp -> ffmpeg` adapter, and verifies MP3/FLAC
  codecs plus absence of video with `ffprobe`;
- internal HMAC raw-byte, target, timestamp, nonce, replay, partition, and
  capacity tests;
- file ownership, symlink/path substitution, metadata, range, abort, and
  bounded-stream tests;
- heartbeat/readiness/shutdown tests;
- web queue/poll/cancel/completed-download/auth-error tests;
- root and nested deployment-contract tests;
- production builds, workspace typecheck, Compose renders, and diff check;
- disposable Redis integration;
- offline real-Docker smoke with exact secret, inspect, network, file, log,
  response, and zero-residue assertions;
- independent task reviews and final whole-branch review.

## Out Of Scope

- Android/APK changes.
- Replacing playback/audio streaming with a separate stream worker.
- Multi-replica worker routing or S3-compatible object storage.
- Provider-account parsing changes.
- HomeNode, Coolify, Caddy, UFW, DNS, domain, or firewall mutation.
- Public worker exposure.

## Acceptance Criteria

- Normal web downloads execute only in `tf-download-worker`.
- API owns browser authorization and never reads the worker filesystem.
- Worker can be moved to another approved node by changing exact queue/HTTPS
  origins and secrets, without sharing a Docker volume with API.
- Queue, storage, job, cancellation, and streaming behavior is bounded and
  fail-closed.
- No project secret, source URL, account ID, child stderr, or absolute file path
  appears in public responses, images, config renders, inspect output, or logs.
- All validation and independent reviews pass before merge to `main`.
