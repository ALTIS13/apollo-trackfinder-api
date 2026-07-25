# Task 7: Integrated Validation And Release Record

## Current Result

`DONE_WITH_CONCERNS`.

The single final whole-branch fix wave closes all Important and Minor findings
from the final review package. The complete Task 7 matrix is green on exact
implementation/runtime/config/source tip
`16f6fc88e85fe919ddcb86a85333a38f3218e715`, with fix range
`230077513023231c800b51509b6e98e5e9f455bd..16f6fc88e85fe919ddcb86a85333a38f3218e715`.

The follow-up after that validated tip is documentation-only. It immutably
pins the evidence below and does not claim that the runtime matrix, Compose
renders, smoke, DNS, or scans were rerun on the documentation commit itself.

Historical fix-round and blocked-checkpoint evidence remains below. The
section `Final Whole-Branch Fix Wave` supersedes its old counts and open-minor
ledger. No HomeNode, Coolify, Caddy, UFW, DNS, or other remote infrastructure
command or mutation was performed.

## Historical Blocked Checkpoint

The first Task 7 validation ran production source at
`daf663ea92a7e35b7432c169aaf8ec3298465217` and created the durable blocked
record:

```text
1ef211b119f4879f0e87574a41ef9ab4caa7c9ea
docs: record tf integrations validation
```

That attempt correctly refused to mask:

1. one stale API documentation-contract assertion;
2. root Compose interpolation failure when `TF_SECRET_DIRECTORY` was absent;
3. nested Compose interpolation failure when `TF_SECRET_DIRECTORY` was absent.

Its raw required-suite outputs were 707 passed, 13 skipped, and 1 failed. The
historical status text said 12 skipped; this fix-round report corrects the
arithmetic while preserving the original outputs and blocked commit in Git
history. The failed API assertion reproduced in isolation, and both exact
Compose commands reproduced their missing-variable error.

## Reviewed Task Ledger

| Task | Commit range | Final review | Deferred or handed-off minor |
|---|---|---|---|
| 1, signed command contract | `af90cb9..6bf4161` | Review clean | Browser reachability/policy handoff closed in Task 5. |
| 2, encrypted provider store | `6bf4161..2e9b2da` | Review clean | Weak plaintext-canary unit assertion closed by the final wave; vault/service/live PostgreSQL at-rest evidence remains. |
| 3, provider account service | `2e9b2da..ce4c388` | Review clean | None open. |
| 4, authenticated runtime | `ce4c388..bc577c3` | Review clean | Late heartbeat race closed by the final wave; shutdown ordering has behavior coverage. |
| 5, API gateway migration | `bc577c3..bcb3b3c` | Review clean | Historical cold-import limits remain nonblocking; final-wave startup/deployment guards cover the two required heartbeat enrollments. |
| 6, isolated container stack | `bcb3b3c..daf663e` | Review clean | Password-file and PostgreSQL bootstrap bounds closed by the final wave. |
| 7, blocked validation record | `daf663ea92a7e35b7432c169aaf8ec3298465217..1ef211b119f4879f0e87574a41ef9ab4caa7c9ea` | Accurate blocked checkpoint | Closed by fix round 1/5. |
| 7, validation fix round 1/5 | `1ef211b119f4879f0e87574a41ef9ab4caa7c9ea..7f2cdf2f0b87cf5429eff774aaab0e390ad37ac3` | Full local validation green on exact tip `7f2cdf2f0b87cf5429eff774aaab0e390ad37ac3` | Existing nonblocking warnings/minors remain below. |
| Final whole-branch fix wave | `230077513023231c800b51509b6e98e5e9f455bd..16f6fc88e85fe919ddcb86a85333a38f3218e715` | All final-review Important and Minor findings implemented and fully revalidated | Native-Linux owner/mode evidence remains rollout-blocking and merge-nonblocking. |

## Fix Round 1/5

### Root causes

