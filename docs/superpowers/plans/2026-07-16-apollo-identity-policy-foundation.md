# Apollo Identity/Policy Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first independently deployable Apollo Platform backend slice: immutable PostgreSQL migrations, three registration modes, invite redemption, operator sessions, auditable module entitlements, and a fail-closed policy evaluator.

**Architecture:** Add a separate `platform-api` artifact and `platform-db`/`platform-contract` libraries rather than extending the Apollo TF API or sharing its database. The API uses dependency-injected domain services over PostgreSQL transactions; raw secrets are hashed before persistence, operator sessions use a separate `apollo-admin` audience, and every protected mutation writes its audit event in the same transaction. This plan intentionally stops before Authorization Code + PKCE, TF route enforcement, portal/admin UI, and remote Coolify rollout; those are separate dependent plans after this foundation is stable.

**Tech Stack:** TypeScript 5.9, Node.js, Express 5, Zod 3, PostgreSQL 16, `pg`, Argon2id, Vitest 4, Docker Compose for disposable integration services.

## Global Constraints

- Registration mode is exactly `closed`, `invite_only`, or `open_approval`.
- Account status is exactly `pending`, `active`, `suspended`, or `deleted`.
- Module keys are normalized lowercase dotted identifiers; initial keys are `tf.search`, `tf.integrations`, `tf.downloads`, and `tf.collections`.
- Passwords use Argon2id; raw passwords, invite tokens, verification tokens, and session tokens are never stored or logged.
- Operator sessions use audience `apollo-admin`, a host-only `__Host-apollo_admin` cookie, and cannot be created from product entitlements.
- Invite redemption, usage increment, account creation, credentials, initial grants, and audit evidence commit in one PostgreSQL transaction with row locking.
- Runtime roles do not own tables and do not receive `BYPASSRLS`; RLS defaults deny when `app.account_id` is absent.
- Every operator mutation requires a non-empty reason and records actor, target, correlation ID, previous state, and new state.
- Missing policy mapping or policy-store failure fails closed.
- No HomeNode, Coolify, Caddy, UFW, DNS, Apollo GA, Remnawave, or Android mutation is part of this plan.

## File Structure

- `lib/platform-contract/`: shared Zod DTOs, enums, stable error codes, and route capability declarations.
- `lib/platform-db/`: PostgreSQL pool factory, immutable migration runner, SQL migrations, transaction helpers, and integration tests.
- `artifacts/platform-api/src/domain/`: normalization, token/password primitives, registration, invitation, operator-session, entitlement, and audit services.
- `artifacts/platform-api/src/routes/`: public registration and operator HTTP adapters only; business rules remain in domain services.
- `artifacts/platform-api/postgres/`: one-time local role bootstrap used by disposable and local Compose environments.
- `artifacts/platform-api/docker-compose.test.yml`: isolated PostgreSQL/Redis test services bound to loopback only.

---

### Task 1: Platform Contract Package

