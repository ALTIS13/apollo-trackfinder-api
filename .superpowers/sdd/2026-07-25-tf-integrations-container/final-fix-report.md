# TF Integrations Final Whole-Branch Fix Report

## Result

`DONE_WITH_CONCERNS`.

```text
fix base:            230077513023231c800b51509b6e98e5e9f455bd
implementation:      16f6fc88e85fe919ddcb86a85333a38f3218e715
implementation range:
230077513023231c800b51509b6e98e5e9f455bd..16f6fc88e85fe919ddcb86a85333a38f3218e715
```

The implementation commit contains production code, additive migration,
tests, and smoke assertions. The following evidence commit is docs-only and
is intentionally not self-referenced from inside this file.

No push, merge, HomeNode, Coolify, Caddy, UFW, DNS, or other remote
infrastructure mutation was performed. Docker activity was restricted to
unique disposable projects on the local `desktop-linux` Docker Desktop
context.

## Finding Closure

1. **Refresh/disconnect/reconnect race**
   - Added immutable additive migration
     `0005_provider_account_generation.sql`.
   - Left migrations `0001`--`0004` byte-unchanged.
   - Repository upsert creates a fresh `randomUUID()` generation and replaces
     it on reconnect.
   - Refresh uses only
     `UPDATE ... WHERE account_id/provider/generation`; it cannot insert.
   - Stale refresh after disconnect or reconnect returns `not_connected`
     without restoring or overwriting a row.
2. **Replay cache availability**
   - Split raw-byte authentication into `verify` and account-aware `claim`.
   - Preserved exact HMAC bytes and 60-second timestamp tolerance.
   - Strict JSON/command parsing occurs after signature/time verification and
     before nonce claim.
   - Live nonces are not evicted; remaining signed validity is retained.
   - Capacity is `32` per canonical account and `256` global.
3. **Provider I/O bounds**
   - Added one command abort scope for client disconnect, runtime shutdown,
     and fixed `8s` deadline, below the API gateway's `10s` abort.
   - Module concurrency is `32`; provider capacity is
     `8 active + 24 queued`.
   - Spotify/Yandex use fixed endpoints, forwarded signals, and a `1 MiB`
     streaming JSON reader.
   - Non-OK, malformed, oversized, stalled, and non-terminating bodies are
     canceled or drained with sanitized errors.
4. **Heartbeat enrollment upgrade**
   - API startup requires both `search-media` and `account-integrations`.
   - Missing/search-only maps fail with generic `invalid runtime
     configuration`.
   - External telemetry begins `unknown`, is fresh through 90 seconds, expires
     to `unknown`, and recovers only on a new valid heartbeat.
5. **Exact command target**
   - Query, literal fragment, trailing slash, and every extra request target
     are rejected; routing and HMAC do not strip or canonicalize them.
6. **Gateway response disposal**
   - `HttpTfIntegrationsClient` cancels non-200, declared-oversized,
     malformed-JSON, schema-invalid, and uncorrelated response bodies before
     sanitized failure.
7. **Late heartbeat shutdown**
   - `stopped` is rechecked after awaited readiness and before request/body
     creation.
8. **Role bootstrap bounds**
   - Password files are readable and `1..512` bytes.
   - PostgreSQL bootstrap has `10s` connection, `30s` statement, and `5s`
     lock limits.
   - Existing grants are unchanged.
9. **At-rest assertion**
   - Removed the vacuous repository plaintext assertion.
   - Retained meaningful vault/service, disposable PostgreSQL, and smoke
     ciphertext checks.
10. **Release status**
    - Current TF integrations release records name `tf-download-worker` as the
      next stage without rewriting unrelated historical sections.

Task 1 policy/CSRF remains closed. Provider readiness remains independent.
No legacy-token import/drop/data migration, arbitrary provider proxy, public
schema break, or secret-bearing error/log path was introduced.

## RED/GREEN Ledger

Every production behavior began with a named focused test.

### Generation CAS

