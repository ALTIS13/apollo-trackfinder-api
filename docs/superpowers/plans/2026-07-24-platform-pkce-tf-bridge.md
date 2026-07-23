# Apollo Platform PKCE and TF Policy Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Release 1 Authorization Code + PKCE backend, create server-side Apollo TF sessions, and enforce Platform module entitlements on TF HTTP and WebSocket operations.

**Architecture:** Apollo Platform remains the identity and policy authority. The browser carries only host-only cookies and a one-time PKCE transaction; `tf-api` performs the confidential code exchange, validates a short-lived signed assertion, stores the resulting TF session in Redis, and enforces capabilities server-side. Search, integration, download, and future parser containers communicate through authenticated HTTP/heartbeat contracts and never share databases, Docker sockets, SSH keys, or host control APIs.

**Tech Stack:** TypeScript, Express 5, PostgreSQL 16, Redis 7/ioredis, Zod, Argon2id, `jose`, Vitest, Docker Compose, pnpm 10.33.2.

## Global Constraints

- Use only PKCE `S256`; reject `plain`, missing challenges, malformed verifiers, replayed codes, redirect mismatch, state mismatch, audience mismatch, and nonce mismatch.
- Browser code must never receive Platform client secrets, assertion signing keys, refresh/session tokens, Spotify/Yandex provider tokens, or heartbeat keys.
- Cookies are Secure, HttpOnly, host-only, SameSite=Lax, path `/`, and use `__Host-` names in production.
- Raw passwords, authorization codes, session tokens, state values, verifiers, client secrets, assertions, and provider credentials are absent from logs, audit payloads, database rows, and error bodies.
- `pending`, `suspended`, and `deleted` accounts cannot exchange product authorization codes. Only `active` accounts receive TF assertions.
- TF capability keys remain exactly `tf.search`, `tf.integrations`, `tf.downloads`, and `tf.collections`.
- Protected TF routes fail closed when their policy mapping, TF session, Platform assertion, or required live introspection is unavailable.
- PostgreSQL and Redis remain private. Public web/API host ports bind only to loopback or the approved Caddy/Coolify ingress.
- Independently placed containers use private Coolify DNS or an owner-approved TLS API route. No module receives Docker socket, SSH, Coolify, Caddy, UFW, or broad host access.
- Local implementation does not require DNS changes. Before remote ingress, request owner confirmation for `apollot.ru`, `api.apollot.ru`, `tf.apollot.ru`, `api.tf.apollot.ru`, and `admin.apollot.ru`; modify Caddy only after a separate read-only preflight and explicit approval.
- Android APK work remains out of scope.

---

### Task 1: Shared OAuth and Assertion Contracts

**Files:**
- Modify: `lib/platform-contract/src/index.ts`
- Modify: `lib/platform-contract/src/index.test.ts`
- Modify: `lib/platform-contract/package.json`
- Modify: `artifacts/platform-api/package.json`
- Modify: `artifacts/api-server/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `userSessionRequestSchema`, `authorizationRequestSchema`, `authorizationCodeExchangeSchema`, `platformAssertionClaimsSchema`, `policyIntrospectionRequestSchema`, `policyIntrospectionResponseSchema`.
- Produces: inferred TypeScript types with the same base names and `Request`, `Claims`, or `Response` suffixes.
- Consumes: existing account/module key normalization conventions from `@workspace/platform-contract`.

- [ ] **Step 1: Write contract tests that reject downgrade and unknown fields**

```ts
it("accepts only exact S256 authorization input", () => {
  expect(authorizationRequestSchema.parse({
    clientId: "apollo-tf-web",
    redirectUri: "https://api.tf.apollot.ru/api/auth/callback",
    responseType: "code",
    codeChallenge: "A".repeat(43),
    codeChallengeMethod: "S256",
    state: "state-value",
    nonce: "nonce-value",
    installationId: "10000000-0000-4000-8000-000000000001",
    installationLabel: "Firefox on Windows",
  })).toMatchObject({ codeChallengeMethod: "S256" });

  expect(() => authorizationRequestSchema.parse({
    clientId: "apollo-tf-web",
    redirectUri: "https://api.tf.apollot.ru/api/auth/callback",
    responseType: "code",
    codeChallenge: "A".repeat(43),
    codeChallengeMethod: "plain",
    state: "state-value",
    nonce: "nonce-value",
    installationId: "10000000-0000-4000-8000-000000000001",
    installationLabel: "Firefox on Windows",
  })).toThrow();
});
```

- [ ] **Step 2: Run the focused contract test and verify RED**

Run: `pnpm --dir lib/platform-contract test`

Expected: FAIL because the OAuth schemas are not exported.

- [ ] **Step 3: Add strict bounded schemas and types**

```ts
export const authorizationRequestSchema = z.object({
  clientId: z.string().trim().min(1).max(128),
  redirectUri: z.string().url().max(2048),
  responseType: z.literal("code"),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeChallengeMethod: z.literal("S256"),
  state: z.string().min(16).max(512),
  nonce: z.string().min(16).max(512),
  installationId: z.string().uuid(),
  installationLabel: z.string().trim().min(1).max(120),
}).strict();