**Files:**
- Create: `lib/platform-contract/package.json`
- Create: `lib/platform-contract/tsconfig.json`
- Create: `lib/platform-contract/src/index.ts`
- Create: `lib/platform-contract/src/index.test.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: `registrationModeSchema`, `accountStatusSchema`, `moduleKeySchema`, `platformErrorCodeSchema`, `registrationStatusResponseSchema`, `createRegistrationRequestSchema`, `operatorSessionRequestSchema`, `createInvitationRequestSchema`, `changeRegistrationModeRequestSchema`, `changeEntitlementRequestSchema`, `policyDecisionSchema`, and their inferred TypeScript types.
- Produces: `PLATFORM_MODULE_KEYS` and `PROTECTED_PLATFORM_ROUTES` with explicit capability mappings.

- [ ] **Step 1: Create the package scaffold and write failing contract tests**

Create `package.json` with the existing workspace conventions (`type: module`, `exports`, `test`, and `typecheck` scripts), `zod: catalog:` plus Vitest/Node test dependencies, and create the composite `tsconfig.json`. Add the package to the root TypeScript project references, run `pnpm install`, then add `src/index.test.ts` with these assertions while leaving `src/index.ts` absent:

```ts
expect(registrationModeSchema.options).toEqual([
  "closed",
  "invite_only",
  "open_approval",
]);
expect(moduleKeySchema.safeParse("TF.Search").success).toBe(false);
expect(moduleKeySchema.parse("tf.search")).toBe("tf.search");
expect(platformErrorCodeSchema.parse("module_access_denied")).toBe(
  "module_access_denied",
);
expect(new Set(Object.keys(PROTECTED_PLATFORM_ROUTES))).toEqual(
  new Set([
    "PATCH /v1/operator/registration-settings",
    "POST /v1/operator/invitations",
    "POST /v1/operator/invitations/:id/revoke",
    "POST /v1/operator/accounts/:id/activate",
    "POST /v1/operator/accounts/:id/suspend",
    "PUT /v1/operator/accounts/:id/entitlements/:moduleKey",
    "DELETE /v1/operator/accounts/:id/entitlements/:moduleKey",
  ]),
);
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm --dir lib/platform-contract test`

Expected: FAIL because the package and exported schemas do not exist.

- [ ] **Step 3: Implement the package**

Use strict Zod objects, `.trim().min(1)` for reasons/display names, normalized email validation, UUID identifiers, ISO timestamps, and only public-safe response fields. Define `PLATFORM_MODULE_KEYS` as a readonly tuple and define every protected operator route in `PROTECTED_PLATFORM_ROUTES`; no wildcard or implicit allow entry is permitted.

- [ ] **Step 4: Run contract tests and typecheck**

Run: `pnpm --dir lib/platform-contract test && pnpm --dir lib/platform-contract typecheck`

Expected: all tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

```powershell
git add lib/platform-contract tsconfig.json
git commit -m "feat(platform): define identity policy contracts"
```

### Task 2: Immutable Platform Database and Migration Runner

**Files:**
- Create: `lib/platform-db/package.json`
- Create: `lib/platform-db/tsconfig.json`
- Create: `lib/platform-db/src/index.ts`
- Create: `lib/platform-db/src/migrations.ts`
- Create: `lib/platform-db/src/migrations.test.ts`
- Create: `lib/platform-db/src/integration.test.ts`
- Create: `lib/platform-db/migrations/0001_platform_identity.sql`
- Create: `artifacts/platform-api/postgres/0000_roles.sql`
- Create: `artifacts/platform-api/docker-compose.test.yml`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: `createPlatformPool(connectionString: string): Pool`.
- Produces: `runPlatformMigrations(pool: Pool, directory?: string): Promise<MigrationResult>` where `MigrationResult` contains ordered `applied` and `alreadyApplied` migration names.
- Produces: `withPlatformTransaction<T>(pool, callback): Promise<T>` and `setAccountContext(client, accountId): Promise<void>`.

- [ ] **Step 1: Create the package scaffold and write migration-runner RED tests**

Create `package.json` with `@workspace/platform-contract`, `pg`, test/typecheck scripts, and Vitest/Node/PostgreSQL type dependencies; create the composite `tsconfig.json`; add both new libraries to the root TypeScript project references; and run `pnpm install`. Then write the runner test before creating its implementation.

Test deterministic numeric ordering, SHA-256 checksum persistence, advisory-lock acquisition/release, one transaction per migration, idempotent second run, and checksum mismatch rejection with code `migration_checksum_mismatch`.

```ts
await expect(runPlatformMigrations(pool, fixtureDirectory)).resolves.toEqual({
  applied: ["0001_first.sql", "0002_second.sql"],
  alreadyApplied: [],
});
await expect(runPlatformMigrations(pool, mutatedFixtureDirectory)).rejects.toMatchObject({
  code: "migration_checksum_mismatch",
});
```

- [ ] **Step 2: Run runner tests and verify RED**

Run: `pnpm --dir lib/platform-db test -- src/migrations.test.ts`

Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Implement the migration runner**

Create `apollo_platform.schema_migrations(name text primary key, checksum text not null, applied_at timestamptz not null default now())`. Acquire `pg_advisory_lock(hashtext('apollo_platform_migrations'))`, read `.sql` files matching `/^\d{4}_[a-z0-9_]+\.sql$/`, compare immutable checksums, execute each unapplied file and history insert in one transaction, and release the advisory lock in `finally`.

- [ ] **Step 4: Write the complete version `0001` SQL migration**

The migration creates the 17 approved tables, UUID primary keys, normalized unique email/module constraints, foreign keys, expiry/revocation checks, invitation `uses_count <= uses_limit`, immutable audit-event trigger, seed registration mode `closed`, and the four initial modules. Enable and force RLS on account-owned tables. Policies read `NULLIF(current_setting('app.account_id', true), '')::uuid`; absent context matches no rows.

- [ ] **Step 5: Write PostgreSQL integration RED tests**

Start the disposable Compose project and verify:

```ts
expect(await scalar(runtime, "select count(*) from apollo_platform.accounts")).toBe("0");
await expect(runtime.query("select * from apollo_platform.auth_sessions"))
  .resolves.toMatchObject({ rowCount: 0 });
