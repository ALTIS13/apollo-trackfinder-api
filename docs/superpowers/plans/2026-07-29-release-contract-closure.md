# Release Contract Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two remaining production-release blockers by binding every rendered service environment to its exact contract and making the Caddy/nginx credential equality gate executable with the intentionally newline-free htpasswd record.

**Architecture:** Extend the existing release validator with one exact, redacted, per-service environment contract derived from the already validated release environment. Replace the fragile inline operator comparison with a small POSIX script that consumes the two protected generated files, then execute that script in the existing credential contract suite. After both fixes are reviewed, rebuild the local production proof from the exact code checkpoint and update only tracked evidence documents after that checkpoint.

**Tech Stack:** TypeScript 5.9, Vitest, Docker Compose JSON, POSIX `sh`, pnpm 10, Docker Buildx.

## Global Constraints

- The branch starts from `4b1efb86007b80f9cb4dbd59c2b295bef0665881`; `main` and `origin/main` remain unchanged until the complete branch passes independent review.
- Use strict TDD: every behavior change starts with a focused failing test, then the smallest implementation, then focused and broad validation.
- Production validation must compare the complete rendered `environment` map for every expected service, including services whose exact map is empty.
- Dynamic runtime values must be derived only from the already validated release environment; do not duplicate operator-supplied origins, versions, or deployment timestamps as unrelated literals.
- A runtime environment mismatch emits only `environment_contract` plus stack, service, and field identifiers. Never return, log, snapshot, or interpolate the rejected value.
- The checked-in `deploy/coolify/release.env.example` remains intentionally non-deployable and fail-closed.
- `admin_access_htpasswd` remains exactly one `username:bcrypt` record without a trailing LF. The verifier must tolerate the expected EOF status, reject malformed input, compare both generated outputs, and print no credential material.
- Tests must execute the same tracked credential verifier that the rollout runbook invokes; a prose-only or source-string assertion is insufficient.
- No workflow dispatch, GHCR publication, HomeNode/Coolify/Caddy/UFW mutation, retained-volume access, broad Docker prune, or adoption of `DETACHED_UNKNOWN` data is allowed.
- Docker proof cleanup may remove only resources whose exact ownership was established by the proof. Final owned container, network, volume, image, Buildx, temporary-directory, and registry inventories must be zero.
- The final local image-source checkpoint contains all executable code and test changes. Commits after it may change only evidence/status documentation.

---

### Task 1: Exact rendered service environment contract

**Files:**

- Modify: `scripts/src/coolify-release.ts`
- Modify: `scripts/src/coolify-release.test.ts`

**Interfaces:**

- Consumes: `ReleaseValidationInput.environment`, every expected rendered Compose service, and the existing `expectedSecretFileEnvironment`.
- Produces: `expectedEnvironmentForService(serviceName, releaseEnvironment)` and redacted `environment_contract` validation errors.