export const authorizationCodeExchangeSchema = z.object({
  grantType: z.literal("authorization_code"),
  clientId: z.string().trim().min(1).max(128),
  code: z.string().min(32).max(512),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  redirectUri: z.string().url().max(2048),
}).strict();
```

Define assertion claims with exact issuer, audience, subject/account, session, installation, nonce, entitlement array, `jti`, `iat`, `nbf`, and `exp` fields. Define introspection response as a strict discriminated union: `{ active: false }` or `{ active: true, accountId, sessionId, accountStatus: "active", entitlements, expiresAt }`.

- [ ] **Step 4: Add `jose` to Platform and TF API packages**

Run: `pnpm --filter @workspace/platform-api add jose@^6.1.3`

Expected: `artifacts/platform-api/package.json` and `pnpm-lock.yaml` include `jose`.

Run: `pnpm --filter @workspace/api-server add jose@^6.1.3`

Expected: `artifacts/api-server/package.json` uses the same resolved `jose` version.

- [ ] **Step 5: Run contract tests and typecheck**

Run: `pnpm --dir lib/platform-contract test`

Expected: PASS with the previous 5 tests plus the new OAuth/assertion tests.

Run: `pnpm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/platform-contract artifacts/platform-api/package.json artifacts/api-server/package.json pnpm-lock.yaml
git commit -m "feat(platform): define PKCE bridge contracts"
```

### Task 2: Authorization Binding Migration and Repository

**Files:**
- Create: `lib/platform-db/migrations/0004_authorization_code_binding.sql`
- Modify: `lib/platform-db/src/migrations.ts`
- Modify: `lib/platform-db/src/migrations.test.ts`
- Modify: `lib/platform-db/src/migration-manifest.test.ts`
- Modify: `lib/platform-db/src/integration.test.ts`
- Modify: `artifacts/platform-api/src/domain/repository.ts`
- Modify: `artifacts/platform-api/src/domain/postgres-repository.ts`
- Modify: `artifacts/platform-api/src/domain/postgres-repository.test.ts`
- Modify: `artifacts/platform-api/src/domain/postgres-repository.integration.test.ts`

**Interfaces:**
- Produces: `ClientInstallation`, `AuthorizationCode`, `CreateAuthorizationCodeInput`, and `ConsumeAuthorizationCodeInput`.
- Produces repository methods `upsertClientInstallation`, `lockClientInstallation`, `createAuthorizationCode`, `lockAuthorizationCodeByDigest`, and `consumeAuthorizationCode`.
- Consumes: existing digest-only repository conventions and `setAccountContext`.

- [ ] **Step 1: Write migration and repository RED tests**

```ts
expect(manifest.map((entry) => entry.name)).toEqual([
  "0001_platform_identity.sql",
  "0002_operator_bootstrap_guard.sql",
  "0003_runtime_migration_history_read.sql",
  "0004_authorization_code_binding.sql",
]);

expect(repositorySource).toMatch(/insert into apollo_platform\.authorization_codes/i);
expect(repositorySource).toMatch(/where code_digest = \$1[\s\S]*for update/i);
expect(repositorySource).not.toMatch(/\brawCode\b|\bcodeVerifier\b|\brawState\b/);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --dir lib/platform-db test`

Expected: FAIL because migration `0004` is absent.

Run: `pnpm --dir artifacts/platform-api test -- src/domain/postgres-repository.test.ts`

Expected: FAIL because authorization repository methods are absent.

- [ ] **Step 3: Add immutable migration `0004`**

```sql
alter table apollo_platform.authorization_codes
  add column auth_session_id uuid not null
    references apollo_platform.auth_sessions(id) on delete cascade,
  add column installation_id uuid not null,
  add column state_digest text not null;

alter table apollo_platform.authorization_codes
  add constraint authorization_codes_installation_fkey
    foreign key (installation_id, account_id)
    references apollo_platform.client_installations(id, account_id),
  add constraint authorization_codes_state_digest_check
    check (state_digest ~ '^[0-9a-f]{64}$');

create index authorization_codes_session_id_idx
  on apollo_platform.authorization_codes(auth_session_id);
```

Also grant only the exact runtime `select`, `insert`, and `update` privileges needed for installations, sessions, and authorization codes. Preserve forced RLS and default deny without account context.

- [ ] **Step 4: Implement digest-only repository methods**

```ts
createAuthorizationCode(
  client: PoolClient,
  input: CreateAuthorizationCodeInput,
): Promise<AuthorizationCode>;