await expect(runtime.query("alter table apollo_platform.accounts disable row level security"))
  .rejects.toBeDefined();
await expect(runtime.query("delete from apollo_platform.audit_events"))
  .rejects.toBeDefined();
```

Also verify clean install, second-run idempotence, unique normalized email/module keys, default-deny RLS, runtime role non-ownership, and no `rolbypassrls`.

- [ ] **Step 6: Run disposable PostgreSQL integration tests**

Run:

```powershell
docker compose -f artifacts/platform-api/docker-compose.test.yml up -d --wait platform-postgres platform-redis
$env:PLATFORM_TEST_DATABASE_URL='postgres://apollo_platform_migrator:platform_migrator_test@127.0.0.1:55432/apollo_platform_test'
$env:PLATFORM_TEST_RUNTIME_DATABASE_URL='postgres://apollo_platform_runtime:platform_runtime_test@127.0.0.1:55432/apollo_platform_test'
pnpm --dir lib/platform-db test
docker compose -f artifacts/platform-api/docker-compose.test.yml down -v
```

Expected: all unit and PostgreSQL integration tests PASS; Compose publishes only loopback test ports.

- [ ] **Step 7: Commit**

```powershell
git add lib/platform-db artifacts/platform-api/postgres artifacts/platform-api/docker-compose.test.yml tsconfig.json
git commit -m "feat(platform): add immutable identity database"
```

### Task 3: Security Primitives and Repository Boundary

**Files:**
- Create: `artifacts/platform-api/package.json`
- Create: `artifacts/platform-api/tsconfig.json`
- Create: `artifacts/platform-api/src/domain/security.ts`
- Create: `artifacts/platform-api/src/domain/security.test.ts`
- Create: `artifacts/platform-api/src/domain/repository.ts`
- Create: `artifacts/platform-api/src/domain/postgres-repository.ts`
- Create: `artifacts/platform-api/src/domain/postgres-repository.test.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: `normalizeEmail(value: string): string`, `normalizeModuleKey(value: string): string`, `issueOpaqueToken(bytes?: number): { raw: string; digest: string }`, `digestOpaqueToken(raw: string): string`, `hashPassword(password: string): Promise<string>`, and `verifyPassword(hash: string, password: string): Promise<{ valid: boolean; needsRehash: boolean }>`.
- Produces: `PlatformRepository` with explicit transaction-scoped methods for settings, accounts, credentials, invitations, grants, sessions, entitlements, modules, and audit events.

- [ ] **Step 1: Create the API package scaffold and add dependencies**

Create `artifacts/platform-api/package.json` first with the existing artifact conventions, workspace dependencies on `@workspace/platform-contract` and `@workspace/platform-db`, and `test`, `typecheck`, `build`, and `start` scripts. Create its `tsconfig.json`, add its root TypeScript references, and then run:

Run: `pnpm --dir artifacts/platform-api add argon2 express cookie-parser pino zod@3.25.76 pg && pnpm --dir artifacts/platform-api add -D @types/express @types/cookie-parser @types/node @types/pg vitest`

- [ ] **Step 2: Write security and repository RED tests**

Tests assert lowercase/trimmed email and module normalization, 32-byte opaque tokens, deterministic SHA-256 digests, Argon2id hashes without raw passwords, valid verification, invalid verification, and explicit rehash detection when parameters change. Leave the production module absent until RED is observed.

Repository tests use a recording `PoolClient` test double to assert parameterized SQL, stable row mapping, explicit `FOR UPDATE` on the three lock methods, no raw-token parameters, and stable domain-error mapping for PostgreSQL uniqueness/check/foreign-key failures. The test double verifies query text/values; it does not emulate database behavior.

- [ ] **Step 3: Run tests and verify RED**

Run: `pnpm --dir artifacts/platform-api test -- src/domain/security.test.ts src/domain/postgres-repository.test.ts`

Expected: FAIL because security functions do not exist.

- [ ] **Step 4: Implement primitives and repository types**

Use `randomBytes(32).toString('base64url')`, SHA-256 hex digests, `timingSafeEqual` where comparing configured bootstrap secrets, and Argon2id parameters stored by the library in the encoded hash. Repository methods accept an existing `PoolClient` for multi-record transactions and never accept raw token values.

- [ ] **Step 5: Implement PostgreSQL repository methods**

