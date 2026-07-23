# Task 4 Report: PKCE Authorization, Signed Assertions, and Introspection

## Status

Implemented Task 4 domain security core in the assigned worktree. HTTP routes and
runtime wiring remain unchanged for Task 5.

## RED Evidence

- Contract RED:
  `pnpm --dir lib/platform-contract exec vitest run src/index.test.ts`
  failed with 1 expected failure because the four Task 4 error codes were absent.
- Migration RED:
  `pnpm --dir lib/platform-db exec vitest run src/migrations.test.ts src/migration-manifest.test.ts`
  failed with 2 expected failures because migration `0005` and its manifest entry
  were absent.
- Repository RED:
  `pnpm --dir artifacts/platform-api exec vitest run src/domain/postgres-repository.test.ts`
  failed with 3 expected failures for missing `lockSessionById`, missing
  authorization-code digest context, and the shifted malformed-row lookup.
- Registry/assertion RED:
  direct Vitest invocation failed to import the absent `oauth-clients.ts` and
  `assertions.ts` modules.
- Authorization RED:
  direct Vitest invocation failed to import the absent `authorization.ts` module.
- Database RED exposed PostgreSQL's RLS lock rule: a digest-only SELECT policy
  cannot satisfy `SELECT ... FOR UPDATE`, because row locking also requires the
  account-owned UPDATE policy. The repository was changed to digest-selected
  discovery with no account context and `FOR UPDATE` only after account context
  is established.
- Clock-boundary RED:
  `authorization.test.ts -t "accepts a 60-second application expiry"` failed
  before code expiry validation was based on remaining lifetime rather than the
  database transaction timestamp.
- Redirect allowlist RED:
  `authorization.test.ts -t "absent from the client allowlist"` initially
  resolved an assertion for a corrupted stored redirect and then passed after
  the exchange-time registry check was added.

## GREEN Evidence

- Task 4 focused tests:
  `pnpm --dir artifacts/platform-api exec vitest run src/domain/oauth-clients.test.ts src/domain/authorization.test.ts src/domain/assertions.test.ts src/domain/postgres-repository.test.ts --reporter=dot`
  passed: 4 files, 70 tests.
- Contract tests and typecheck passed: 10 tests.
- Migration/manifest tests and platform-db typecheck passed: 21 tests.
- A strict TypeScript compiler API check using the package's exact tsconfig
  options passed for all 13 changed Task 4 domain roots and their imports.
- The broad domain run reached 268 passes with 2 unrelated Argon2 timeouts under
  parallel CPU load. The exact standalone rerun passed: 9 tests.
- `git diff --check` passed.

## Live PostgreSQL Tests

Final disposable Compose project:
`audio-nav-task4-final-2c86c8b7`

Compose file:
`artifacts/platform-api/docker-compose.test.yml`

Approved URLs used together:

```text
PLATFORM_TEST_DATABASE_URL=postgres://apollo_platform_migrator:platform_migrator_test@127.0.0.1:55432/apollo_platform_test
PLATFORM_TEST_RUNTIME_DATABASE_URL=postgres://apollo_platform_runtime:platform_runtime_test@127.0.0.1:55432/apollo_platform_test
```

Serial live commands and results:

```text
pnpm --dir ../../lib/platform-db exec vitest run src/integration.test.ts --reporter=dot
PASS: 18 tests

pnpm exec vitest run src/domain/postgres-repository.integration.test.ts --reporter=dot
PASS: 7 tests

pnpm exec vitest run src/domain/authorization.integration.test.ts --reporter=dot
PASS: 4 tests
```

The final project was removed in a PowerShell `finally` block with:

```text
docker compose -p audio-nav-task4-final-2c86c8b7 -f docker-compose.test.yml down --volumes --remove-orphans
```

The container, network, and named volume were all confirmed removed. Earlier
disposable RED projects were also removed in `finally` blocks.

## Files

- `lib/platform-db/migrations/0005_authorization_code_digest_read.sql`
- `lib/platform-db/src/migrations.ts`
- `lib/platform-db/src/migrations.test.ts`
- `lib/platform-db/src/migration-manifest.test.ts`
- `lib/platform-db/src/integration.test.ts`
- `lib/platform-contract/src/index.ts`
- `lib/platform-contract/src/index.test.ts`
- `artifacts/platform-api/src/domain/repository.ts`
- `artifacts/platform-api/src/domain/postgres-repository.ts`
- `artifacts/platform-api/src/domain/postgres-repository.test.ts`
- `artifacts/platform-api/src/domain/postgres-repository.integration.test.ts`
- `artifacts/platform-api/src/domain/oauth-clients.ts`
- `artifacts/platform-api/src/domain/oauth-clients.test.ts`
- `artifacts/platform-api/src/domain/assertions.ts`
- `artifacts/platform-api/src/domain/assertions.test.ts`
- `artifacts/platform-api/src/domain/authorization.ts`
- `artifacts/platform-api/src/domain/authorization.test.ts`
- `artifacts/platform-api/src/domain/authorization.integration.test.ts`
- `artifacts/platform-api/src/domain/audit.ts`
- `artifacts/platform-api/src/domain/errors.ts`
- `.superpowers/sdd/task-4-report.md`

