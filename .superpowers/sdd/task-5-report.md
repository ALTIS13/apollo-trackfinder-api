# Task 5 Report: Platform HTTP, Runtime Secrets, and Container Contract

## Status

DONE

- Worktree: `C:\Users\maksi\Desktop\Audio-Navigator\.worktrees\platform-pkce-tf-bridge`
- Branch: `codex/feat/platform-pkce-tf-bridge`
- Base/starting HEAD: `ddb4ff94337e82268d6ca0ef36f98b075e1b8e9c`
- Commit ownership: controller; the requested commit is created after this report is finalized.
- Scope remained Task 5 only. No Task 6 TF session/routes, UI, DNS, Caddy, Coolify, HomeNode, Android, remote infrastructure, or future module containers were changed.

## TDD Evidence

No production source was edited before the initial focused tests and RED runs.

### Initial RED: routes and HTTP security

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `1`; `1` file failed; `22` tests failed and `17` passed (`39` total).

Expected reasons:

- `/v1/sessions`, `/v1/session`, OAuth, and JWKS routes returned `404`.
- The JSON-only middleware rejected the required token form body (`400` instead of `200`).
- Strict Basic behavior, duplicate raw-header rejection, fatal UTF-8/canonical base64 checks, and generic `401 invalid_client` behavior were absent.
- `Pragma: no-cache`, Task 4 OAuth domain mappings, trusted issued-redirect construction, public JWKS, and required logger redaction were absent.

The first run using Vitest's default fork pool emitted one unexpected worker-exit error after six tests. The exact single-worker thread command above produced deterministic behavioral RED evidence; no failure was concealed.

### Initial RED: runtime secrets and pre-listen smoke

```text
pnpm --dir artifacts/platform-api exec vitest run src/index.smoke.test.ts --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `1`; `1` file failed; `14` tests failed and `2` passed (`16` total).

Expected reasons:

- Issuer, introspection binding, file-backed JWK/JWKS/client registry, and strict parsing properties were absent.
- Missing, unreadable, empty, oversized, malformed, duplicate-key, and unknown-key files were ignored.
- Production HTTP issuer/development redirect fixtures and an unregistered introspection client were accepted.
- A missing private-key file did not terminate startup before listen.

The existing valid bundle-layout and unavailable-readiness smoke cases passed.

### Initial RED: Compose secret scope

```text
pnpm --dir artifacts/platform-api exec vitest run src/e2e.test.ts -t "gates startup on migration and uses secret files without host mounts" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `1`; `1` focused test failed and `28` were skipped. Exact mismatch: `platform-api` had only its two old secret sources rather than the five-source list that includes `platform_assertion_private_jwk`, `platform_assertion_public_jwks`, and `platform_oauth_clients`.

### Additional logger RED/GREEN cycle

After the first full GREEN run, self-review added snake-case/general digest canaries:

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts -t "redacts OAuth, cookie, JWK, and client-secret fields" --reporter=verbose --pool=threads --maxWorkers=1
```

RED exit `1`: `client_secret_digest` remained visible. After adding the exact redaction aliases, the same command exited `0` with `1` passed and `38` skipped.

## Focused GREEN Evidence

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `0`; `39/39` passed.

```text
pnpm --dir artifacts/platform-api exec vitest run src/index.smoke.test.ts --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `0`; `16/16` passed.