Use parameterized SQL only. Map PostgreSQL uniqueness/check failures to stable domain errors without exposing SQL, connection strings, email existence, or token digests. Keep row-locking methods explicit: `lockRegistrationSettings`, `lockInvitationByDigest`, and `lockAccountById` use `FOR UPDATE`.

- [ ] **Step 6: Run security tests and typecheck**

Run: `pnpm --dir artifacts/platform-api test -- src/domain/security.test.ts src/domain/postgres-repository.test.ts && pnpm --dir artifacts/platform-api typecheck`

Expected: PASS and TypeScript exits 0.

- [ ] **Step 7: Commit**

```powershell
git add artifacts/platform-api lib/platform-contract lib/platform-db pnpm-lock.yaml tsconfig.json
git commit -m "feat(platform): add identity security primitives"
```

### Task 4: Registration Mode and Account Lifecycle Services

**Files:**
- Create: `artifacts/platform-api/src/domain/errors.ts`
- Create: `artifacts/platform-api/src/domain/audit.ts`
- Create: `artifacts/platform-api/src/domain/registration.ts`
- Create: `artifacts/platform-api/src/domain/registration.test.ts`

**Interfaces:**
- Produces: `RegistrationService.getStatus()`, `changeMode(input, operator)`, `register(input, context)`, `consumeVerificationToken(rawToken, context)`, `activateAccount(input, operator)`, and `suspendAccount(input, operator)`.
- Consumes: `PlatformRepository`, password/token primitives, transaction helper, and public contract schemas.

- [ ] **Step 1: Write table-driven registration RED tests**

Cover all three modes, mode changes not revoking active accounts, closed denial, invite-required denial, open account creation as `pending`, duplicate-email response normalization, verification not auto-activating open-approval accounts, activation requiring at least one live entitlement, suspension revoking sessions, deleted terminal state, and required audit reason/correlation ID.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --dir artifacts/platform-api test -- src/domain/registration.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the service with transaction ownership**

`changeMode`, registration creation, verification consumption, activation, and suspension each open exactly one transaction. Audit insertion occurs before commit and any audit failure rolls the mutation back. Public duplicate-email behavior returns stable `registration_not_available`; internal logs receive only correlation ID and error class.

- [ ] **Step 4: Run registration tests**

Run: `pnpm --dir artifacts/platform-api test -- src/domain/registration.test.ts`

Expected: all registration tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add artifacts/platform-api/src/domain
git commit -m "feat(platform): implement registration lifecycle"
```

### Task 5: Atomic Invitations and Initial Grants

**Files:**
- Create: `artifacts/platform-api/src/domain/invitations.ts`
- Create: `artifacts/platform-api/src/domain/invitations.test.ts`
- Create: `artifacts/platform-api/src/domain/invitations.integration.test.ts`

**Interfaces:**
- Produces: `InvitationService.create(input, operator)`, `inspect(rawToken, email?)`, `redeem(input, context)`, and `revoke(input, operator)`.
- Produces: `create` returns the raw invite token exactly once plus public invitation metadata; persisted records contain only its digest.

- [ ] **Step 1: Write invitation RED tests**

Cover expiry, revocation, optional normalized email binding, usage limit, unknown module keys, raw-token non-persistence, audit redaction, and initial grants copied to account entitlements with source `invitation`.

- [ ] **Step 2: Write concurrent redemption RED integration test**

For one invite with `uses_limit = 1`, run two redemptions concurrently and assert exactly one account commits, `uses_count = 1`, and the loser receives `invitation_not_available`.

- [ ] **Step 3: Run tests and verify RED**

Run: `pnpm --dir artifacts/platform-api test -- src/domain/invitations.test.ts src/domain/invitations.integration.test.ts`

Expected: FAIL because the invitation service does not exist.

- [ ] **Step 4: Implement atomic redemption**

Lock the invitation row with `FOR UPDATE`, validate all constraints after acquiring the lock, increment usage, create account/credential/verification token, copy invitation grants, and append audit evidence inside the same transaction. Never return whether a non-matching email or token digest exists.

- [ ] **Step 5: Run invitation tests**

Run: `pnpm --dir artifacts/platform-api test -- src/domain/invitations.test.ts src/domain/invitations.integration.test.ts`

Expected: unit and concurrent PostgreSQL tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add artifacts/platform-api/src/domain/invitations*
git commit -m "feat(platform): add atomic invitation redemption"
```

### Task 6: Operator Sessions, Entitlements, and Fail-closed Policy