lockAuthorizationCodeByDigest(
  client: PoolClient,
  codeDigest: string,
): Promise<AuthorizationCode | null>;

consumeAuthorizationCode(
  client: PoolClient,
  input: ConsumeAuthorizationCodeInput,
): Promise<AuthorizationCode | null>;
```

`consumeAuthorizationCode` must use `where consumed_at is null and expires_at > $consumedAt` and return `null` on replay/expiry. Mappers must reject malformed timestamps and cross-account installation/session relations.

- [ ] **Step 5: Run unit and disposable PostgreSQL integration tests**

Run: `pnpm --dir lib/platform-db test`

Expected: all non-environment tests PASS.

Run with both test database URLs: `pnpm --dir lib/platform-db test`

Expected: all migration and integration tests PASS, including exact manifest/history and RLS default deny.

Run with both test database URLs: `pnpm --dir artifacts/platform-api test -- src/domain/postgres-repository.test.ts src/domain/postgres-repository.integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/platform-db artifacts/platform-api/src/domain/repository.ts artifacts/platform-api/src/domain/postgres-repository.ts artifacts/platform-api/src/domain/postgres-repository.test.ts artifacts/platform-api/src/domain/postgres-repository.integration.test.ts
git commit -m "feat(platform): persist bound authorization codes"
```

### Task 3: End-User Platform Sessions

**Files:**
- Create: `artifacts/platform-api/src/domain/user-sessions.ts`
- Create: `artifacts/platform-api/src/domain/user-sessions.test.ts`
- Create: `artifacts/platform-api/src/domain/user-sessions.integration.test.ts`
- Modify: `artifacts/platform-api/src/domain/audit.ts`
- Modify: `artifacts/platform-api/src/domain/errors.ts`

**Interfaces:**
- Produces: `APOLLO_PORTAL_AUDIENCE = "apollo-portal"`.
- Produces: `UserSessionService.login`, `.authenticate`, `.revoke`.
- Produces: `AuthenticatedUser { accountId, sessionId, status, emailVerified }`.
- Consumes: `PlatformRepository`, Argon2 helpers, `withPlatformTransaction`, and digest-only auth sessions.

- [ ] **Step 1: Write RED tests for pending visibility and product denial**

```ts
it("creates a portal session for a verified pending account without granting product access", async () => {
  const result = await service.login(
    { email: "pending@example.test", password: "correct-password" },
    { correlationId },
  );
  expect(result.account.status).toBe("pending");
  expect(result.session.audience).toBe("apollo-portal");
  await expect(productAuthorization.authorize(result.rawToken, request))
    .rejects.toMatchObject({ code: "account_access_denied" });
});
```

Add cases for invalid credentials, dummy Argon2 verification, suspended/deleted accounts, unverified accounts, session expiry/revocation, audience isolation, session rotation, opportunistic rehash, and secret-free audit values.

- [ ] **Step 2: Run focused test and verify RED**

Run: `pnpm --dir artifacts/platform-api test -- src/domain/user-sessions.test.ts`

Expected: FAIL because `UserSessionService` is absent.

- [ ] **Step 3: Implement the service**

```ts
export interface AuthenticatedUser {
  readonly accountId: string;
  readonly sessionId: string;
  readonly status: "pending" | "active";
  readonly emailVerified: boolean;
}

export class UserSessionService {
  async login(input: UserSessionRequest, context: RequestContext): Promise<UserSessionResult>;
  async authenticate(rawToken: string): Promise<AuthenticatedUser>;
  async revoke(rawToken: string, context: RequestContext): Promise<void>;
}
```

Use a separate fixed dummy password hash and constant behavior for unknown email. Allow only verified `pending` and `active` accounts to create portal sessions. Rotate only `apollo-portal` sessions, never admin or TF product sessions.

- [ ] **Step 4: Run focused and integration tests**

Run: `pnpm --dir artifacts/platform-api test -- src/domain/user-sessions.test.ts`

Expected: PASS.

Run with both test database URLs: `pnpm --dir artifacts/platform-api test -- src/domain/user-sessions.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add artifacts/platform-api/src/domain
git commit -m "feat(platform): add end-user portal sessions"
```

### Task 4: PKCE Authorization, Signed Assertions, and Introspection

**Files:**
- Create: `artifacts/platform-api/src/domain/oauth-clients.ts`
- Create: `artifacts/platform-api/src/domain/oauth-clients.test.ts`
- Create: `artifacts/platform-api/src/domain/authorization.ts`
- Create: `artifacts/platform-api/src/domain/authorization.test.ts`
- Create: `artifacts/platform-api/src/domain/authorization.integration.test.ts`
- Create: `artifacts/platform-api/src/domain/assertions.ts`
- Create: `artifacts/platform-api/src/domain/assertions.test.ts`
- Modify: `artifacts/platform-api/src/domain/audit.ts`
- Modify: `artifacts/platform-api/src/domain/errors.ts`

**Interfaces:**
- Produces: `RegisteredOAuthClient { clientId, audience, redirectUris, clientSecretDigest }`.
- Produces: `AuthorizationService.issueCode`, `.exchangeCode`, `.introspect`.
- Produces: `PlatformAssertionSigner.sign` and `.publicJwks`.
- Consumes: current portal session, bound code repository, active entitlements, Ed25519 private JWK, and exact client registry.

- [ ] **Step 1: Write PKCE/replay/redirect/client RED tests**

```ts
it.each([
  ["verifier mismatch", { codeVerifier: "B".repeat(43) }],
  ["redirect mismatch", { redirectUri: "https://evil.example/callback" }],
  ["client mismatch", { clientId: "other-client" }],
])("rejects %s without consuming an observable second code", async (_name, override) => {
  await expect(service.exchangeCode({ ...validExchange, ...override }, validClientSecret))
    .rejects.toMatchObject({ code: "invalid_grant" });
});