```text
pnpm --dir artifacts/platform-api exec vitest run src/e2e.test.ts -t "gates startup on migration and uses secret files without host mounts" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `0`; `1` focused Compose contract test passed and `28` unrelated/live tests were skipped by the focus filter.

## Final Validation

### Full Platform tests

```text
pnpm --dir artifacts/platform-api test
```

Fresh final exit `0`: `17` files passed, `6` environment-gated files skipped; `360` tests passed, `20` environment-gated tests skipped (`380` total). No test failed.

### Workspace typecheck

```text
pnpm run typecheck
```

Fresh final exit `0`; library build plus all seven selected artifact/script typechecks completed.

### Production bundle

```text
pnpm --dir artifacts/platform-api build
```

Fresh final exit `0`.

Every emitted `.mjs` then passed `node --check`:

```text
syntax-ok index.mjs
syntax-ok migrate.mjs
syntax-ok policy-smoke.mjs
```

Byte/text scan result:

```text
bundle-scan-ok 3 files; no unresolved workspace imports or generated secret canaries
```

Patterns included unresolved `@workspace/` imports and the generated Task 5 secret canaries.

### Container build and Compose contract

- Full Platform tests exercised all local non-live Compose/container contract tests, including private PostgreSQL/Redis, loopback-only API publication, migration/readiness ordering, non-root/read-only runtime, no Docker socket/broad bind mounts, and exact secret ownership.
- Disposable runtime image command:

  ```text
  docker build --file artifacts/platform-api/Dockerfile --target runtime --tag apollo-platform-api:task5-validation .
  ```

  Exit `0`; the image built through the pinned pnpm install, bundle, production deploy, Argon2 native check, non-root runtime creation, and immutable `/app` permission step. The exact tag was deleted in the same PowerShell `finally` block.

### Diff hygiene

```text
git diff --check
```

Exit `0`.

## Cleanup Proof

- Route tests close every disposable HTTP server in `afterEach`.
- Runtime/smoke tests terminate every child process and recursively remove each generated JWK/client-secret fixture directory in `afterEach`.
- Compose-render helpers remove their secret directories in `finally`.
- The first timed-out RED Compose run left `C:\Users\maksi\AppData\Local\Temp\apollo-platform-contract-SAfcRE`; its resolved path and Task 5 prefix were validated, then it was removed.
- Final proof:

  ```text
  cleanup-proof containers=0 networks=0 volumes=0 imagePresent=False taskTempDirs=0 contractTempDirs=0
  ```

No disposable process, container, network, volume, image tag, or Task 5 temporary secret directory remains.

## Changed Files

- `.superpowers/sdd/task-5-report.md` — replaced stale unrelated content with this durable Task 5 report.
- `artifacts/platform-api/src/http/user-auth.ts` — portal cookie, authentication, fixed-length timing-safe CSRF, and clear helpers.
- `artifacts/platform-api/src/routes/user-sessions.ts` — login/current/logout HTTP contract and shared rate limiter.
- `artifacts/platform-api/src/routes/oauth.ts` — exact authorization query, strict raw-header Basic parser, token/introspection adapters, trusted redirect, and public JWKS.
- `artifacts/platform-api/src/routes/routes.test.ts` — focused HTTP/security RED/GREEN coverage.
- `artifacts/platform-api/src/app.ts` — bounded JSON/form parsers, no-store headers, and route registration.
- `artifacts/platform-api/src/index.ts` — pre-listen async runtime loading and domain-service/signer wiring.
- `artifacts/platform-api/src/runtime-config.ts` — 64 KiB file loader, fatal UTF-8, duplicate-aware strict JSON, environment/issuer/client/key validation.
- `artifacts/platform-api/src/index.smoke.test.ts` — runtime corruption, wrong-environment, pre-listen exit, and cleanup coverage.
- `artifacts/platform-api/src/logger.ts` — OAuth, cookie, JWK private field, raw-secret, and digest redaction.
- `artifacts/platform-api/src/http/errors.ts` — exhaustive existing plus Task 4 domain status mapping.
- `artifacts/platform-api/container/start-api.sh` — requires new file paths without reading or printing their contents.
- `artifacts/platform-api/docker-compose.yml` — API-only read-only secret mounts and path-only runtime settings.
- `artifacts/platform-api/.env.example` — issuer, introspection ID, and file-path examples only.
- `artifacts/platform-api/src/e2e.test.ts` — narrowly required exact Compose secret-list/ownership expectation update and deterministic timeout.

`build.mjs` required no change.

## Self-review

- Session mutation origin and CSRF checks occur before service mutation; CSRF tokens are exact 43-byte base64url values and use fixed-length `timingSafeEqual`.
- Portal cookies are `__Host-`, host-only, `Secure`, `SameSite=Lax`, `Path=/`; the session cookie is `HttpOnly`; clear operations preserve attributes and never set `Domain`.
- Pending portal users can inspect their portal session but receive `403 account_access_denied` before TF authorization-code issuance.
- Authorization parsing is duplicate/unknown/missing-field strict, and redirects are constructed only from `IssuedAuthorizationCode.redirectUri` with issued code/original state through `URL.searchParams`.
- Token/introspection Basic authentication counts case-insensitive occurrences in `request.rawHeaders`, requires one canonical padded base64 value, fatal UTF-8, colon, non-empty bounded ID/secret, and never accepts credentials from query/body.
- Token form and introspection JSON parsers are bounded and exact; token/introspection success and errors have `Cache-Control: no-store` plus `Pragma: no-cache`.
- OAuth error bodies serialize only stable codes/request IDs; messages, stacks, request bodies, code/state/verifier/nonce/cookies/authorization/assertion/key sources/client secrets are not returned or logged.
- JWKS comes only from `PlatformAssertionSigner.publicJwks()` with exact `public, max-age=300`; runtime key validation guarantees no `d`.
- Runtime files are absolute, regular, non-empty, at most 64 KiB, fatal UTF-8, duplicate-aware JSON, schema-strict, key-matched, digest-only registry content, and fully loaded before logger/pool/Redis/listener construction.
- Production issuer is an exact non-loopback HTTPS origin with no credentials/query/fragment; development HTTP is limited to exact loopback origins; registry environment rules and configured introspection-client membership fail closed.
- Compose preserves private data services, one-shot migrator, loopback API binding, health ordering, non-root/read-only runtime, and gives the three new secrets only to `platform-api`.
- No raw private JWK, client secret, secret digest, or full secret JSON was added to environment values, logs, startup output, smoke output, Compose interpolation, or the bundle.
- No out-of-scope infrastructure or product surface was touched.

## Concerns

None. The `20` skipped tests are the repository's existing environment-gated PostgreSQL/live-container integrations; all tests selected by the local Task 5 environment passed.

## Review Fix

### Regression RED evidence

The duplicate-key route tests were added before the HTTP parser fix:

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts -t "rejects duplicate raw JSON keys" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `1`; `1` file failed; `2` tests failed and `40` were skipped (`42` total). Both the raw duplicate session-login body and raw duplicate introspection body returned `200` instead of `400`, confirming that ordinary `JSON.parse` had collapsed the first key before Zod validation.

The four-level direct logger canary was also added before the logger fix:

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts -t "recursively redacts deeply nested logger fields" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `1`; `1` file failed; `1` test failed and `41` were skipped (`42` total). The emitted log contained `deep-raw-session-token-canary` and `deep-client-secret-canary` unchanged.

### Focused GREEN evidence

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts -t "rejects duplicate raw JSON keys" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `0`; `2` passed and `40` skipped (`42` total).

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts -t "recursively redacts deeply nested logger fields" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `0`; `1` passed and `41` skipped (`42` total).

```text
pnpm --dir artifacts/platform-api exec vitest run src/index.smoke.test.ts -t "runtime file" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `0`; `3` passed and `16` skipped (`19` total). The cases cover fatal invalid UTF-8 and malformed JSON in the public JWKS file plus an unknown key in the OAuth client-registry file.