- [ ] **Step 1: Expand the exact input fixture**

  Add `exactPlainEnvironment(releaseEnvironment)` in
  `scripts/src/coolify-release.test.ts`. `serviceFixture` must combine its
  service entry with `exactSecretFileEnvironment`. The exact maps are:

  ```text
  platform-postgres:
    POSTGRES_DB=apollo_platform
    POSTGRES_USER=postgres
  platform-redis: empty
  platform-migrate: empty
  platform-api:
    APOLLO_ALLOWED_ORIGINS=<PLATFORM_ALLOWED_ORIGINS>
    APOLLO_API_VERSION=<PLATFORM_API_VERSION>
    APOLLO_DEPLOYED_AT=<PLATFORM_DEPLOYED_AT>
    APOLLO_DEVELOPMENT_TOKEN_ECHO=false
    APOLLO_INTROSPECTION_CLIENT_ID=apollo-tf-api
    APOLLO_ISSUER=<PLATFORM_PUBLIC_ORIGIN>
    APOLLO_REDIS_URL=redis://platform-redis:6379
    APOLLO_TRUST_PROXY_HOPS=1
    NODE_ENV=production
    PORT=8080
  tf-postgres:
    POSTGRES_DB=apollo_trackfinder
    POSTGRES_USER=postgres
  tf-role-bootstrap: empty
  tf-migrate: empty
  tf-baseline: empty
  tf-redis: empty
  tf-integrations-postgres:
    POSTGRES_DB=apollo_tf_integrations
    POSTGRES_USER=postgres
  tf-integrations-migrate: empty
  tf-integrations:
    APOLLO_API_VERSION=<TF_INTEGRATIONS_VERSION>
    APOLLO_DEPLOYED_AT=<TF_INTEGRATIONS_DEPLOYED_AT>
    NODE_ENV=production
    PORT=8080
    TF_INTEGRATIONS_HEARTBEAT_ALLOW_INSECURE_HTTP=true
    TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN=http://tf-api:8080
    TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI=<TF_API_PUBLIC_ORIGIN>/api/spotify/callback
  tf-search:
    APOLLO_API_VERSION=<TF_SEARCH_VERSION>
    APOLLO_DEPLOYED_AT=<TF_SEARCH_DEPLOYED_AT>
    NODE_ENV=production
    PORT=8080
    TF_SEARCH_HEARTBEAT_ALLOW_INSECURE_HTTP=true
    TF_SEARCH_HEARTBEAT_API_ORIGIN=http://tf-api:8080
  tf-download-redis: empty
  tf-download-worker:
    APOLLO_API_VERSION=<TF_DOWNLOAD_VERSION>
    APOLLO_DEPLOYED_AT=<TF_DOWNLOAD_DEPLOYED_AT>
    NODE_ENV=production
    PORT=8080
    TF_DOWNLOAD_HEARTBEAT_ALLOW_INSECURE_HTTP=true
    TF_DOWNLOAD_HEARTBEAT_API_ORIGIN=http://tf-api:8080
    TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS=true
    TF_DOWNLOAD_STORAGE_ROOT=/var/lib/apollo-tf/downloads
  tf-api:
    APOLLO_API_VERSION=<TF_API_VERSION>
    APOLLO_DEPLOYED_AT=<TF_DEPLOYED_AT>
    APOLLO_PLATFORM_API_ORIGIN=http://platform-api:8080
    APOLLO_PLATFORM_ISSUER=<PLATFORM_PUBLIC_ORIGIN>
    APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP=true
    APOLLO_TF_AUTH_REDIS_URL=redis://tf-redis:6379/1
    APOLLO_TF_CALLBACK_URL=<TF_API_PUBLIC_ORIGIN>/api/auth/callback
    APOLLO_TF_CLIENT_ID=apollo-tf-api
    APOLLO_TF_WEB_ORIGIN=<TF_PUBLIC_ORIGIN>
    NODE_ENV=production
    PORT=8080
    REDIS_URL=redis://tf-redis:6379/0
    SERVER_URL=<TF_API_PUBLIC_ORIGIN>
    TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS=true
    TF_DOWNLOAD_WORKER_ALLOW_INSECURE_HTTP=true
    TF_DOWNLOAD_WORKER_ORIGIN=http://tf-download-worker:8080
    TF_INTEGRATIONS_ALLOW_INSECURE_HTTP=true
    TF_INTEGRATIONS_ORIGIN=http://tf-integrations:8080
    TF_SEARCH_ALLOW_INSECURE_HTTP=true
    TF_SEARCH_ORIGIN=http://tf-search:8080
    WEB_URL=<TF_PUBLIC_ORIGIN>
  tf-web: empty
  tf-admin:
    APOLLO_API_UPSTREAM=http://tf-api:8080
  ```

  Every `_FILE` entry stays in `exactSecretFileEnvironment`; the final map is
  the union of the plain and `_FILE` maps.

- [ ] **Step 2: Write hostile failing tests**

  Add a table-driven test that independently mutates each relationship below
  and expects `environment_contract`:

  ```text
  platform-api.APOLLO_ISSUER
  platform-api.APOLLO_ALLOWED_ORIGINS
  platform-api.NODE_ENV
  tf-integrations.TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN
  tf-integrations.TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI
  tf-search.TF_SEARCH_HEARTBEAT_ALLOW_INSECURE_HTTP
  tf-download-worker.TF_DOWNLOAD_HEARTBEAT_API_ORIGIN
  tf-api.APOLLO_PLATFORM_API_ORIGIN
  tf-api.APOLLO_PLATFORM_ISSUER
  tf-api.APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP
  tf-api.APOLLO_TF_CALLBACK_URL
  tf-api.SERVER_URL
  tf-api.WEB_URL
  tf-api.TF_DOWNLOAD_WORKER_ORIGIN
  tf-api.TF_INTEGRATIONS_ORIGIN
  tf-api.TF_SEARCH_ORIGIN
  tf-admin.APOLLO_API_UPSTREAM
  ```

  Add separate missing-key and unexpected-key cases. Assert that serialized
  errors contain neither the hostile value nor any expected origin.

- [ ] **Step 3: Run the focused test to verify RED**

  ```powershell
  pnpm --filter @workspace/scripts exec vitest run src/coolify-release.test.ts
  ```

  Expected: the hostile cases fail because current validation still returns
  `ok: true` for non-secret environment drift.