it("allows one successful exchange and returns generic invalid_grant on replay", async () => {
  const first = await service.exchangeCode(validExchange, validClientSecret);
  expect(first.claims.entitlements).toContain("tf.search");
  await expect(service.exchangeCode(validExchange, validClientSecret))
    .rejects.toMatchObject({ code: "invalid_grant" });
});
```

Also test exact redirect allowlist, client secret digest timing-safe comparison, state digest binding, current portal session binding, active installation, active account, active module state, finite dates, assertion `iss/aud/sub/sid/jti/nonce/iat/nbf/exp`, key ID, overlapping public keys, and secret-free errors/audit.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --dir artifacts/platform-api test -- src/domain/oauth-clients.test.ts src/domain/authorization.test.ts src/domain/assertions.test.ts`

Expected: FAIL because the services are absent.

- [ ] **Step 3: Implement exact client registry and PKCE helpers**

```ts
export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export interface RegisteredOAuthClient {
  readonly clientId: string;
  readonly audience: string;
  readonly redirectUris: readonly string[];
  readonly clientSecretDigest: string;
}
```

Reject duplicate IDs, duplicate redirect URIs, non-HTTPS production redirects, non-SHA256 secret digests, unknown audiences, and unknown JSON keys during startup.

- [ ] **Step 4: Implement code issue/exchange and introspection**

```ts
issueCode(
  user: AuthenticatedUser,
  request: AuthorizationRequest,
  context: RequestContext,
): Promise<{ rawCode: string; redirectUri: string; state: string }>;

exchangeCode(
  request: AuthorizationCodeExchangeRequest,
  rawClientSecret: string,
  context: RequestContext,
): Promise<{ assertion: string; expiresIn: number; tokenType: "Bearer" }>;

introspect(
  request: PolicyIntrospectionRequest,
  rawClientSecret: string,
): Promise<PolicyIntrospectionResponse>;
```

Issue codes for 60 seconds and assertions for 5 minutes. `exchangeCode` locks the code, validates all bindings before consumption, consumes exactly once, and signs only the current effective entitlement keys. `introspect` verifies client audience, active Platform session/account/installation, and current entitlements.

- [ ] **Step 5: Implement Ed25519 assertion signing**

```ts
await new SignJWT(claims)
  .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
  .setIssuer(issuer)
  .setAudience(audience)
  .setSubject(accountId)
  .setIssuedAt(now)
  .setNotBefore(now - 5)
  .setExpirationTime(now + 300)
  .setJti(randomUUID())
  .sign(privateKey);
```

The signer accepts one active private JWK and a bounded public JWKS containing the active key plus optional overlap verification keys. Private key material must not be returned by `publicJwks()`.

- [ ] **Step 6: Run focused and live database tests**

Run: `pnpm --dir artifacts/platform-api test -- src/domain/oauth-clients.test.ts src/domain/authorization.test.ts src/domain/assertions.test.ts`

Expected: PASS.

Run with both test database URLs: `pnpm --dir artifacts/platform-api test -- src/domain/authorization.integration.test.ts`

Expected: PASS for code replay, concurrent exchange, account/session revocation, and current entitlement projection.

- [ ] **Step 7: Commit**

```bash
git add artifacts/platform-api/src/domain
git commit -m "feat(platform): issue and exchange PKCE codes"
```

### Task 5: Platform HTTP, Runtime Secrets, and Container Contract