### Final covering validation

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts --reporter=verbose --pool=threads --maxWorkers=1
```

Fresh final exit `0`; `1` file and `42/42` tests passed.

```text
pnpm --dir artifacts/platform-api exec vitest run src/index.smoke.test.ts --reporter=verbose --pool=threads --maxWorkers=1
```

Fresh final exit `0`; `1` file and `19/19` tests passed.

```text
pnpm --dir artifacts/platform-api typecheck
```

Fresh final exit `0`; `tsc -p tsconfig.json --noEmit` completed without diagnostics.

```text
git diff --check
pnpm exec prettier --check artifacts/platform-api/src/app.ts artifacts/platform-api/src/runtime-config.ts artifacts/platform-api/src/logger.ts artifacts/platform-api/src/routes/routes.test.ts artifacts/platform-api/src/index.smoke.test.ts
```

Both exited `0`; the five reviewed source/test files match Prettier formatting.

### Review-fix changed files

- `artifacts/platform-api/src/app.ts` — validates bounded raw UTF-8 JSON with the shared duplicate-aware scanner in Express's pre-parse `verify` hook and maps failures generically.
- `artifacts/platform-api/src/runtime-config.ts` — exports the existing scanner entry point for both runtime files and HTTP raw JSON; scanner logic was not copied and no dependency/file was added.
- `artifacts/platform-api/src/logger.ts` — recursively clones and sanitizes sensitive keys before Pino serialization, with array, cycle, depth/node-bound, accessor, and sanitizer-failure handling.
- `artifacts/platform-api/src/routes/routes.test.ts` — adds raw-wire duplicate login/introspection tests and a four-level logger canary covering raw session-token/client-secret aliases, arrays, cycles, and caller non-mutation.
- `artifacts/platform-api/src/index.smoke.test.ts` — adds focused public-JWKS and OAuth-registry corruption coverage.
- `.superpowers/sdd/task-5-report.md` — appends this review-fix evidence.

### Review-fix self-review

- Raw JSON is still bounded by Express's existing `16kb` limit; fatal decoding, malformed JSON, and duplicate keys all produce the existing generic validation response before any route service is called.
- Runtime secret parsing and HTTP parsing now share exactly one duplicate-aware scanner path; runtime schema and domain validation were not weakened or duplicated.
- Logger sanitization is case-insensitive by sensitive key, does not read a sensitive property's value, does not mutate caller objects, clones nested arrays/objects, replaces cycles, and fails closed under exceptional access or conservative depth/node limits. Existing Pino redaction remains as defense in depth.
- Scope is limited to the five Task 5 implementation/test files above plus this report. No Task 6, UI, DNS, Caddy, Coolify, HomeNode, Android, remote infrastructure, or unrelated file was changed.
- Commits remain `none`; controller-owned.

### Review-fix concerns

None.

## Second Review Fix

### Status

DONE. Only the three Important findings from the second independent review were addressed. No commit was created; the controller owns the commit.

### Regression RED evidence

The cryptographically inconsistent Ed25519 fixture tests were added before signer readiness was changed:

```text
pnpm --dir artifacts/platform-api exec vitest run src/index.smoke.test.ts -t "cryptographically inconsistent|exits nonzero before listening" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `1`; `1` file failed; `2` tests failed and `19` were skipped (`21` total), with `1` unhandled error. `parsePlatformRuntimeConfig()` resolved instead of rejecting, the bundled API emitted `"msg":"listening"` before exiting `1`, and Vitest captured the unhandled `DataError: Invalid keyData`.