**Files:**
- Create: `artifacts/platform-api/src/domain/operator-sessions.ts`
- Create: `artifacts/platform-api/src/domain/operator-sessions.test.ts`
- Create: `artifacts/platform-api/src/domain/entitlements.ts`
- Create: `artifacts/platform-api/src/domain/entitlements.test.ts`
- Create: `artifacts/platform-api/src/domain/policy.ts`
- Create: `artifacts/platform-api/src/domain/policy.test.ts`

**Interfaces:**
- Produces: `OperatorSessionService.bootstrap`, `login`, `authenticate`, and `revoke`.
- Produces: `EntitlementService.grant`, `revoke`, and `listEffective`.
- Produces: `PolicyService.evaluate({ accountId, sessionId, audience, requiredModules, now }): Promise<PolicyDecision>`.

- [ ] **Step 1: Write operator-session RED tests**

Cover one-time bootstrap only when no operator role exists, constant-time bootstrap-token comparison, active account and Argon2 password requirement, `apollo-admin` audience isolation, hashed session token, rotation on login, expiry/revocation, suspended/deleted rejection, and generic invalid-credential responses.

- [ ] **Step 2: Write entitlement/policy RED tests**

Cover grant/revoke/expiry, required reason, unknown module, activation requiring a live entitlement, immediate deny after revocation, wrong session audience, missing route mapping startup failure, missing/expired/revoked modules, policy-store exception mapped to `policy_unavailable`, and stable `module_access_denied` with only public missing keys.

- [ ] **Step 3: Run tests and verify RED**

Run: `pnpm --dir artifacts/platform-api test -- src/domain/operator-sessions.test.ts src/domain/entitlements.test.ts src/domain/policy.test.ts`

Expected: FAIL because services do not exist.

- [ ] **Step 4: Implement services**

Session creation stores only SHA-256 digests and the exact `apollo-admin` audience. Entitlement mutation and audit insertion share one transaction. Policy evaluation checks account status, session status/audience/expiry, then effective grants; catch repository errors only at the outer boundary and return a fail-closed decision.

- [ ] **Step 5: Run domain tests**

Run: `pnpm --dir artifacts/platform-api test -- src/domain/operator-sessions.test.ts src/domain/entitlements.test.ts src/domain/policy.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add artifacts/platform-api/src/domain
git commit -m "feat(platform): enforce operator and module policy"
```

### Task 7: Platform HTTP API

**Files:**
- Create: `artifacts/platform-api/src/app.ts`
- Create: `artifacts/platform-api/src/index.ts`
- Create: `artifacts/platform-api/src/http/errors.ts`
- Create: `artifacts/platform-api/src/http/operator-auth.ts`
- Create: `artifacts/platform-api/src/routes/public-registration.ts`
- Create: `artifacts/platform-api/src/routes/operator.ts`
- Create: `artifacts/platform-api/src/routes/routes.test.ts`
- Create: `artifacts/platform-api/src/logger.ts`
- Create: `artifacts/platform-api/build.mjs`
- Create: `artifacts/platform-api/.env.example`

**Interfaces:**
- Public endpoints: `GET /healthz`, `GET /readyz`, `GET /v1/registration`, `POST /v1/registrations`, `POST /v1/email-verifications/consume`.
- Operator endpoints: `POST /v1/operator/bootstrap`, `POST /v1/operator/sessions`, `DELETE /v1/operator/sessions/current`, mode/invite/account/entitlement routes declared in `PROTECTED_PLATFORM_ROUTES`.

- [ ] **Step 1: Write HTTP RED tests with injected services**

Assert strict Zod parsing, JSON content type, `Cache-Control: no-store` for identity responses, `__Host-apollo_admin` cookie attributes, CSRF rejection for operator mutations without matching origin/header token, generic public errors, stable domain error mapping, sanitized logs, and 503 readiness before migrations complete.

- [ ] **Step 2: Verify every protected route has policy middleware**

Enumerate Express route registrations in the test and compare them with `PROTECTED_PLATFORM_ROUTES`. Any protected route absent from the manifest or middleware map must fail the test.

- [ ] **Step 3: Run tests and verify RED**

Run: `pnpm --dir artifacts/platform-api test -- src/routes/routes.test.ts`

Expected: FAIL because the app/routes do not exist.

- [ ] **Step 4: Implement the Express app and adapters**

Use an app factory with injected domain services. Configure 64 KiB JSON limits, explicit CORS allowlist, request IDs, redacted Pino fields, `X-Content-Type-Options: nosniff`, and no startup migrations. Set the operator cookie with `Secure`, `HttpOnly`, `SameSite=Lax`, path `/`, no `Domain`, and production name `__Host-apollo_admin`.