RED:

```powershell
pnpm --dir lib/tf-integrations-db test -- `
  src/repository.test.ts src/migration-manifest.test.ts src/integration.test.ts
```

```text
5 failed, 5 passed, 2 PostgreSQL-gated
```

Named failures covered fresh generation creation, immutable `0005` manifest
registration, update-only CAS, and real PostgreSQL disconnect/reconnect
interleavings.

```powershell
pnpm --dir artifacts/tf-integrations test -- src/service.test.ts
```

```text
3 failed, 7 passed
```

Named failures:

- `never restores a disconnected row when an in-flight refresh completes`
- `never overwrites a reconnected row when an older refresh completes`
- refreshed-token persistence through exact generation CAS

GREEN after minimal migration/repository/service implementation:

```text
database focused: 10 passed, 2 gated
service focused:  10/10
```

### Replay Isolation And Exact Target

RED:

```powershell
pnpm --dir artifacts/tf-integrations test -- `
  src/internal-auth.test.ts src/app.test.ts
```

```text
6 named tests failed
```

Failures covered auth-before-claim, per-account/global flood behavior,
concurrent duplicate claims, exact remaining validity, malformed JSON not
consuming a nonce, and query/fragment/extra target rejection.

GREEN:

```text
12/12
```

The tests also pin exact raw-body HMAC semantics and prove that one saturated
account partition does not deny another account.

### Command And Provider I/O Bounds

RED:

```powershell
pnpm --dir artifacts/tf-integrations test -- `
  src/app.test.ts src/service.test.ts
```

```text
5 named tests failed: 3 app, 2 service
```

```powershell
pnpm --dir artifacts/tf-integrations test -- `
  src/providers/spotify.test.ts src/providers/yandex.test.ts
```

```text
4 named tests failed
```

Failures covered fixed sub-10-second deadline, HTTP disconnect/runtime
shutdown, bounded command/provider concurrency, signal forwarding, stalled
and non-terminating reads, declared/streaming oversize, non-OK disposal, and
finite malformed JSON draining.

GREEN:

```text
app + service: 23/23
provider files: 29/29
```

Provider fixtures and fixed endpoint/validation/error tests remained green.

### Heartbeat Enrollment And Shutdown

RED:

```powershell
pnpm --dir artifacts/tf-integrations test -- `
  src/heartbeat.test.ts src/index.runtime.test.ts
```

```text
3 named tests failed: 2 heartbeat/shutdown, 1 runtime behavior
```

```powershell
pnpm --dir artifacts/api-server test -- `
  src/lib/module-heartbeat.test.ts src/lib/admin-telemetry.test.ts
```

```text
3 named tests failed
```

```powershell
pnpm --dir artifacts/api-server test -- src/deployment-contract.test.ts
```

```text
1 named stale search-only enrollment test failed
```

GREEN:

```text
integrations heartbeat/runtime: 5/5
API heartbeat/admin telemetry: 58/58
deployment selection:          15 passed, 15 platform-gated
```

Coverage proves missing integrations key failure without key leakage, initial
`unknown`, exact 90-second freshness/expiry, recovery, no late heartbeat, and
active-command abort before listener/pool shutdown.

### Minor Disposal And Bootstrap Findings

RED:

```powershell
pnpm --dir artifacts/api-server test -- `
  src/lib/tf-integrations-client.test.ts
```

```text
1 failed
```

GREEN:

```text
9/9
```

The new test proves cancellation for declared-oversized, malformed-JSON, and
schema-invalid HTTP 200 bodies.

RED:

```powershell
pnpm --dir artifacts/tf-integrations test -- `
  src/role-privileges.test.ts
```

```text
1 failed, 1 passed
```

GREEN:

```text
2/2
```

The role test pins file-size and connection/statement/lock bounds while the
existing privilege test pins exact grants.

The vacuous plaintext-canary unit assertion was replaced with a meaningful
parameterized-SQL/fresh-generation assertion. Existing vault/service and
real-database at-rest tests provide the behavioral evidence.