The actual-Pino enumerable serialization-hook canary was added before logger sanitization was changed:

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts -t "makes enumerable serialization hooks inert" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `1`; `1` file failed; `1` test failed and `47` were skipped (`48` total). Pino invoked the enumerable `toJSON` hook once, allowing it to generate the deep client-secret canary after the recursive sanitizer had completed.

The raw-wire charset, content-encoding, and parameter-limit cases were added before body-parser error mapping was changed:

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts -t "unsupported charset|unsupported content encoding|excessive form parameters" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `1`; `1` file failed; `5` tests failed and `43` were skipped (`48` total). Both JSON routes returned `503` for unsupported charset and unsupported content encoding, and the nine-parameter form also returned `503` instead of preserving `413`.

### Small secure implementation

- `PlatformAssertionSigner.ready()` explicitly exposes private-key import readiness. The constructor attaches a rejection observer so legacy synchronous constructor callers cannot create an unhandled rejection, while `sign()` retains its Task 4 fail-closed behavior.
- Runtime parsing constructs a signer and awaits `ready()` inside the existing generic OAuth-secret error boundary. Startup constructs its runtime signer and awaits it before creating the logger, PostgreSQL pool, Redis client/readiness, or HTTP server.
- Recursive logging sanitization replaces every function-valued property, including enumerable `toJSON`, with the inert string `[Function]` before Pino receives the cloned object. Existing array, cycle, accessor, depth/node-bound, sanitizer-failure, and caller non-mutation behavior remains intact.
- Body-parser error types are mapped through two explicit allowlists. `entity.too.large`, `parameters.too.many`, and `querystring.parse.rangeError` return generic `413 payload_too_large`; unsupported charset/encoding, parse, verify, abort, and content-length mismatch failures return generic `400 validation_failed`. Messages, stacks, bodies, and parser internals are never reflected.

### Focused GREEN evidence