- [ ] **Step 4: Implement the exact contract**

  In `scripts/src/coolify-release.ts`, add a resolver with the same maps from
  Step 1:

  ```ts
  type RuntimeEnvironment = Readonly<Record<string, string>>;
  type RuntimeEnvironmentResolver = (
    releaseEnvironment: Readonly<Record<string, string>>,
  ) => RuntimeEnvironment;

  const expectedPlainEnvironment: Readonly<
    Record<string, RuntimeEnvironmentResolver>
  > = {
    // One resolver for every expected service, including () => ({}) entries.
  };

  function expectedEnvironmentForService(
    serviceName: string,
    releaseEnvironment: Readonly<Record<string, string>>,
  ): RuntimeEnvironment {
    return {
      ...(expectedSecretFileEnvironment[serviceName] ?? {}),
      ...(expectedPlainEnvironment[serviceName]?.(releaseEnvironment) ?? {}),
    };
  }
  ```

  Pass `input.environment` into `validateEnvironment`. Compare sorted key/value
  pairs from the rendered service map with the exact expected map. On any
  missing key, unexpected key, or unequal value, add exactly one:

  ```ts
  addError(errors, "environment_contract", {
    ...context,
    field: "environment",
  });
  ```

  Keep the existing secret-file mount check and secret-value defense in depth.

- [ ] **Step 5: Run focused and scripts validation**

  ```powershell
  pnpm --filter @workspace/scripts exec vitest run src/coolify-release.test.ts
  pnpm --filter @workspace/scripts test
  pnpm --filter @workspace/scripts typecheck
  git diff --check
  ```

  Expected: all commands exit `0`; hostile mutations fail closed only inside
  their assertions and no rejected value appears in validator output.

- [ ] **Step 6: Commit**

  ```powershell
  git add scripts/src/coolify-release.ts scripts/src/coolify-release.test.ts
  git commit -m "fix(release): bind rendered service environments"
  ```

---

### Task 2: Executable newline-free admin credential gate

**Files:**

- Create: `deploy/caddy/verify-admin-credentials.sh`
- Modify: `scripts/src/caddy-release-contract.test.ts`
- Modify: `docs/operations/apollo-production-rollout.md`

**Interfaces:**

- Consumes: generated `admin_access_htpasswd` and `caddy.env` paths.
- Produces: a silent exit-`0` equality gate used verbatim by the rollout runbook.

- [ ] **Step 1: Write the failing verifier contract**

  Extend the existing credential-generation test to execute:

  ```text
  deploy/caddy/verify-admin-credentials.sh
    <generation>/admin_access_htpasswd
    <generation>/caddy.env
  ```

  Require exit `0`, empty stdout, and empty stderr for generator output.
  Add hostile cases for an empty htpasswd file, an LF-terminated htpasswd
  record, a mismatched Caddy username, and a mismatched Caddy hash. Every
  hostile case must exit non-zero without returning the username, hash, or
  password. Require the rollout document to invoke this exact tracked script.

- [ ] **Step 2: Run the focused test to verify RED**

  ```powershell
  pnpm --filter @workspace/scripts exec vitest run src/caddy-release-contract.test.ts
  ```

  Expected: FAIL because the tracked verifier does not exist and the runbook
  still uses plain `read` under `sh -e`.

- [ ] **Step 3: Implement the POSIX verifier**

  Create `deploy/caddy/verify-admin-credentials.sh` with this behavior:

  ```sh
  #!/bin/sh
  set -eu

  [ "$#" -eq 2 ] || exit 64
  htpasswd_file=$1
  caddy_environment_file=$2
  [ -f "$htpasswd_file" ] && [ -f "$caddy_environment_file" ] || exit 1
  [ "$(wc -l < "$htpasswd_file")" -eq 0 ] || exit 1

  nginx_user=
  nginx_hash=
  if IFS=: read -r nginx_user nginx_hash < "$htpasswd_file"; then
    exit 1
  fi
  [ -n "$nginx_user" ] && [ -n "$nginx_hash" ] || exit 1
  case "$nginx_hash" in *:*) exit 1 ;; esac

  unset APOLLO_ADMIN_CADDY_USER APOLLO_ADMIN_CADDY_PASSWORD_HASH
  set -a
  . "$caddy_environment_file"
  set +a
  [ "${APOLLO_ADMIN_CADDY_USER+x}" = x ]
  [ "${APOLLO_ADMIN_CADDY_PASSWORD_HASH+x}" = x ]
  [ "$nginx_user" = "$APOLLO_ADMIN_CADDY_USER" ]
  [ "$nginx_hash" = "$APOLLO_ADMIN_CADDY_PASSWORD_HASH" ]
  ```

  The script must not enable tracing or print credential values. Update the
  rollout command to call the script through `sudo` with only the two protected
  file paths as arguments.

- [ ] **Step 4: Run focused and shell validation**

  ```powershell
  pnpm --filter @workspace/scripts exec vitest run src/caddy-release-contract.test.ts
  & 'C:\Program Files\Git\bin\bash.exe' -n deploy/caddy/verify-admin-credentials.sh
  pnpm --filter @workspace/scripts test
  pnpm --filter @workspace/scripts typecheck
  git diff --check
  ```

  Expected: all commands exit `0`; the exact generated newline-free record
  passes and each independent mismatch fails silently.