The API test still expected the pre-implementation future-module sentence and
then exposed a second stale pre-Task-6 six-file sentence. `MODULES.md` already
documented the implemented three-service container, six runtime secrets,
30/90-second heartbeat, exact networks, and zero host ports.

Both Compose templates used the required interpolation
`${TF_SECRET_DIRECTORY:?}` for every secret source. Compose therefore stopped
during config interpolation before it could render the otherwise valid
template.

### RED evidence

Before production/template changes:

```text
API admin config baseline:       19 passed, 1 failed
root exact Compose:              FAIL, required TF_SECRET_DIRECTORY absent
nested exact Compose:            FAIL, required TF_SECRET_DIRECTORY absent
tf-integrations deployment RED:  9 passed, 1 failed
tf-search deployment RED:        17 passed, 2 failed
updated API documentation RED:   19 passed, 1 failed
```

The deployment tests failed on the exact old interpolation received versus the
new literal expected default. The updated API assertion failed only because
the new exact safe-default documentation was not present yet.

### Minimal fix

- `admin-config-contract.test.ts` now binds to the exact implemented facts:
  six named module runtime secrets, heartbeat `account-integrations` sent
  immediately and every 30 seconds with 90-second freshness, exact
  control/data/egress ownership, and zero module/migrator/database host ports.
- Every one of the 16 secret declarations in both Compose templates now uses
  the identical non-secret expression
  `${TF_SECRET_DIRECTORY:-/var/lib/apollo-tf/secrets}`.
- Override support is unchanged. No inline secret value, credential, or new
  mount was introduced.
- The integration deployment contract now checks the safe default for every
  declared secret in both templates; the tf-search contract pins the same
  expression for its owned secrets.
- `MODULES.md` records that `TF_SECRET_DIRECTORY` is an override, that
  `/var/lib/apollo-tf/secrets` is the no-override default, and that production
  still requires six base TF/search files plus ten integration files.

### Focused GREEN

```text
API admin config contract:       20/20
tf-integrations deployment:      10/10
tf-search deployment:            19/19
root exact no-env Compose:        PASS, no output/warnings
nested exact no-env Compose:      PASS, no output/warnings
root explicit override render:   16/16 secret paths use override
nested explicit override render: 16/16 secret paths use override
```

The first override comparison wrapper used a backslash glob against
forward-slash JSON paths and reported `0/16` despite both renders succeeding.
The corrected ordinal-prefix comparison, with no template change between
attempts, returned `16/16` for both.

## Historical Fix-Round 1 Exact Validation

Every brief command ran against the final implementation:

| Exact command | Result |
|---|---|
| `pnpm --dir lib/tf-integrations-contract test` | PASS: 1 file, 10 tests |
| `pnpm --dir lib/tf-integrations-db test` | PASS/GATED: 3 files passed, 1 skipped; 18 passed, 1 skipped |
| `pnpm --dir artifacts/tf-integrations test` | PASS/GATED: 13 files; 76 passed, 9 skipped |
| `pnpm --dir artifacts/api-server test` | PASS/GATED: 28 files; 379 passed, 2 skipped |
| `pnpm --dir artifacts/tf-search test` | PASS/GATED: 12 files; 140 passed, 1 skipped |
| `pnpm --dir artifacts/music-player test` | PASS: 6 files, 85 tests |
| `pnpm run typecheck` | PASS: library build plus all 9 selected artifact/script projects |
| `pnpm --dir artifacts/tf-integrations build` | PASS |
| `pnpm --dir artifacts/api-server build` | PASS |
| `pnpm --dir artifacts/music-player build` | PASS with known warnings |
| `docker compose config --quiet` | PASS with `TF_SECRET_DIRECTORY` explicitly removed |
| `docker compose -f artifacts/api-server/docker-compose.yml config --quiet` | PASS with `TF_SECRET_DIRECTORY` explicitly removed |
| `git diff --check` | PASS |