```text
pnpm --dir artifacts/platform-api exec vitest run src/index.smoke.test.ts -t "cryptographically inconsistent|exits nonzero before listening" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `0`; `2` passed and `19` skipped (`21` total). Runtime configuration rejects the key generically, and the bundled process exits `1` with only `Platform API startup failed` on stderr and no listening event.

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts -t "makes enumerable serialization hooks inert" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `0`; `1` passed and `47` skipped (`48` total). The hook was never invoked, neither canary reached output, functions became inert placeholders, and caller objects remained unchanged.

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts -t "unsupported charset|unsupported content encoding|excessive form parameters" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `0`; `5` passed and `43` skipped (`48` total). Four attacker-controlled unsupported charset/encoding cases return generic `400`, and excessive form parameters return generic `413`.

### Complete validation

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `0`; `1` file and `48/48` tests passed.

```text
pnpm --dir artifacts/platform-api exec vitest run src/index.smoke.test.ts --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `0`; `1` file and `21/21` tests passed. This suite rebuilt and exercised the production bundle, including valid listening/readiness and all pre-listen failure cases.

```text
pnpm --dir artifacts/platform-api test
```

Exit `0`; `17` files passed and `6` environment-gated files skipped; `374` tests passed and `20` environment-gated tests skipped (`394` total).

```text
pnpm --dir artifacts/platform-api typecheck
```

Final exit `0`; `tsc -p tsconfig.json --noEmit` completed without diagnostics. The first validation attempt exited `1` on a test-only inferred type that did not declare the deliberately injected `toJSON` property; adding the explicit optional test-fixture member resolved it without production changes.

```text
pnpm exec prettier --check artifacts/platform-api/src/domain/assertions.ts artifacts/platform-api/src/runtime-config.ts artifacts/platform-api/src/index.ts artifacts/platform-api/src/logger.ts artifacts/platform-api/src/http/errors.ts artifacts/platform-api/src/index.smoke.test.ts artifacts/platform-api/src/routes/routes.test.ts
git diff --check
```

Final exits were `0`; all seven reviewed source/test files match Prettier and the complete worktree diff has no whitespace errors. The first Prettier check identified only style changes in `domain/assertions.ts` and `http/errors.ts`; the repository formatter corrected them before the final checks.

### Second-review-fix changed files

- `artifacts/platform-api/src/domain/assertions.ts` — compatible awaitable key-import readiness and eager rejection observation.
- `artifacts/platform-api/src/runtime-config.ts` — awaits key usability inside the generic runtime-secret validation boundary.
- `artifacts/platform-api/src/index.ts` — awaits the runtime signer before logger, PostgreSQL, Redis, readiness, app, or listener creation.
- `artifacts/platform-api/src/logger.ts` — converts function values and serialization hooks to inert placeholders.
- `artifacts/platform-api/src/http/errors.ts` — explicit exhaustive body-parser client/payload error mappings.
- `artifacts/platform-api/src/index.smoke.test.ts` — generated inconsistent-key runtime and bundled pre-listen regressions.
- `artifacts/platform-api/src/routes/routes.test.ts` — actual logger-hook canary and raw-wire charset/encoding/parameter-limit regressions.
- `.superpowers/sdd/task-5-report.md` — this exact RED/GREEN evidence and self-review.

### Second-review-fix self-review

- The corrupt-key fixture uses two generated local Ed25519 pairs and is removed by the existing `afterEach`; no real key material is printed or persisted.
- A signer constructed by an existing synchronous caller remains immediately usable for `publicJwks()` and `sign()`. Invalid import material no longer creates an unhandled rejection; callers that need startup assurance can await `ready()`.
- The startup sequence creates no logger, pool, Redis object, readiness component, Express app, or listener until both runtime parsing and the actual runtime signer import have completed.
- The logger clone has a null prototype, does not execute getters or functions, neutralizes own serialization hooks, and preserves the prior redaction, cycle, array, depth/node-bound, and no-mutation guarantees.
- The parser mapping enumerates every body-parser 2.2 client error type used by the configured JSON/form middleware. Stream-state 500 errors remain fail-closed as `503`, while attacker-controlled 4xx failures are sanitized to `400` or `413` as required.
- Body size limits, parameter limits, strict JSON/form schemas, duplicate-key checks, and content-type selection were not weakened.
- No Task 6, TF session bridge, UI, DNS, Caddy, Coolify, HomeNode, Android, remote infrastructure, Compose, or unrelated file was changed by this fix.

### Second-review-fix concerns

The `20` skipped tests are the repository's existing environment-gated PostgreSQL/live-container integrations. All focused, complete Task 5 route/smoke, and locally runnable Platform tests passed.