## Pre-Commit GREEN

Before the implementation commit:

```text
lib/tf-integrations-db full: 3 files passed, 1 skipped;
                             19 passed, 2 skipped
tf-integrations full:        14 files; 95 passed, 10 skipped
API full:                    28 files; 383 passed, 2 skipped
database typecheck:          PASS
tf-integrations typecheck:   PASS
API typecheck:               PASS
tf-integrations build:       PASS
API build:                   PASS
git diff --check:            PASS
```

The database package typecheck initially found one test fixture that omitted
the newly required persisted `generation`; adding the fixture generation made
the independent rerun pass.

## Final Exact Validation

All final commands below ran after commit on exact implementation tip
`16f6fc88e85fe919ddcb86a85333a38f3218e715`.

| Exact command | Result |
|---|---|
| `pnpm --dir lib/tf-integrations-contract test` | PASS: 1 file, 10 tests |
| `pnpm --dir lib/tf-integrations-db test` | PASS/GATED: 3 passed files, 1 skipped; 19 passed, 2 skipped |
| `pnpm --dir artifacts/tf-integrations test` | PASS/GATED: 14 files; 95 passed, 10 skipped |
| `pnpm --dir artifacts/api-server test` | PASS/GATED on exact rerun: 28 files; 383 passed, 2 skipped |
| `pnpm --dir artifacts/tf-search test` | PASS/GATED: 12 files; 140 passed, 1 skipped |
| `pnpm --dir artifacts/music-player test` | PASS: 6 files, 85 tests |
| `pnpm run typecheck` | PASS |
| `pnpm --dir artifacts/tf-integrations build` | PASS |
| `pnpm --dir artifacts/api-server build` | PASS |
| `pnpm --dir artifacts/music-player build` | PASS with two existing warnings |
| `docker compose config --quiet` | PASS, no output |
| `docker compose -f artifacts/api-server/docker-compose.yml config --quiet` | PASS, no output |
| root override render | PASS: `16/16` secret files use override |
| nested override render | PASS: `16/16` secret files use override |
| `git diff --check` | PASS |

Required-suite total:

```text
files:  65 total, 64 passed, 1 environment-gated
tests:  732 passed, 15 skipped/gated, 0 failed
```

Skip/gate reasons:

- database: two tests require
  `TF_INTEGRATIONS_TEST_DATABASE_URL`;
- integrations: ten real-Docker assertions require
  `TF_INTEGRATIONS_SMOKE_REAL_DOCKER=1`;
- API: one disposable Redis/BullMQ test lacks its URL and one Windows linked
  file case gates on symlink `EPERM`/`EACCES`;
- tf-search: one real-Docker smoke is default-off.

The first post-commit API run had no failed assertion but one Vitest fork
exited unexpectedly after `379 passed / 2 skipped`, so the command returned
nonzero. The identical exact command immediately passed all 28 files at
`383 passed / 2 skipped`.

## Real PostgreSQL

A unique local PostgreSQL 16 container with tmpfs data executed:

```powershell
pnpm --dir lib/tf-integrations-db test -- src/integration.test.ts
```

The initial vanilla container failed in migration setup before tests because
`0004` grants to production role
`apollo_tf_integrations_runtime`. The corrected disposable setup provisioned
the same migrator/runtime role names as production role-init, then returned:

```text
1 file passed, 2/2 tests passed
```

This proves:

- no plaintext token canary appears in the real database row projection;
- stale generation cannot update after delete;
- reconnect creates a different generation;
- stale generation cannot overwrite the replacement row.

Both disposable database containers were removed, and tmpfs left no volume.

## Authoritative Docker Smoke

```powershell
$env:TF_INTEGRATIONS_SMOKE_REAL_DOCKER='1'
pnpm --dir artifacts/tf-integrations test -- src/smoke.test.ts
```