## Self-Review

- Migration `0005` is SELECT-only, checksum-pinned, default-deny, exact-digest
  visible, and does not permit digest-selected mutation.
- Exchange performs digest discovery, establishes account context, then re-locks
  account, portal session, installation, and code before status/binding decisions.
- Client authentication hashes exact UTF-8 bytes and uses fixed-size
  `timingSafeEqual`.
- Redirects are checked at issue and exchange against the exact registry.
- PKCE is S256-only; verifier, client, redirect, replay, expiry, and inactive
  binding failures return generic `invalid_grant`.
- Account, session, installation, code, and entitlement dates are checked for
  finite values. Current module state/revocation/expiry is projected at exchange
  and introspection time.
- Code consumption occurs before Ed25519 signing and successful exchange audit.
  Concurrent live exchange produced exactly one assertion.
- Audit payloads exclude raw/digested code and state, verifier/challenge, client
  secret/digest, assertion, nonce, and key material.
- The signer imports only the active private Ed25519 JWK and exposes a deeply
  frozen public-only overlapping JWKS.
- The authorization service repository type remains the narrow binding boundary
  plus explicit picks for account, entitlement, and audit methods.

## Concerns

1. PostgreSQL cannot perform the brief's literal initial digest `FOR UPDATE`
   while also enforcing a SELECT-only digest policy. The secure implemented
   sequence is digest SELECT discovery followed by mandatory account-context
   `FOR UPDATE` re-lock before any decision or mutation. Live concurrent exchange
   and no-digest-mutation tests cover this behavior.
2. The normal whole-package Platform API typecheck now reports the expected
   non-exhaustive `src/http/errors.ts` switch for the four new shared codes.
   That HTTP mapping is explicitly Task 5 and was not edited. Task 4 roots pass
   strict typechecking.

## Review Fix: Post-Lock Authorization Time

### Finding And Fix

The Task 4 review found that `exchangeCode` and `introspect` captured the current
time before entering their transactions. Lock contention could therefore let an
authorization code, portal session, or entitlement remain valid according to a
stale pre-wait timestamp.

Both methods now call `finiteNow(this.clock)` inside the transaction, after all
account/session/installation/code locks and consistency checks have completed,
immediately before status, expiry, entitlement, and consume decisions. Client
authentication remains outside the transaction. Generic `invalid_grant`
behavior and success-only, secret-free audit behavior are unchanged.

### Review-Fix RED Evidence

Command:

```text
pnpm --filter @workspace/platform-api exec vitest run src/domain/authorization.test.ts
```

Result before the production change: 1 file failed, 2 failed and 35 passed.
The exchange test incorrectly received a signed assertion after its code and
session expired while the transaction callback was gated. The introspection
test incorrectly returned `tf.search` after that entitlement expired while the
final installation lock was gated.

### Review-Fix GREEN Evidence

Focused authorization command:

```text
pnpm --filter @workspace/platform-api exec vitest run src/domain/authorization.test.ts
```

Result: 1 file passed, 37 tests passed.

Full focused Task 4 command:

```text
pnpm --dir artifacts/platform-api exec vitest run src/domain/oauth-clients.test.ts src/domain/authorization.test.ts src/domain/assertions.test.ts src/domain/postgres-repository.test.ts --reporter=dot
```

Result: 4 files passed, 72 tests passed.

### Review-Fix Live PostgreSQL Test

Disposable Compose project:
`audio-nav-task4-timefix-a863e588`

Approved URLs used together:

```text
PLATFORM_TEST_DATABASE_URL=postgres://apollo_platform_migrator:platform_migrator_test@127.0.0.1:55432/apollo_platform_test
PLATFORM_TEST_RUNTIME_DATABASE_URL=postgres://apollo_platform_runtime:platform_runtime_test@127.0.0.1:55432/apollo_platform_test
```

Command from `artifacts/platform-api`:

```text
pnpm exec vitest run src/domain/authorization.integration.test.ts --reporter=dot
```

Result: 1 file passed, 4 tests passed. A PowerShell `finally` block ran:

```text
docker compose -p audio-nav-task4-timefix-a863e588 -f artifacts/platform-api/docker-compose.test.yml down --volumes --remove-orphans
```

Cleanup exited zero. Follow-up label queries confirmed zero remaining
containers, volumes, and networks for the disposable project.

### Review-Fix Files And Self-Review

- `artifacts/platform-api/src/domain/authorization.ts`
- `artifacts/platform-api/src/domain/authorization.test.ts`
- `.superpowers/sdd/task-4-report.md`

The deterministic tests use controlled promises rather than elapsed wall time.
Exchange verifies generic `invalid_grant`, no consume, no signing, and no audit
after a transaction wait crosses code/session expiry. Introspection verifies
that a final binding-lock wait crossing entitlement expiry returns the current
empty entitlement projection. No Task 5 HTTP files or repository interfaces
were changed, and no new concern was introduced; the two existing Task 4
concerns above remain unchanged.