## Final Review Fix

### Status

DONE. The final Important finding was fixed only in the existing local Platform smoke helper, its focused container-contract test, and this report. No commit was created; the controller owns the commit.

### Regression RED evidence

The focused helper test was updated first to require the exact seven-file set, matched valid Ed25519 private/public JWK material, and a valid digest-only development OAuth registry:

```text
pnpm --dir artifacts/platform-api exec vitest run src/e2e.test.ts -t "prepares Linux-readable secret files under a private host directory" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `1`; `1` test failed and `28` were skipped (`29` total). The exact failure showed that the helper produced only:

```text
platform_migrator_database_url
platform_operator_bootstrap_token
platform_runtime_database_url
platform_smoke_session_token
```

instead of the required exact seven-file set. The missing files were `platform_assertion_private_jwk`, `platform_assertion_public_jwks`, and `platform_oauth_clients`. The failed test removed its disposable secret directory in `finally`.

### Small secure implementation

- `prepareSecretDirectory()` generates a disposable local Ed25519 keypair, adds the exact `EdDSA`/`sig`/`kid` metadata required by the Task 5 signer schema, and writes matched private JWK and public JWKS JSON directly to the private secret directory.
- A 32-byte raw local OAuth client secret exists only in process. The file contains one valid development `apollo-tf-api` registry entry with only its SHA-256 digest and the loopback callback `http://127.0.0.1/callback`.
- The helper returns the private `d` and raw OAuth client secret only as in-process canaries. Both are added to the existing Compose-config, container-log, policy-output, public-projection, and tracked-file leak-scan paths; the existing scanner also searches for their SHA-256 digests.
- No private JWK JSON, raw client secret, registry digest/full JSON, or full secret content is placed in an environment variable or Compose interpolation, and no secret value is printed.
- All seven files retain the existing `0444` file mode under the private `0700` host directory where POSIX modes apply. Existing failure and final cleanup paths remain deterministic.

### Focused GREEN evidence

```text
pnpm --dir artifacts/platform-api exec vitest run src/e2e.test.ts -t "prepares Linux-readable secret files under a private host directory" --reporter=verbose --pool=threads --maxWorkers=1
```

Fresh final exit `0`; `1` test passed and `28` were skipped (`29` total). The test asserts the exact seven names, all legacy values, modes, exact Task 5 JWK/JWKS fields, a public key re-derived from the private JWK, the exact development registry, the digest recomputed from the in-process client-secret canary, and absence of that raw secret from the registry JSON.

### Compose and unit validation

```text
pnpm --dir artifacts/platform-api exec vitest run src/e2e.test.ts --reporter=verbose --pool=threads --maxWorkers=1
```

Fresh final exit `0`; `26` local container-contract tests passed and `3` live-container tests were skipped by their existing environment gate (`29` total). This includes Compose JSON rendering, exact Platform API secret ownership, private data services, loopback publication, migration/readiness ordering, fake-Docker lifecycle isolation, generated-secret preparation, raw/digest byte scanning, and cleanup behavior.

### Typecheck and hygiene

```text
pnpm --dir artifacts/platform-api typecheck
```

Final exit `0`; `tsc -p tsconfig.json --noEmit` completed without diagnostics.

```text
pnpm exec prettier --check artifacts/platform-api/scripts/smoke.mjs artifacts/platform-api/src/e2e.test.ts
```

Final exit `0`; both changed implementation/test files match Prettier.

```text
git diff --check
```

Final exit `0`; the complete worktree diff has no whitespace errors.

### Cleanup proof

The focused and complete suites removed every disposable directory in `finally`. Final read-only proof:

```text
apollo-platform-secrets-*=0
apollo-platform-contract-*=0
apollo-secret-scan-*=0
apollo-smoke-boundary-*=0
containers=0 networks=0 volumes=0
```

The Docker counts were filtered to the `apollo-platform-smoke` project-name prefix. The validation used Compose rendering and fake-Docker lifecycle tests; it created no live local stack.

### Final-review-fix changed files