```text
Test Files  1 passed
Tests       17/17
Duration    121.40s
Project     apollo-tf-integrations-smoke-45916-d33a8afb
Context     local desktop-linux / Docker Desktop
```

The smoke proves:

- one-shot migration success and migration gating;
- exact runtime/migrator ACL boundary;
- real PostgreSQL stale-generation CAS rejection;
- valid command acceptance and replay/tamper/wrong-key/encoding/unsigned
  rejection;
- AES-256-GCM authenticated ciphertext at rest;
- provider outage independent from readiness;
- external heartbeat healthy, API restart reset to `unknown`, and recovery;
- exact networks, resources, secrets, zero host ports, and Node 24;
- secret target regular/readable/non-writable state on Docker Desktop.

Docker Desktop does not prove native-Linux UID/GID/mode.

## Builds And Renders

```text
tf-integrations index.mjs       104,179 bytes
tf-integrations migrate.mjs       9,101 bytes
tf-integrations dist total       117,976 bytes across 7 files
API index.mjs                  4,278,465 bytes
API dist total               11,703,147 bytes across 10 files
music-player JS                 517,554 bytes; gzip 164.43 kB
music-player CSS                121,197 bytes; gzip 18.62 kB
music-player public total     1,698,369 bytes across 6 files
root YAML / JSON             15,890 / 20,921 LF-normalized UTF-8 bytes
nested YAML / JSON           14,520 / 19,078 LF-normalized UTF-8 bytes
```

Both no-env Compose renders passed. Both override renders resolved all
`16/16` secret files to the supplied non-secret path.

Parsed render checks:

```text
default secret paths                 32/32
integration host-port violations     0
API forbidden integration secrets    0
module secret-set differences        0
module network-set differences       0
```

The existing music-player sourcemap lookup and greater-than-500-kB chunk
warnings remain.

## Secret And Boundary Scans

Smoke generated 37 raw/digest markers from its actual secret/token fixtures
and found zero matches in:

- rendered Compose;
- API/module/migrator/database logs;
- command responses;
- ciphertext projection;
- Docker inspect;
- tracked file bytes.

A separate bounded scan generated 8 raw canaries and 8 SHA-256 digests:

```text
tracked files  591
built files     23
renders          4
Git diffs        1
matches           0
```

Static scans:

```text
API production source provider-secret/table/direct-endpoint files  0
API dist provider-secret/table/direct-endpoint files               0
module production source foreign-credential files                  0
module dist foreign-credential files                               0
```

The module scan covered shared TF/Platform database and Redis credentials,
browser/session/cookie state, Docker selectors/socket, SSH, Caddy, Coolify,
UFW, admin, and control-plane credentials.

Migration audit:

```text
0001--0004 changes from fix base  0
0005 SHA-256
6b40b55e21d0222d383127b48e5a3f14e1a856a1f8dd7c2174e38d74b0825f27
```

## DNS And Cleanup

Read-only A/CNAME queries through public resolvers `1.1.1.1` and `8.8.8.8`
passed all eight owner-created names:

```text
16/16
```

No address or private inventory is recorded.

Independent exact smoke/supplemental-container residue audit:

```text
containers=0
images=0
networks=0
volumes=0
temporaryDirectories=0
diagnosticContainers=0
diagnosticNetworks=0
```

No unrelated Docker resource was pruned.

## Concerns

1. Native-Linux ownership/mode evidence remains required before rollout:
   exact owner `999:999` or `10001:10001`, mode `0400`. Docker Desktop's
   owner-scoped read-only mount evidence is not represented as equivalent.
2. One Windows Vitest API worker exited once without an assertion failure;
   the exact immediate rerun passed.
3. Existing music-player sourcemap and chunk-size warnings remain.

These concerns are merge-nonblocking. Native-Linux evidence is
rollout-blocking.

## Next Stage

The next implementation stage is `tf-download-worker`. Any rollout begins
with read-only HomeNode/Coolify/Caddy preflight and requires explicit owner
approval before mutation.