**Files:**
- Create: `artifacts/platform-api/src/http/user-auth.ts`
- Create: `artifacts/platform-api/src/routes/user-sessions.ts`
- Create: `artifacts/platform-api/src/routes/oauth.ts`
- Modify: `artifacts/platform-api/src/routes/routes.test.ts`
- Modify: `artifacts/platform-api/src/app.ts`
- Modify: `artifacts/platform-api/src/index.ts`
- Modify: `artifacts/platform-api/src/runtime-config.ts`
- Modify: `artifacts/platform-api/src/index.smoke.test.ts`
- Modify: `artifacts/platform-api/src/logger.ts`
- Modify: `artifacts/platform-api/container/start-api.sh`
- Modify: `artifacts/platform-api/docker-compose.yml`
- Modify: `artifacts/platform-api/.env.example`

**Interfaces:**
- Produces HTTP endpoints `POST /v1/sessions`, `GET /v1/session`, `DELETE /v1/session`, `GET /v1/oauth/authorize`, `POST /v1/oauth/token`, `POST /v1/oauth/introspect`, and `GET /.well-known/jwks.json`.
- Produces cookie `__Host-apollo_portal` in production.
- Consumes: `UserSessionService`, `AuthorizationService`, exact origins, OAuth client registry, and file-backed signing/client registry secrets.

- [ ] **Step 1: Write route/runtime RED tests**

```ts
expect(response.headers.location).toBe(
  "https://api.tf.apollot.ru/api/auth/callback?code=issued-code&state=browser-state",
);
expect(response.headers["set-cookie"]).toContainEqual(
  expect.stringContaining("__Host-apollo_portal="),
);
expect(JSON.stringify(response.body)).not.toContain("clientSecret");
expect(JSON.stringify(response.body)).not.toContain("private");
```

Cover strict content types, Basic client authentication, generic OAuth errors, no-store headers, exact Origin/CSRF on session mutations, host-only cookies, JWKS public-only output, and logger redaction for `code`, `state`, `assertion`, cookies, and authorization headers.

- [ ] **Step 2: Run route/runtime tests and verify RED**

Run: `pnpm --dir artifacts/platform-api test -- src/routes/routes.test.ts src/index.smoke.test.ts`

Expected: FAIL because routes and required runtime settings are absent.

- [ ] **Step 3: Register routes and exact cookies**

`GET /v1/oauth/authorize` authenticates the portal cookie, validates the query with `authorizationRequestSchema`, issues a code, and returns `303` to the registered redirect. It must never redirect to an unregistered URI.

`POST /v1/oauth/token` and `/v1/oauth/introspect` accept client credentials only through HTTP Basic, parse bounded form/JSON bodies, and always return `Cache-Control: no-store`.

- [ ] **Step 4: Load secrets from files**

Add required production secret files:

```text
/run/secrets/platform_assertion_private_jwk
/run/secrets/platform_assertion_public_jwks
/run/secrets/platform_oauth_clients
```

`platform_oauth_clients` contains only client secret digests. Reject missing, empty, oversized, duplicate, or malformed files before listening. Keep development fixtures explicit and prohibited when `NODE_ENV=production`.

- [ ] **Step 5: Run tests, typecheck, build, and bundle checks**

Run: `pnpm --dir artifacts/platform-api test`

Expected: all default tests PASS with only environment-gated integrations skipped.

Run: `pnpm run typecheck`

Expected: PASS.

Run: `pnpm --dir artifacts/platform-api build`

Expected: PASS; every emitted bundle passes `node --check` and contains no `@workspace/` import.

- [ ] **Step 6: Commit**

```bash
git add artifacts/platform-api
git commit -m "feat(platform): expose secure OAuth endpoints"
```

### Task 6: TF Server-Side Session Bridge

**Files:**
- Create: `artifacts/api-server/src/lib/platform-auth-client.ts`
- Create: `artifacts/api-server/src/lib/platform-auth-client.test.ts`
- Create: `artifacts/api-server/src/lib/tf-session-store.ts`
- Create: `artifacts/api-server/src/lib/tf-session-store.test.ts`
- Create: `artifacts/api-server/src/routes/auth.ts`
- Create: `artifacts/api-server/src/routes/auth.test.ts`
- Modify: `artifacts/api-server/src/app.ts`
- Modify: `artifacts/api-server/src/routes/index.ts`
- Modify: `artifacts/api-server/src/types/session.d.ts`
- Modify: `artifacts/api-server/src/lib/logger.ts`
- Modify: `artifacts/api-server/.env.example`

**Interfaces:**
- Produces: `PlatformAuthClient.createAuthorizationUrl`, `.exchangeCode`, `.introspect`.
- Produces: `TfSessionStore.createTransaction`, `.consumeTransaction`, `.createSession`, `.getSession`, `.refreshSession`, `.revokeSession`, `.issueWebSocketTicket`, `.consumeWebSocketTicket`.
- Produces routes `/api/auth/start`, `/api/auth/callback`, `/api/auth/me`, `/api/auth/logout`.
- Consumes: Platform issuer/JWKS, confidential client secret file, strict Redis connection, and signed assertion claims.