Required-suite total: 64 files, with 63 passed and 1 environment-gated file;
708 tests passed, 13 skipped/gated, and 0 failed.

### Skipped and gated reasons

- `tf-integrations-db`: 1 disposable PostgreSQL integration test is gated by
  absent `TF_INTEGRATIONS_TEST_DATABASE_URL`.
- `tf-integrations`: 9 real Docker tests are gated in the default suite by
  absent `TF_INTEGRATIONS_SMOKE_REAL_DOCKER=1`; the separately enabled
  authoritative gate passed all 16 tests.
- API: 1 disposable BullMQ/Redis test is gated by absent
  `APOLLO_REDIS_INTEGRATION_URL`.
- API: 1 Windows linked-file containment test called `skip()` after symlink
  creation returned `EPERM`/`EACCES`; the other junction/race cases passed.
- `tf-search`: 1 real Docker smoke is gated by absent
  `TF_SEARCH_SMOKE_REAL_DOCKER=1`.

## Historical Builds And Render Sizes

```text
tf-integrations index.mjs       90,018 bytes (87.9 kB reported)
tf-integrations migrate.mjs      8,961 bytes (8.8 kB reported)
tf-integrations dist total     103,463 bytes across 6 files
API index.mjs                4,277,724 bytes (4.1 MB reported)
API dist total             11,700,850 bytes across 10 files
music-player JS              517,554 bytes; gzip 164.43 kB
music-player CSS             121,197 bytes; gzip 18.62 kB
music-player public total  1,698,369 bytes across 6 files
root rendered YAML             16,377 UTF-8 bytes
nested rendered YAML           14,970 UTF-8 bytes
root rendered JSON             21,614 UTF-8 bytes
nested rendered JSON           19,714 UTF-8 bytes
```

The unique smoke images were removed before size inspection by the required
zero-residue cleanup. No image was retained merely to report a size.

The music-player build retained two known nonblocking warnings: source-map
lookup could not resolve the original location for
`src/components/ui/tooltip.tsx`, and the 517.55 kB JavaScript chunk exceeds
Vite's 500 kB advisory threshold.

## Historical Authoritative Real Docker Smoke

Because Compose changed, the Task 6 gate was rerun rather than reused:

```powershell
$env:TF_INTEGRATIONS_SMOKE_REAL_DOCKER='1'
pnpm --dir artifacts/tf-integrations test -- src/smoke.test.ts
```

```text
Test Files  1 passed (1)
Tests       16 passed (16)
Duration    118.66s
Project     apollo-tf-integrations-smoke-28032-8bce1921
Docker      local Docker Desktop desktop-linux context
```

The current run re-proved:

- migration exit `0`, migrator-before-runtime ordering, readiness, and one
  valid signed command from the API trust side;
- replay, tampered body, wrong key, unsupported encoding, and unsigned command
  rejection;
- runtime role exact DML/history privileges and denied history writes;
- provider token present only as authenticated AES-256-GCM ciphertext with
  provider/account AAD and corruption rejection;
- provider outage independent from readiness;
- heartbeat healthy, API restart reset to unknown, and recovery with version
  `task-6-smoke`;
- Node 24 LTS, least-privilege inspect facts, exact networks/resources/secret
  mounts, and zero integration host ports.

Docker Desktop does not prove native-Linux secret UID/GID. File-source mounts
are remapped and declared metadata is not applied. The verified Desktop
alternative is exact owner-scoped read-only mounts with
regular/readable/non-writable targets and inspect-confirmed read-only state.
The platform-gated native-Linux path still requires exact `999:999` or
`10001:10001` ownership and mode `0400`.

## Historical Secret And Ownership Scans

The smoke generated 37 raw/digest markers and scanned rendered Compose, logs,
responses, ciphertext projection, full inspect output, and every tracked file
byte. All matches were zero.