- [ ] **Step 5: Commit**

  ```powershell
  git add deploy/caddy/verify-admin-credentials.sh `
    scripts/src/caddy-release-contract.test.ts `
    docs/operations/apollo-production-rollout.md
  git commit -m "fix(ops): verify generated admin credentials"
  ```

---

### Task 3: Rebind exact local release evidence

**Files:**

- Modify: `docs/operations/apollo-production-rollout.md`
- Modify: `docs/operations/apollo-backup-restore.md`
- Modify: `docs/operations/homenode-coolify-preflight.md`
- Modify: `IMPLEMENTATION_STATUS.md`

**Interfaces:**

- Consumes: reviewed Task 1 and Task 2 commits and the existing disposable production proof.
- Produces: one exact local image-source SHA and a docs-only evidence tail.

- [ ] **Step 1: Establish the image-source checkpoint**

  Require a clean tracked tree after Tasks 1 and 2. Record:

  ```powershell
  $imageSource = git rev-parse HEAD
  git status --porcelain=v1
  ```

  Expected: status output is empty. No executable, Compose, workflow, test, or
  script file may change after `$imageSource` is recorded.

- [ ] **Step 2: Run the complete non-Docker release validation**

  ```powershell
  pnpm --filter @workspace/api-server test
  pnpm --filter @workspace/platform-api exec vitest run src --maxWorkers=2
  pnpm --filter @workspace/tf-search test
  pnpm --filter @workspace/tf-integrations exec vitest run src --maxWorkers=2
  pnpm --filter @workspace/tf-download-worker test
  pnpm --filter @workspace/admin-dashboard test
  pnpm --filter @workspace/scripts test
  pnpm run typecheck
  git diff --check
  ```

  Run the checked-in placeholder validation and require only its documented
  fail-closed categories; it must not produce `environment_contract`:

  ```powershell
  pnpm release:validate -- --env-file deploy/coolify/release.env.example
  ```

- [ ] **Step 3: Run exact disposable Docker proofs**

  Run the existing opt-in PostgreSQL 16 and PostgreSQL 17 encrypted
  backup/restore proofs, native-Linux shared-token proof, pinned Caddy proof,
  and `APOLLO_RUN_COOLIFY_PRODUCTION_SMOKE=1` production smoke from
  `$imageSource`. Use their existing task-owned identifiers and cleanup
  contracts. The temporary release env must carry:

  ```text
  RELEASE_SOURCE_COMMIT=<imageSource>
  image sourceCommit=<imageSource>
  every custom image=<task registry repository>@sha256:<64 lowercase hex>
  ```

  Require the production validator to accept both rendered stacks before they
  start and require exact final owned-resource inventories of zero.

- [ ] **Step 4: Update docs-only evidence**

  Replace the prior image-source SHA in the four files with `$imageSource`.
  Record that the environment contract hostile matrix and the exact newline-free
  credential verifier passed. Keep status `LOCAL_RELEASE_VALIDATED`; explicitly
  state that no workflow, registry publication, retained-volume access, or
  remote mutation occurred.

- [ ] **Step 5: Prove the tail is documentation-only**

  ```powershell
  git diff --check
  git diff --name-only $imageSource
  ```

  Expected exact set:

  ```text
  IMPLEMENTATION_STATUS.md
  docs/operations/apollo-backup-restore.md
  docs/operations/apollo-production-rollout.md
  docs/operations/homenode-coolify-preflight.md
  ```

- [ ] **Step 6: Commit**

  ```powershell
  git add IMPLEMENTATION_STATUS.md `
    docs/operations/apollo-backup-restore.md `
    docs/operations/apollo-production-rollout.md `
    docs/operations/homenode-coolify-preflight.md
  git commit -m "docs(release): record closed release gates"
  ```

---

## Plan Self-Review

- Spec coverage: Task 1 closes the original I-6 unsafe rendered-environment drift; Task 2 closes N-I-1 using the exact tracked command; Task 3 rebinds the package to the corrected source.
- Scope: no completed release-package feature, client UI, Android work, infrastructure resource, domain, database policy, or module container is rebuilt.
- Placeholder scan: every implementation and validation step has exact files, behavior, commands, and expected outcomes.
- Type consistency: both fixture and validator use complete per-service `Record<string, string>` maps derived from the same release-environment names.
- Security: validation errors and credential checks remain silent and redacted; no secret content enters argv, logs, snapshots, tracked files, or reports.
- Provenance: all executable changes precede the exact image-source SHA, and the tail after that SHA is restricted to four evidence/status documents.