- [ ] **Step 1: Write RED tests for state, nonce, cookie, and Redis failure**

```ts
it("rejects callback state mismatch before token exchange", async () => {
  const response = await request(app)
    .get("/api/auth/callback?code=code-value&state=wrong-state")
    .set("Cookie", transactionCookie);
  expect(response.status).toBe(400);
  expect(platform.exchangeCode).not.toHaveBeenCalled();
});

it("fails closed when the strict auth Redis store is unavailable", async () => {
  sessionStore.getSession.mockRejectedValue(new Error("redis unavailable"));
  const response = await request(app).get("/api/auth/me").set("Cookie", tfCookie);
  expect(response.status).toBe(503);
});
```

Cover one-time transaction consumption, PKCE verifier confinement to Redis, assertion signature/issuer/audience/nonce/time validation, unknown `kid`, TF session rotation, logout, generic callback errors, and secret-free logs.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --dir artifacts/api-server test -- src/lib/platform-auth-client.test.ts src/lib/tf-session-store.test.ts src/routes/auth.test.ts`

Expected: FAIL because bridge components are absent.

- [ ] **Step 3: Implement strict Redis stores**

```ts
export interface TfSession {
  readonly id: string;
  readonly accountId: string;
  readonly platformSessionId: string;
  readonly installationId: string;
  readonly entitlements: readonly string[];
  readonly assertionExpiresAt: string;
  readonly expiresAt: string;
}
```

Use opaque random cookie values and SHA-256 Redis keys. Store transactions for 5 minutes, TF sessions no longer than the backing Platform portal session, and WebSocket tickets for 30 seconds. `refreshSession` atomically replaces the entitlement snapshot and assertion expiry only after successful Platform introspection. Authentication storage never falls back to memory or PostgreSQL.

- [ ] **Step 4: Implement confidential code exchange and assertion verification**

Use `jose` `createRemoteJWKSet` with exact Platform JWKS URL, issuer, audience, algorithm `EdDSA`, clock tolerance 5 seconds, and a bounded HTTP timeout. Verify that the JWT nonce equals the consumed Redis transaction nonce before creating a TF session.

- [ ] **Step 5: Implement auth routes and cookies**

`/api/auth/start` generates state, verifier, S256 challenge, and nonce. It reuses a valid `__Host-apollo_tf_installation` UUID cookie or creates one, stores the transaction server-side, sets a transient `__Host-apollo_tf_tx` cookie, and redirects to Platform.

`/api/auth/callback` consumes the transaction and code once, creates `__Host-apollo_tf`, clears the transaction cookie, and redirects only to the configured `tf-web` origin.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `pnpm --dir artifacts/api-server test -- src/lib/platform-auth-client.test.ts src/lib/tf-session-store.test.ts src/routes/auth.test.ts`

Expected: PASS.

Run: `pnpm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add artifacts/api-server
git commit -m "feat(tf): create Platform-backed server sessions"
```

### Task 7: TF HTTP Capability Enforcement

**Files:**
- Create: `artifacts/api-server/src/lib/tf-policy.ts`
- Create: `artifacts/api-server/src/lib/tf-policy.test.ts`
- Create: `artifacts/api-server/src/routes/policy-coverage.test.ts`
- Modify: `artifacts/api-server/src/app.ts`
- Modify: `artifacts/api-server/src/routes/tracks.ts`
- Modify: `artifacts/api-server/src/routes/spotify.ts`
- Modify: `artifacts/api-server/src/routes/yandex.ts`
- Modify: `artifacts/api-server/src/types/session.d.ts`

**Interfaces:**
- Produces: `TF_ROUTE_POLICIES`, `requiredCapabilityForRequest`, and `requireTfCapability`.
- Produces request principal `req.tfPrincipal`.
- Consumes: TF session store and Platform introspection client.

- [ ] **Step 1: Write policy and route-coverage RED tests**

```ts
expect(requiredCapabilityForRequest("POST", "/api/tracks/search")).toBe("tf.search");
expect(requiredCapabilityForRequest("GET", "/api/tracks/id/download")).toBe("tf.downloads");
expect(requiredCapabilityForRequest("GET", "/api/spotify/status")).toBe("tf.integrations");

expect(() => assertProtectedRouteCoverage(discoveredRoutes, TF_ROUTE_POLICIES))
  .not.toThrow();