A separate pass generated 8 fresh random values and 8 SHA-256 digests in
bounded process memory. It scanned 588 tracked files plus this report, 22
built files, two rendered Compose documents, and Git diff. All raw/digest
matches were zero.

```text
default secret paths                  32/32
integration host-port violations      0
module foreign-credential violations  0
API provider-secret violations        0
API production-source forbidden hits  0
API dist forbidden hits               0
```

API scans covered Spotify client-secret selectors, provider-token
table/column names, legacy Spotify/Yandex token-table names, and direct
Spotify/Yandex provider endpoints. Module scans covered shared TF/Platform DB,
Redis, browser/session/cookie, Docker socket/selector credentials, SSH, Caddy,
Coolify, UFW, and control-plane credentials. General unrelated API fetch paths
were not misclassified.

## Historical Cleanup

The smoke's internal cleanup passed. A separate exact project audit returned:

```text
containers=0
images=0
networks=0
volumes=0
temporaryDirectories=0
diagnosticContainers=0
diagnosticNetworks=0
```

Only the exact smoke project label/name and worktree temp prefix were queried.
No unrelated Docker resource was pruned.

## Historical DNS Read-Only Confirmation

Cloudflare `1.1.1.1` and Google `8.8.8.8` resolved all eight owner-created
names, 16/16 checks:

```text
apollot.ru
www.apollot.ru
admin.apollot.ru
api.apollot.ru
api.tf.apollot.ru
coolify.apollot.ru
quasar.apollot.ru
tf.apollot.ru
```

`www.apollot.ru` resolved through the owner-configured CNAME; the other seven
resolved through owner-configured public records. No address or private
inventory is recorded.

The first DNS wrapper had a PowerShell ternary parse error before any query
executed. The corrected read-only invocation completed 16/16.

## Historical Mutation Boundary And Next Stage

No HomeNode, Coolify, Caddy, UFW, DNS, or other remote infrastructure command
or mutation was executed. DNS access was read-only through public resolvers.
Docker activity was limited to the unique local smoke project and its exact
cleanup.

The next implementation stage is `tf-download-worker`. Any rollout must begin
with read-only HomeNode/Coolify/Caddy preflight and then obtain explicit user
approval before its first mutation.

## Historical Nonblocking Concerns

1. The existing music-player sourcemap and chunk-size build warnings remain.
2. The reviewed deferred minors in Tasks 2, 4, 5, and 6 remain unchanged.
3. Native-Linux secret owner/mode evidence remains platform-gated; the exact
   Docker Desktop alternative is recorded above.

## Fix Round 2/5

This documentation-only follow-up corrects the remaining Important review
finding:

- current green evidence names exact validated runtime/config/source tip
  `7f2cdf2f0b87cf5429eff774aaab0e390ad37ac3`, not its blocked parent;
- blocked checkpoint range is immutably pinned as
  `daf663ea92a7e35b7432c169aaf8ec3298465217..1ef211b119f4879f0e87574a41ef9ab4caa7c9ea`;
- validation-fix range is immutably pinned as
  `1ef211b119f4879f0e87574a41ef9ab4caa7c9ea..7f2cdf2f0b87cf5429eff774aaab0e390ad37ac3`;
- the new commit is explicitly documentation-only and makes no claim that the
  runtime matrix was rerun on itself.

Focused static verification on the final record:

```text
exact validated-tip assertions:       PASS in both records
exact blocked-range assertions:       PASS in both records
exact validation-fix assertions:      PASS in both records
mutable branch-tip tokens:            0
contradictory current BLOCKED status: 0
Task 7 status section Prettier:       PASS
task-7-report.md Prettier:            PASS
git diff --check:                     PASS
private-key headers:                  0
known token forms:                    0
private IPv4 inventory:               0
credentialed URLs:                    0
```

