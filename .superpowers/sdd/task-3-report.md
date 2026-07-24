# Task 3: Authenticated Search Service, Health, And Heartbeat

## Status

Implemented the `tf-search` runtime boundary only. `tf-api`, Compose files, and remote infrastructure were not changed.

## RED Evidence

1. The required focused boundary command was run before implementation:

   ```powershell
   pnpm --filter @workspace/tf-search test -- src/config.test.ts src/internal-auth.test.ts src/app.test.ts src/logger.test.ts src/heartbeat.test.ts
   ```

   It exited `1`: the five new boundary modules were absent. The output also identified the missing workspace dependency link, which was installed before implementation.

2. Heartbeat shutdown regression:

   ```powershell
   pnpm --filter @workspace/tf-search test -- src/heartbeat.test.ts
   ```

   It exited `1`: `stop()` resolved while a later scheduled heartbeat was still pending. The regression now tracks every attempt and waits for it.

3. Image build regression:

   ```powershell
   docker build --pull=false -f artifacts/tf-search/Dockerfile -t audio-navigator-tf-search-task3-red .
   ```

   It exited `1` with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, proving the narrowed Docker workspace had discarded the lockfile catalog configuration. The Dockerfile now preserves that configuration while narrowing the package list.

4. Self-review regressions:

   ```powershell
   pnpm --filter @workspace/tf-search test -- src/app.test.ts src/heartbeat.test.ts
   ```

   It exited `1`: an authenticator exception became `400` instead of generic `401`, and a telemetry exception stopped later heartbeats.

## GREEN Evidence

- Focused boundary suite: 5 files / 51 tests passed.
- App suggestions endpoint: 1 file / 7 tests passed after the signed route was restored from its RED `404` state.
- Heartbeat lifecycle suite: 1 file / 5 tests passed after tracking all scheduled attempts.
- Authenticator/telemetry self-review suite: 2 files / 14 tests passed.

Final Task 3 validation:

```powershell
pnpm --filter @workspace/tf-search test
pnpm --filter @workspace/tf-search typecheck
pnpm --filter @workspace/tf-search build
node --check artifacts/tf-search/dist/index.mjs
git diff --check
```

All commands exited `0`. The test command passed 8 files and 73 tests; the bundle is syntactically valid.

The initial eight-process Vitest fork pool intermittently exited a worker after
65 tests in this shared desktop environment, despite all files passing when
isolated. The same suite passed with one and four fork workers, eight verbose
fork workers, and eight thread workers. The package test script now explicitly
uses the validated eight-worker thread pool; two consecutive plain package runs
passed 8 files and 73 tests each.

The final local image build also exited `0`:

```powershell
docker build --pull=false -f artifacts/tf-search/Dockerfile -t audio-navigator-tf-search-task3 .
```

Inspection confirmed `10001:10001`, exposed `8080/tcp`, and the start-script entrypoint. A non-root shell check confirmed the final image has the bundle and start script only, no source artifact directory, and a non-writable `/app`.

## Changed Files

- `artifacts/tf-search/src/config.ts`
- `artifacts/tf-search/src/config.test.ts`
- `artifacts/tf-search/src/internal-auth.ts`
- `artifacts/tf-search/src/internal-auth.test.ts`
- `artifacts/tf-search/src/app.ts`
- `artifacts/tf-search/src/app.test.ts`
- `artifacts/tf-search/src/heartbeat.ts`
- `artifacts/tf-search/src/heartbeat.test.ts`
- `artifacts/tf-search/src/logger.ts`
- `artifacts/tf-search/src/logger.test.ts`
- `artifacts/tf-search/src/index.ts`
- `artifacts/tf-search/container/start-search.sh`
- `artifacts/tf-search/Dockerfile`
- `artifacts/tf-search/package.json`
- `pnpm-lock.yaml`

## Self-Review

- Configuration loads only two required file-backed secrets, trims and bounds them, rejects equality, validates `APOLLO_DEPLOYED_AT`, and permits HTTP only for explicit private/local opt-in. Version metadata follows the existing `APOLLO_API_VERSION` convention.
- Signed commands use exact raw bytes before JSON parsing, canonical paths, constant-time signature comparison, a 60-second timestamp window, a five-minute/256-entry replay cache, and generic fail-closed authentication responses. Unsupported encodings and content types never reach adapters.
- Health/readiness depend only on process-local readiness. Command failures, malformed bodies, and provider exceptions expose stable bounded responses; no request body, query, header, signature, source URL, or raw provider error is passed to logs.
- Heartbeats use the distinct key, existing `search-media` route, an exact signed payload, `redirect: "error"`, a ten-second abort, serialized 30-second-after-completion scheduling, and shutdown that aborts and awaits the active attempt.
- Scope remains limited to `artifacts/tf-search` plus the dependency lockfile. No `tf-api`, Compose, HomeNode, Coolify, Caddy, UFW, DNS, or other remote infrastructure was changed.

## Concerns

- The approved image requirement pins pnpm, but not the `yt-dlp` release. A later image rebuild can therefore pick up upstream provider behavior changes.
- The image was built and structurally inspected locally; the disposable multi-service smoke and Compose isolation validation remain Task 5 work.