```

Add denial tests for absent session, missing/expired/revoked entitlement, suspended account, Platform failure on critical routes, direct endpoint calls without the UI, and a downloaded/stale client presenting arbitrary headers.

- [ ] **Step 2: Run policy tests and verify RED**

Run: `pnpm --dir artifacts/api-server test -- src/lib/tf-policy.test.ts src/routes/policy-coverage.test.ts`

Expected: FAIL because the policy map and middleware are absent.

- [ ] **Step 3: Implement exact route policies**

```ts
export const TF_ROUTE_POLICIES = Object.freeze([
  { method: "POST", pattern: /^\/api\/tracks\/search$/, capability: "tf.search", live: false },
  { method: "GET", pattern: /^\/api\/tracks\/[^/]+\/download$/, capability: "tf.downloads", live: true },
  { method: "POST", pattern: /^\/api\/tracks\/download\/queue$/, capability: "tf.downloads", live: true },
  { method: "GET", pattern: /^\/api\/spotify(?:\/|$)/, capability: "tf.integrations", live: true },
  { method: "POST", pattern: /^\/api\/yandex(?:\/|$)/, capability: "tf.integrations", live: true },
] as const);
```

Complete the map for every existing track, Spotify, and Yandex route. Health, auth, admin dashboard, and signed internal heartbeat routes remain outside end-user capability middleware.

- [ ] **Step 4: Enforce snapshot versus live policy**

Noncritical search/read metadata may use the unexpired assertion snapshot. When the assertion snapshot is expired or has less than 30 seconds remaining, middleware refreshes it through Platform introspection before allowing any protected route. Downloads, provider token mutations, provider library reads, and collection mutations call Platform introspection on every request. Successful introspection atomically refreshes the Redis session; failure returns sanitized `503 policy_unavailable`; missing capability returns `403 module_access_denied`.

- [ ] **Step 5: Run API regression and coverage tests**

Run: `pnpm --dir artifacts/api-server test`

Expected: all existing and new tests PASS, with only the existing opt-in Redis integration skip.

- [ ] **Step 6: Commit**

```bash
git add artifacts/api-server/src
git commit -m "feat(tf): enforce module entitlements on API routes"
```

### Task 8: One-Time WebSocket Tickets

**Files:**
- Create: `artifacts/api-server/src/routes/websocket-tickets.ts`
- Create: `artifacts/api-server/src/routes/websocket-tickets.test.ts`
- Modify: `artifacts/api-server/src/ws.ts`
- Create: `artifacts/api-server/src/ws.test.ts`
- Modify: `artifacts/api-server/src/index.ts`
- Modify: `artifacts/api-server/src/routes/index.ts`

**Interfaces:**
- Produces: `POST /api/ws/tickets`, requiring `tf.search`.
- Produces: `attachWebSocketServer(server, dependencies)` consuming one-time ticket validation.
- Removes: query-string `sessionId` authorization.
- Consumes: `TfSessionStore.consumeWebSocketTicket` and periodic session validation.

- [ ] **Step 1: Write RED tests proving `sessionId` no longer authorizes**

```ts
it("rejects legacy query-string session IDs", async () => {
  const result = await upgrade("/api/ws?sessionId=known-session");
  expect(result.statusCode).toBe(401);
});

it("accepts one ticket once and rejects replay", async () => {
  expect((await upgrade(`/api/ws?ticket=${ticket}`)).statusCode).toBe(101);
  expect((await upgrade(`/api/ws?ticket=${ticket}`)).statusCode).toBe(401);
});
```

- [ ] **Step 2: Run WebSocket tests and verify RED**

Run: `pnpm --dir artifacts/api-server test -- src/routes/websocket-tickets.test.ts src/ws.test.ts`

Expected: FAIL because the current server trusts `sessionId`.

- [ ] **Step 3: Implement ticket issuance and upgrade validation**

Tickets are 32-byte opaque random values, Redis-backed, single-use, account/session-bound, and expire after 30 seconds. Upgrade accepts only exact `/api/ws?ticket=...`; malformed paths, extra auth query parameters, replay, and unavailable Redis return `401` or `503` without revealing which check failed.

- [ ] **Step 4: Close connections when the backing session becomes invalid**

Every 30 seconds, validate the TF session and `tf.search` entitlement. Close with application code `4403` when revoked/expired and `1013` when policy storage is temporarily unavailable. Do not log ticket/session secrets.

- [ ] **Step 5: Run WebSocket and full TF API tests**

Run: `pnpm --dir artifacts/api-server test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add artifacts/api-server/src
git commit -m "feat(tf): replace websocket session IDs with tickets"
```

### Task 9: Local Container Bridge, Smoke, and Durable Status

**Files:**
- Create: `artifacts/platform-api/docker-compose.bridge.yml`
- Create: `artifacts/platform-api/scripts/bridge-smoke.mjs`
- Create: `artifacts/platform-api/src/bridge-e2e.test.ts`
- Modify: `artifacts/platform-api/Dockerfile`
- Modify: `artifacts/api-server/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `artifacts/api-server/docker-compose.yml`
- Modify: `artifacts/api-server/.env.example`
- Modify: `MODULES.md`
- Modify: `IMPLEMENTATION_STATUS.md`