- [ ] **Step 5: Run HTTP tests, full platform tests, typecheck, and build**

Run:

```powershell
pnpm --dir artifacts/platform-api test
pnpm --dir artifacts/platform-api typecheck
pnpm --dir artifacts/platform-api build
```

Expected: all tests PASS, typecheck exits 0, and `dist/index.mjs` is produced.

- [ ] **Step 6: Commit**

```powershell
git add artifacts/platform-api
git commit -m "feat(platform): expose registration and policy API"
```

### Task 8: Local Containers, End-to-end Smoke, and Stage Status

**Files:**
- Create: `artifacts/platform-api/Dockerfile`
- Create: `artifacts/platform-api/docker-compose.yml`
- Create: `artifacts/platform-api/scripts/smoke.mjs`
- Create: `artifacts/platform-api/src/e2e.test.ts`
- Modify: `.dockerignore`
- Modify: `MODULES.md`
- Modify: `IMPLEMENTATION_STATUS.md`

**Interfaces:**
- Produces separate `platform-postgres`, `platform-redis`, one-shot `platform-migrate`, and `platform-api` services.
- Produces health/readiness and a smoke sequence: closed status, bootstrap operator, login, switch to invite-only, create/redeem invite, verify account, grant module, activate account, evaluate allow, revoke module, evaluate deny.

- [ ] **Step 1: Write Compose contract RED tests**

Assert PostgreSQL and Redis have no host-published production ports, API binds only `127.0.0.1`, migration and runtime URLs use different roles, migration is a one-shot dependency before API readiness, secrets have empty-default interpolation, and no service receives Docker socket, SSH, Coolify, Caddy, UFW, GA, or TF database credentials.

- [ ] **Step 2: Implement non-root image and local Compose**

Build only required workspace packages, run the API as an unprivileged user, add an HTTP healthcheck, and keep database/Redis private. The migration service executes `runPlatformMigrations` once and exits before API startup.

- [ ] **Step 3: Run local end-to-end smoke**

Run:

```powershell
docker compose -f artifacts/platform-api/docker-compose.yml config
docker compose -f artifacts/platform-api/docker-compose.yml up -d --build --wait
pnpm --dir artifacts/platform-api test -- src/e2e.test.ts
node artifacts/platform-api/scripts/smoke.mjs
docker compose -f artifacts/platform-api/docker-compose.yml down -v
```

Expected: the full registration/invite/entitlement allow-then-deny flow passes and all containers stop cleanly.

- [ ] **Step 4: Run workspace regression**

Run:

```powershell
pnpm --dir lib/platform-contract test
pnpm --dir lib/platform-db test
pnpm --dir artifacts/platform-api test
pnpm --dir artifacts/api-server test
pnpm --dir artifacts/admin-dashboard test
pnpm run typecheck
pnpm --dir artifacts/platform-api build
pnpm --dir artifacts/api-server build
pnpm --dir artifacts/admin-dashboard build
git diff --check
```

Expected: all suites and builds PASS; no secret or remote-infrastructure file is added.

- [ ] **Step 5: Perform independent spec and quality reviews**

Dispatch separate reviewers. Required verdicts are `SPEC: PASS` and `QUALITY: APPROVED` with no unresolved P0/P1 findings. Any finding starts a new RED/GREEN fix cycle before merge.

- [ ] **Step 6: Update stage status and commit**

Record exact test counts, container smoke results, independent review verdicts, commit hashes, and the next stage (`Authorization Code + PKCE, TF enforcement, and operator/portal UI`) in `IMPLEMENTATION_STATUS.md`.

```powershell
git add artifacts/platform-api .dockerignore MODULES.md IMPLEMENTATION_STATUS.md
git commit -m "docs(platform): record identity foundation validation"
```

## Plan Self-review

- Spec coverage: database model, three modes, invitations, operator separation, module entitlements, audit, RLS, secret hashing, and fail-closed policy are covered.
- Deliberate follow-up scope: Authorization Code + PKCE, password reset/SMTP delivery, TF route enforcement, portal/admin UI, legacy session migration, and Coolify rollout each require a dependent plan after this foundation.
- Placeholder scan: no incomplete implementation markers are present.
- Type consistency: contract DTOs feed domain services; repository methods are transaction-scoped; HTTP adapters consume domain services; Compose runs the same migration runner used in integration tests.