The whole legacy `IMPLEMENTATION_STATUS.md` is not globally Prettier-stable,
and the committed parent fails the same whole-file check. To avoid unrelated
format churn, the edited Task 7 section was isolated and required to be
Prettier-stable; the standalone Task 7 report was checked as a complete file.

The first isolated-section wrapper had a PowerShell ternary parse error before
Prettier ran. The corrected wrapper then exposed one split inline-code span;
that Task 7 bullet was rewrapped and the final isolated check passed.

No runtime code, tests, Compose, `MODULES.md`, operational count, runtime
claim, DNS record, Docker resource, or remote infrastructure was changed or
rerun in fix round 2/5.

## Final Whole-Branch Fix Wave

### Validated implementation

```text
fix base:            230077513023231c800b51509b6e98e5e9f455bd
implementation tip:  16f6fc88e85fe919ddcb86a85333a38f3218e715
implementation range:
230077513023231c800b51509b6e98e5e9f455bd..16f6fc88e85fe919ddcb86a85333a38f3218e715
```

The later evidence commit changes documentation only. All commands in this
section ran on the exact implementation tip above.

### Closed findings

1. Additive immutable `0005_provider_account_generation.sql` adds UUIDv4
   generations. Every upsert/reconnect rotates generation; refresh uses only
   update-only CAS against its loaded generation. Disconnect cannot be
   restored and reconnect cannot be overwritten.
2. Internal auth now verifies exact raw bytes/signature/time, strictly parses
   the command, then claims nonce state in the canonical account partition.
   Live records are not evicted and are bounded at `32/account`, `256/global`
   through their remaining signed validity.
3. Commands carry HTTP-disconnect, runtime-shutdown, and `8s` deadline aborts
   through service and adapters. Module/provider limits are `32` and
   `8 active + 24 queued`; provider JSON is streaming-bounded to `1 MiB`.
4. API startup requires both external heartbeat key entries. External modules
   begin `unknown`, expire after `90s`, and recover only after a valid fresh
   heartbeat. Shutdown cannot send after awaited readiness.
5. Exact `/v1/commands` routing rejects query, literal fragment, trailing
   slash, and extra targets without canonicalizing HMAC input.
6. `HttpTfIntegrationsClient` cancels non-200, malformed, schema-invalid, and
   declared-oversized response bodies before sanitized failure.
7. Heartbeat stop is rechecked between awaited readiness and request creation.
8. Role password files are `1..512` bytes; bootstrap uses `10s` connection,
   `30s` statement, and `5s` lock limits without changing grants.
9. The vacuous repository plaintext-canary assertion is removed; vault,
   service, disposable PostgreSQL, and smoke at-rest checks remain.
10. Current release records name `tf-download-worker` as the next stage.

### Exact Task 7 matrix

| Exact command | Final result |
|---|---|
| `pnpm --dir lib/tf-integrations-contract test` | PASS: 1 file, 10 tests |
| `pnpm --dir lib/tf-integrations-db test` | PASS/GATED: 3 passed files, 1 skipped file; 19 passed, 2 skipped |
| `pnpm --dir artifacts/tf-integrations test` | PASS/GATED: 14 files; 95 passed, 10 skipped |
| `pnpm --dir artifacts/api-server test` | PASS/GATED on exact rerun: 28 files; 383 passed, 2 skipped |
| `pnpm --dir artifacts/tf-search test` | PASS/GATED: 12 files; 140 passed, 1 skipped |
| `pnpm --dir artifacts/music-player test` | PASS: 6 files, 85 tests |
| `pnpm run typecheck` | PASS: library build plus all 9 selected artifact/script projects |
| `pnpm --dir artifacts/tf-integrations build` | PASS |
| `pnpm --dir artifacts/api-server build` | PASS |
| `pnpm --dir artifacts/music-player build` | PASS with the two existing warnings |
| `docker compose config --quiet` | PASS with `TF_SECRET_DIRECTORY` removed |
| `docker compose -f artifacts/api-server/docker-compose.yml config --quiet` | PASS with `TF_SECRET_DIRECTORY` removed |
| root explicit override render | PASS: `16/16` secret paths |
| nested explicit override render | PASS: `16/16` secret paths |
| `git diff --check` | PASS |

