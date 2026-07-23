# Task 3: End-User Platform Sessions Report

## Scope

Implemented the domain-only `UserSessionService` for the `apollo-portal`
audience. No HTTP routes, OAuth flow code, or product authorization service was
added.

## RED Evidence

Command run before production implementation:

```powershell
pnpm --dir artifacts/platform-api test -- src/domain/user-sessions.test.ts
```

Result: failed as expected because
`src/domain/user-sessions.test.ts` could not import the absent
`./user-sessions.js` module. The test file reported zero executed tests and the
suite failure was the missing service module.

## GREEN Evidence

Final focused unit command:

```powershell
pnpm --dir artifacts/platform-api test -- src/domain/user-sessions.test.ts
```

Result: exit 0, 14 test files passed, 262 tests passed, 16 skipped.

Final type check:

```powershell
pnpm --dir artifacts/platform-api typecheck
```

Result: exit 0.

Final PostgreSQL integration command used a unique Compose project and both
database URLs:

```powershell
docker compose -p audio-nav-task3-45d2d4a0 -f docker-compose.test.yml up -d --wait
$env:PLATFORM_TEST_DATABASE_URL = 'postgres://apollo_platform_migrator:platform_migrator_test@127.0.0.1:55432/apollo_platform_test'
$env:PLATFORM_TEST_RUNTIME_DATABASE_URL = 'postgres://apollo_platform_runtime:platform_runtime_test@127.0.0.1:55432/apollo_platform_test'
pnpm test -- src/domain/user-sessions.integration.test.ts
docker compose -p audio-nav-task3-45d2d4a0 -f docker-compose.test.yml down --volumes --remove-orphans
```

Result: exit 0, 19 test files passed, 275 tests passed, 3 skipped. The Compose
stack was stopped and removed with volumes and orphans in a `finally` block.

## Coverage

- Verified pending users receive a portal session and authenticate with
  `status: "pending"`; the result is portal-scoped rather than a product session.
- Login only permits email-verified `pending` or `active` accounts.
- Invalid, unverified, suspended, deleted, unknown, and wrong-password login
  attempts receive generic `invalid_credentials`; unknown users follow the dummy
  Argon2id verification path.
- Portal login rotates only `apollo-portal` sessions, preserves admin/product
  sessions, stores only the opaque-token digest, and supports opportunistic
  Argon2 rehashing.
- Authentication and revocation reject expired, revoked, wrong-audience, and
  account-ineligible sessions, while non-finite persisted session dates fail
  closed as `policy_unavailable`.
- Audit payloads contain session audience, expiry/revocation state, rotation
  count, and account status only. They exclude email, password, raw token, and
  token digest.
- PostgreSQL coverage verifies the runtime RLS path, digest-only session storage,
  verified-pending portal state, exact-session revocation, and redacted audits.

## Changed Files

- `artifacts/platform-api/src/domain/user-sessions.ts`
- `artifacts/platform-api/src/domain/user-sessions.test.ts`
- `artifacts/platform-api/src/domain/user-sessions.integration.test.ts`
- `artifacts/platform-api/src/domain/audit.ts`
- `artifacts/platform-api/src/domain/errors.ts`

## Self-Review

- Portal behavior remains audience-isolated: login rotation targets only
  `apollo-portal`; authenticate and revoke require that exact audience.
- The portal dummy hash is a separate fixed Argon2id hash from the operator
  dummy hash and matches the approved profile.
- Session lookup is repeated under account RLS before authentication or
  revocation decisions, matching the operator-session stale-read defense.
- No portal logic imports or couples to a future product authorization service.

## Concerns

- Product access denial is intentionally expressed through the authenticated
  portal session's `pending` status and portal audience. Task 3 does not create
  the future authorization service or product HTTP/OAuth boundaries that will
  consume that contract.