- `artifacts/platform-api/scripts/smoke.mjs` — generated seven-file disposable secret fixture, in-process key/client-secret canaries, expanded leak-scan inputs, and unchanged deterministic cleanup.
- `artifacts/platform-api/src/e2e.test.ts` — exact seven-file, generated-key, digest-only registry, permissions, Compose, leak-scan, and cleanup regression coverage.
- `.superpowers/sdd/task-5-report.md` — this exact final review RED/GREEN evidence and self-review.

### Final-review-fix self-review

- Generated Ed25519 private/public values are matched before file creation; the focused test independently re-derives the public key from the private JWK.
- The private file has exactly `kty`, `crv`, `alg`, `use`, `kid`, `x`, and `d`; the public JWKS has one matching public-only key; the registry has one strict digest-only development client.
- The raw OAuth secret and private `d` never enter `environment`, Compose arguments, output, or tracked files. Their in-process canaries cover every existing smoke leak scan where fixture secrets are relevant.
- Secret files are written directly beneath the helper-owned temporary directory, changed to the existing container-readable mode, and recursively removed on preparation failure or smoke completion.
- Scope is limited to this local Task 5 smoke path and its test/report. No Task 6, TF session bridge, UI, DNS, Caddy, Coolify, HomeNode, Android, remote infrastructure, production deployment, or unrelated code was changed.

### Final-review-fix concerns

The `3` skipped tests require an already running live Compose project and are unchanged. The requested focused helper, Compose-render/unit, typecheck, formatting, diff, and cleanup checks all passed.

## Controller Final Verification

The controller reran every required check after all implementation and review-fix
edits were complete.

### Focused tests

```text
pnpm --dir artifacts/platform-api exec vitest run src/routes/routes.test.ts src/index.smoke.test.ts --reporter=dot --pool=threads --maxWorkers=1
```

Exit `0`; `2` files and `69/69` tests passed.

```text
pnpm --dir artifacts/platform-api exec vitest run src/e2e.test.ts -t "gates startup on migration and uses secret files without host mounts|prepares Linux-readable secret files under a private host directory" --reporter=verbose --pool=threads --maxWorkers=1
```

Exit `0`; both selected Compose ownership/fixture tests passed and `27`
unselected tests were skipped.

### Full tests and typecheck

```text
pnpm --dir artifacts/platform-api test
```

Exit `0`; `17` files passed and `6` environment-gated files skipped; `374`
tests passed and `20` environment-gated tests skipped (`394` total).

```text
pnpm run typecheck
```

Exit `0`; the library build and all seven selected artifact/script typechecks
completed without diagnostics.

### Build and bundle checks

```text
pnpm --dir artifacts/platform-api build
```

Exit `0`. Every emitted bundle then passed `node --check`:

```text
syntax-ok index.mjs
syntax-ok migrate.mjs
syntax-ok policy-smoke.mjs
bundle-import-scan-ok 3 files; no unresolved @workspace imports
bundle-canary-scan-ok 3 files; no Task 5 secret canaries
```

The canary scan included runtime-file, private-key/client-secret, nested logger,
serialization-hook, session-token, and test-key canaries.

### Compose and container checks

A direct `docker compose --profile smoke config --format json` render used a
fresh generated seven-file fixture and passed exact ownership checks:

```text
compose-config-ok apiSecrets=5 secretFiles=7
```

A disposable runtime image built successfully through the pinned install,
bundle, production deploy, native Argon2 check, non-root runtime, and immutable
`/app` steps. Its unique `apollo-platform-api:task5-final-*` tag was removed and
confirmed absent.

The real local smoke then passed with a separate unique image tag:

```text
Platform smoke passed: closed, bootstrap, login, invite, verify, grant, activate, allow, revoke, deny
platform-local-smoke-image-cleanup-ok
```

The smoke's Compose `finally` path removed its containers, network, volumes, and
secret directory. The controller removed and confirmed absence of the unique
smoke image tag.

### Final cleanup and hygiene

```text
cleanup-proof containers=0 networks=0 volumes=0 images=0 tempDirs=0
```

The proof checked `apollo-platform-smoke-*` Compose resources,
`apollo-platform-api:task5-*` images, and all Task 5/runtime/Compose/smoke
temporary directory prefixes.

```text
git diff --check
```

Exit `0`.

### Controller concerns

None. The `20` full-suite skips are the repository's existing
environment-gated PostgreSQL/live-container tests. The separate real local
Compose smoke passed and cleaned up completely.