Successful required-suite total: 65 files, 64 passed and 1 environment-gated;
`732 passed / 15 skipped or gated / 0 failed`.

The first post-commit API attempt completed `379 passed / 2 skipped` with no
assertion failure, then returned nonzero because one Windows Vitest fork
exited unexpectedly. The identical exact command immediately completed all 28
files at `383 passed / 2 skipped`. This non-reproducing runner event is
retained as a concern rather than hidden.

### Builds and renders

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

The music-player sourcemap lookup warning and greater-than-500-kB chunk
warning are unchanged and nonblocking.

Both parsed renders have `32/32` expected default secret paths, zero
integration host-port violations, zero API foreign integration-secret
violations, exact six-secret module sets, and exact
control/data/egress network sets.

### Real PostgreSQL and Docker smoke

The environment-gated repository suite ran against a one-off local
PostgreSQL 16 container after provisioning the same two role names that
production role-init creates:

```text
src/integration.test.ts: 1 file, 2/2 passed
```

An initial vanilla-container attempt failed in setup before either test
because migration `0004` grants to the required runtime role. The corrected
disposable setup created both role names, then the at-rest and
disconnect/reconnect CAS tests passed. Both exact test containers used tmpfs
data and were removed.

The authoritative disposable smoke ran:

```powershell
$env:TF_INTEGRATIONS_SMOKE_REAL_DOCKER='1'
pnpm --dir artifacts/tf-integrations test -- src/smoke.test.ts
```

```text
Test Files  1 passed
Tests       17 passed
Duration    121.40s
Project     apollo-tf-integrations-smoke-45916-d33a8afb
Docker      local desktop-linux / Docker Desktop
```

It additionally proves stale-generation rejection in real PostgreSQL,
authenticated ciphertext, exact runtime ACLs, signed-command/replay
rejection, initial/reset heartbeat unknown and recovery, provider-independent
readiness, bounded topology, Node 24, inspect boundaries, and zero host ports.

### Scans and cleanup

The smoke injected 37 raw/digest markers into its secret/token fixtures.
Rendered config, logs, command responses, ciphertext projection, Docker
inspect, and tracked bytes contained zero matches. A separate bounded scan of
8 fresh raw canaries plus 8 SHA-256 digests returned zero matches across:

```text
tracked files  591
built files     23
renders          4
Git diffs        1
```

API production source/dist scans returned zero provider credential,
provider-token table, or direct provider API dependencies. Module
source/dist scans returned zero shared TF/Platform database, Redis,
browser/session, Docker, SSH, Caddy, Coolify, UFW, or control-plane
dependencies.

Migrations `0001`--`0004` have zero changes from the fix base. The additive
`0005` SHA-256 is
`6b40b55e21d0222d383127b48e5a3f14e1a856a1f8dd7c2174e38d74b0825f27`.

Independent exact residue audit:

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

### DNS and mutation boundary

Read-only A/CNAME resolution through `1.1.1.1` and `8.8.8.8` passed all eight
owner-created names: `16/16`. No public address or private inventory is
recorded.

No HomeNode, Coolify, Caddy, UFW, DNS, or other remote infrastructure
mutation was performed. The next stage is `tf-download-worker`; rollout still
requires read-only preflight and explicit owner approval.

### Remaining concerns

1. Docker Desktop does not prove native-Linux secret UID/GID/mode. Exact
   `999:999` or `10001:10001` and mode `0400` evidence remains
   rollout-blocking and merge-nonblocking.
2. One post-commit API Vitest worker exited once without an assertion failure;
   the exact immediate rerun passed all files.
3. The existing music-player sourcemap and chunk-size warnings remain.