**Interfaces:**
- Produces: a disposable Platform + TF bridge stack with separate PostgreSQL/Redis services and one-shot Platform migration.
- Produces: `pnpm --dir artifacts/platform-api bridge:smoke`.
- Consumes: file-backed Platform signing/client-registry secrets and TF confidential client secret.

- [ ] **Step 1: Write container contract RED tests**

```ts
expect(rendered.services["platform-postgres"].ports).toBeUndefined();
expect(rendered.services["platform-redis"].ports).toBeUndefined();
expect(rendered.services["tf-postgres"].ports).toBeUndefined();
expect(rendered.services["tf-redis"].ports).toBeUndefined();
expect(rendered.services["tf-api"].volumes ?? []).not.toContain("/var/run/docker.sock");
expect(rendered.services["tf-api"].environment).not.toHaveProperty("PLATFORM_ASSERTION_PRIVATE_JWK");
expect(rendered.services["platform-api"].environment).not.toHaveProperty("APOLLO_TF_CLIENT_SECRET");
```

Also assert loopback-only host bindings, separate networks/credentials, read-only secret mounts, health/readiness ordering, no broad host mounts, and no module public ports.

- [ ] **Step 2: Run bridge E2E test and verify RED**

Run: `pnpm --dir artifacts/platform-api test -- src/bridge-e2e.test.ts`

Expected: FAIL because `docker-compose.bridge.yml` and bridge smoke do not exist.

- [ ] **Step 3: Build the disposable bridge stack**

The stack contains Platform PostgreSQL/Redis/migrator/API and TF PostgreSQL/Redis/API. Search, integration, and download worker containers are not extracted until their own container-separation plan. Cross-boundary traffic is only TF API to Platform OAuth/JWKS/introspection endpoints. No host listener except loopback test ports.

- [ ] **Step 4: Implement full local smoke**

The smoke must prove:

1. closed/invite registration foundation remains operational;
2. active user portal login succeeds;
3. PKCE authorization redirects only to the exact TF callback;
4. code exchange succeeds once and replay fails generically;
5. TF session cookie grants `tf.search`;
6. direct download without `tf.downloads` returns `module_access_denied`;
7. granting `tf.downloads` makes a fresh live-introspection request pass authorization;
8. revocation immediately denies a critical route;
9. a WebSocket ticket is single-use and closes after session revocation;
10. logs/config/output contain none of the generated secret canaries or their digests.

- [ ] **Step 5: Document module placement and DNS/Caddy gate**

Update `MODULES.md` to state that future `tf-search`, `tf-integrations`, and `tf-download-worker` containers use authenticated internal API contracts and per-module heartbeat keys. They may run on another Coolify node if private routing or an owner-approved TLS route exists. They never receive Platform database credentials.

Record that no new public domain is required for this local stage. Before deployment, request the already documented public hosts and exact Caddy upstream targets; do not mutate Caddy automatically.

- [ ] **Step 6: Run full validation**

Run: `pnpm --dir lib/platform-contract test`

Expected: PASS.

Run with disposable PostgreSQL URLs: `pnpm --dir lib/platform-db test`

Expected: all tests PASS.

Run with disposable PostgreSQL URLs: `pnpm --dir artifacts/platform-api test`

Expected: all non-container tests PASS; only explicitly live-container tests may skip.

Run: `pnpm --dir artifacts/api-server test`

Expected: PASS with no new skips.

Run: `pnpm run typecheck`

Expected: PASS.

Run: `pnpm --dir artifacts/platform-api build`

Expected: PASS and exact bundle syntax/import scan PASS.

Run: `pnpm --dir artifacts/api-server build`

Expected: PASS.

Run: `pnpm --dir artifacts/platform-api bridge:smoke`

Expected: complete PKCE/grant/revoke/WebSocket flow PASS, followed by zero matching containers, networks, volumes, and temporary secret directories.

Run: `git diff --check`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add artifacts/platform-api artifacts/api-server docker-compose.yml MODULES.md IMPLEMENTATION_STATUS.md
git commit -m "feat(platform): validate the containerized TF auth bridge"
```

## Plan Self-Review

- Spec coverage: PKCE, redirect/state/nonce binding, one-time code exchange, signed assertions, server-side TF sessions, live entitlement denial, WebSocket tickets, secret isolation, container boundaries, DNS/Caddy approval gate, and local E2E are mapped to Tasks 1-9.
- Scope boundary: portal/admin visual implementation, provider-container extraction, TF database RLS migration, remote Coolify rollout, Caddy edits, DNS changes, and Android remain separate stages.
- Completion scan: no unfinished marker, vague implementation step, or undefined task dependency remains.
- Type consistency: contract names, service names, route names, cookie names, audiences, module keys, and repository methods are consistent across tasks.
