# Apollo Coolify Production Release Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a locally validated, production-only Apollo Platform and
Apollo TF release package that Coolify can deploy as two independent Raw Docker
Compose resources after a separate owner approval.

**Architecture:** Keep the existing local Compose files as development and
integration fixtures. Add two production manifests under `deploy/coolify/`
that contain no builds, accept only digest-pinned images, publish only four
mandatory loopback ports, and consume file-backed secrets. A release validator,
backup/restore tools, Caddy include, and disposable native-Linux smoke make the
operator contract executable without touching HomeNode.

**Tech Stack:** Docker Engine/Compose, Coolify Raw Docker Compose, Caddy 2.10,
PostgreSQL 16, Redis 7, Node.js 20/22, TypeScript, Vitest, YAML, POSIX shell,
GitHub Actions/GHCR, age encryption.

## Global Constraints

- This plan is local-only. It must not create or change a HomeNode file,
  container, volume, route, service, Caddy configuration, UFW rule, DNS record,
  Coolify resource, migration, or backup directory.
- Remote mutation remains approval-gated immediately before execution.
- Preserve Caddy as the only public owner of host TCP `80/443`; do not add
  Traefik/Coolify domain labels.
- Deploy exactly two independently rollbackable Raw Compose resources:
  `apollo-platform` and `apollo-tf`.
- Production manifests contain no `build` key and no development image or port
  default.
- Every image reference is mandatory and must match
  `name@sha256:<64 lowercase hex characters>`.
- Candidate host ports are Platform API `18200`, TF API `18201`, TF web
  `18202`, and admin `18203`; manifests require explicit values and bind each
  only to `127.0.0.1`.
- PostgreSQL, Redis, migrations, search, integrations, and download services
  publish no host ports.
- Runtime credentials enter Compose as file-backed secrets only. Public origins,
  version identifiers, timestamps, image references, and loopback ports are
  non-secret configuration.
- Platform and TF use separate networks, databases, Redis instances,
  credentials, volumes, migration jobs, and rollback records.
- The first rollout uses fresh explicitly named volumes. The existing
  unidentified legacy PostgreSQL volume remains detached, unmodified, unnamed
  in tracked files, and excluded from automatic adoption or cleanup.
- Apollo TF PostgreSQL is a dedicated cluster. Never run TF role bootstrap
  against a shared PostgreSQL server.
- `apollot.ru`, `www.apollot.ru`, and `quasar.apollot.ru` remain outside the
  first route include. This slice publishes only `api.apollot.ru`,
  `api.tf.apollot.ru`, `tf.apollot.ru`, and `admin.apollot.ru`.
- Admin uses both the application Basic Auth boundary and the existing exact
  API dashboard-token boundary; browser code receives neither secret.
- Each long-running service has health/readiness, CPU, memory, PID,
  `stop_grace_period`, and bounded `json-file` logging.
- Backup output is encrypted with age before it reaches the destination,
  includes a SHA-256 sidecar and metadata, and is accepted only after a
  disposable restore proof.
- No command logs, test matcher diff, manifest, workflow artifact, or tracked
  document may contain a generated secret, private key, password, token,
  database URL, or raw operator path.
- Android remains out of scope until the web/server release works.
- Use TDD for every behavior change: add the failing test, record the expected
  RED, implement the minimum change, and rerun the focused and affected suites.
- Commit each task only after its task review is clean.

---

### Task 1: File-backed admin boundary and TF web health

**Files:**

- Create: `artifacts/api-server/src/lib/admin-dashboard-token.ts`
- Create: `artifacts/api-server/src/lib/admin-dashboard-token.test.ts`
- Modify: `artifacts/api-server/src/routes/admin.ts`
- Modify: `artifacts/api-server/src/routes/admin.test.ts`
- Modify:
  `artifacts/admin-dashboard/docker-entrypoint.d/16-admin-dashboard-defaults.envsh`
- Modify: `artifacts/admin-dashboard/src/config-contract.test.ts`
- Modify: `artifacts/music-player/Dockerfile`
- Modify: `artifacts/api-server/src/deployment-contract.test.ts`

**Interfaces:**

- Consumes: `ADMIN_DASHBOARD_TOKEN_FILE`,
  `ADMIN_ACCESS_USER_FILE`, and `ADMIN_ACCESS_PASSWORD_FILE`.
- Produces:
  `loadAdminDashboardToken(environment, readFile): string | undefined`,
  file-backed nginx Basic Auth setup, and `GET /healthz` in the TF web image.

- [ ] **Step 1: Add failing API secret-loader tests**

  Add tests proving that the loader:
  - returns `undefined` when no file is configured;
  - reads only `ADMIN_DASHBOARD_TOKEN_FILE`;
  - trims one trailing newline;
  - rejects empty, non-regular, unreadable, larger-than-4-KiB, shorter-than-32,
    or dual file/environment configuration;
  - never includes the path or secret in the thrown message.

  Run:

  ```powershell
  pnpm --filter @workspace/api-server test -- src/lib/admin-dashboard-token.test.ts
  ```

  Expected RED: the module does not exist.

- [ ] **Step 2: Implement the bounded API secret loader**

  Implement a synchronous startup-only loader with injectable file operations.
  `createAdminRouter()` must resolve its default token through that loader.
  Explicit `options.token` remains available to unit tests. Production must
  reject `ADMIN_DASHBOARD_TOKEN` when the file variable is present.

- [ ] **Step 3: Add failing admin-container file contract tests**

  Replace assertions for raw `ADMIN_*` values with these exact paths:

  ```text
  /run/secrets/admin_dashboard_token
  /run/secrets/admin_access_user
  /run/secrets/admin_access_password
  ```

  Assert length limits, username character validation, `umask 077`, no secret
  output, disabled auth on malformed input, mode `0640` for `.htpasswd`, and
  removal of temporary shell variables.

  Run:

  ```powershell
  pnpm --filter @workspace/admin-dashboard test -- src/config-contract.test.ts
  ```

  Expected RED: the entrypoint still reads environment values.

- [ ] **Step 4: Implement the admin file readers**

  Use a single shell helper that accepts path, minimum bytes, and maximum bytes.
  The dashboard token is `32..4096` bytes, username `1..128`, and password
  `16..4096`. Read only regular readable files. Export the token only for nginx
  template rendering; never print it. Generate `.htpasswd` from file content.

- [ ] **Step 5: Add and satisfy the TF web health contract**

  Add a test requiring the runtime image to:
  - serve exact `200 text/plain` body `ok\n` at `/healthz`;
  - define a Docker `HEALTHCHECK`;
  - keep SPA fallback behavior for every other path.

  Implement the nginx location and healthcheck, then run:

  ```powershell
  pnpm --filter @workspace/api-server test -- src/deployment-contract.test.ts
  pnpm --filter @workspace/admin-dashboard test
  pnpm --filter @workspace/api-server test
  ```

- [ ] **Step 6: Commit**

  ```powershell
  git add artifacts/api-server artifacts/admin-dashboard artifacts/music-player
  git commit -m "feat(release): move admin access to file secrets"
  ```

---

### Task 2: Production-only Coolify manifests

**Files:**

- Create: `deploy/coolify/apollo-platform.compose.yml`
- Create: `deploy/coolify/apollo-tf.compose.yml`
- Create: `deploy/coolify/release.env.example`
- Create: `artifacts/api-server/src/coolify-release-contract.test.ts`

**Interfaces:**

- Consumes: immutable image variables, explicit loopback ports, public origins,
  deployment metadata, `PLATFORM_SECRET_DIRECTORY`, and `TF_SECRET_DIRECTORY`.
- Produces: two complete Raw Compose resources with stable service, volume,
  network, and secret identities.

- [ ] **Step 1: Write failing manifest existence and service-set tests**

  Parse both YAML files with the existing `yaml` package. Require exact sets.

  Platform:

  ```text
  platform-postgres
  platform-redis
  platform-migrate
  platform-api
  ```

  TF:

  ```text
  tf-postgres
  tf-role-bootstrap
  tf-baseline
  tf-migrate
  tf-redis
  tf-api
  tf-web
  tf-admin
  tf-search
  tf-integrations-postgres
  tf-integrations-migrate
  tf-integrations
  tf-download-redis
  tf-download-worker
  ```

  Expected RED: production manifests do not exist.

- [ ] **Step 2: Write failing isolation and publication tests**

  Assert:
  - no `build`, `container_name`, `network_mode: host`, privileged mode,
    Docker socket, host root, or Coolify/Traefik routing label;
  - only Platform API, TF API, TF web, and TF admin have `ports`;
  - all four publications use `127.0.0.1` and required variables without
    defaults;
  - exact separate internal networks and no cross-stack database network;
  - manual TF bootstrap/baseline services exist only in profile `baseline`;
  - migrations precede API/module readiness through
    `service_completed_successfully`.

- [ ] **Step 3: Write failing secret and volume tests**

  Require file sources under the owning secret directory. Reject
  `secrets.*.environment`, secret-looking environment keys, and secret values.
  Require explicit volume names:

  ```text
  apollo-platform-postgres-v1
  apollo-platform-redis-v1
  apollo-tf-postgres-v1
  apollo-tf-redis-v1
  apollo-tf-integrations-postgres-v1
  apollo-tf-download-redis-v1
  apollo-tf-downloads-v1
  ```

  Require the documented UID/GID/mode on every secret mount.

- [ ] **Step 4: Write failing health/resource/log policy tests**

  Every long-running service must have a healthcheck, `restart:
unless-stopped`, `init: true`, `stop_grace_period`, `pids_limit`,
  `deploy.resources.limits`, and:

  ```yaml
  logging:
    driver: json-file
    options:
      max-size: 10m
      max-file: "5"
  ```

  One-shot jobs use `restart: "no"` and bounded resources/logging.

- [ ] **Step 5: Implement the two manifests and non-secret env example**

  Reuse the already validated service commands, health checks, secret paths,
  and dependency ordering. Do not copy development `build` entries or defaults.
  Keep `release.env.example` limited to public origins, ports, versions,
  timestamps, directories, and required image variables containing syntactically
  valid example digests made only of zeroes.

- [ ] **Step 6: Render both manifests**

  Use a temporary secret directory and non-secret placeholder values:

  ```powershell
  docker compose --env-file deploy/coolify/release.env.example `
    -f deploy/coolify/apollo-platform.compose.yml config --quiet
  docker compose --env-file deploy/coolify/release.env.example `
    -f deploy/coolify/apollo-tf.compose.yml config --quiet
  pnpm --filter @workspace/api-server test -- src/coolify-release-contract.test.ts
  ```

- [ ] **Step 7: Commit**

  ```powershell
  git add deploy/coolify artifacts/api-server/src/coolify-release-contract.test.ts
  git commit -m "feat(release): add production Coolify manifests"
  ```

---

### Task 3: Digest release workflow and release validator

**Files:**

- Create: `.github/workflows/apollo-release-images.yml`
- Create: `scripts/src/coolify-release.ts`
- Create: `scripts/src/coolify-release.test.ts`
- Modify: `artifacts/api-server/src/coolify-release-contract.test.ts`
- Modify: `artifacts/platform-api/Dockerfile`
- Modify: `artifacts/api-server/Dockerfile`
- Modify: `artifacts/admin-dashboard/Dockerfile`
- Modify: `artifacts/music-player/Dockerfile`
- Modify: `artifacts/tf-search/Dockerfile`
- Modify: `artifacts/tf-integrations/Dockerfile`
- Modify: `artifacts/tf-download-worker/Dockerfile`
- Modify: `scripts/package.json`
- Modify: `scripts/tsconfig.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: two rendered Compose JSON documents and a non-secret release env.
- Produces:
  `validateCoolifyRelease(input): ReleaseValidationResult`, CLI command
  `pnpm release:validate`, GHCR images addressed by digest, and a redacted
  release manifest artifact.

- [ ] **Step 1: Write failing validator tests**

  Test exact rejection for:
  - missing image or non-digest image;
  - duplicate/public/non-loopback ports;
  - image defaults, build entries, and proxy labels;
  - environment-delivered credentials;
  - missing health/resource/log policy;
  - shared Platform/TF volumes or networks;
  - an all-zero placeholder digest;
  - any secret mount whose exact UID/GID/mode differs from the documented
    owning service contract;
  - raw secret/path leakage in output.

  Test success returns only stack names, service names, image digests, ports,
  public origins, and volume names.

  Run:

  ```powershell
  pnpm --filter @workspace/scripts test -- src/coolify-release.test.ts
  ```

  Expected RED: test script and validator do not exist.

- [ ] **Step 2: Implement the validator and CLI**

  Spawn `docker compose ... config --format json`, validate parsed objects, and
  print deterministic redacted JSON. Exit `0` only when both stacks pass.
  Reject unknown environment variables whose names contain
  `PASSWORD|TOKEN|SECRET|PRIVATE|DATABASE_URL|REDIS_URL`.

- [ ] **Step 3: Write failing workflow contract tests**

  Require a manual and `v*` tag trigger, least-privilege permissions, pinned
  action commit SHAs, a matrix for every custom production image/target,
  BuildKit provenance/SBOM, GHCR push, digest capture, and one redacted
  `apollo-release-manifest.json` artifact. Reject pull-request secret use and
  floating action tags.

- [ ] **Step 4: Write failing base-image provenance tests**

  Inspect every `FROM` instruction in the seven production Dockerfiles. Require
  `repository:tag@sha256:<64 lowercase hex characters>` and reject a tag-only
  base, an all-zero digest, an unqualified repository, or a build argument used
  as the digest. Resolve each official multi-platform digest from its canonical
  registry tag with `docker buildx imagetools inspect`; record the source tag
  and resolved digest in the commit report without copying registry
  credentials.

- [ ] **Step 5: Pin production base images**

  Pin all Node, PostgreSQL, Redis, nginx, and other `FROM` images used by the
  Platform API, TF API, TF web, TF admin, search, integrations, integrations
  PostgreSQL, download worker, and download Redis targets. Preserve the current
  major/minor source tags before the digest so dependency intent remains
  readable.

- [ ] **Step 6: Implement the GHCR workflow**

  Build these image/target pairs from one commit:

  ```text
  platform-api/runtime
  platform-postgres/postgres-role-init
  tf-api/runner
  tf-postgres/postgres-role-init
  tf-web/runner
  tf-admin/default
  tf-search/runner
  tf-integrations/runner
  tf-integrations-postgres/postgres-role-init
  tf-download-worker/runner
  tf-download-redis/queue-redis
  ```

  Use `ghcr.io/altis13/apollo-<name>` and record each resulting digest. The
  workflow must run typecheck and affected tests before any push.

- [ ] **Step 7: Verify**

  ```powershell
  pnpm --filter @workspace/scripts test
  pnpm --filter @workspace/api-server test -- src/coolify-release-contract.test.ts
  pnpm release:validate -- --env-file deploy/coolify/release.env.example
  pnpm run typecheck
  ```

  The checked-in zero-digest example must fail with
  `placeholder_image_digest`. A temporary copy whose image values contain
  deterministic non-zero syntactic digests must pass the static validator;
  only the workflow-generated digest manifest is eligible for Task 5 runtime
  smoke or a future remote rollout.

- [ ] **Step 8: Commit**

  ```powershell
  git add .github scripts package.json pnpm-lock.yaml artifacts/*/Dockerfile artifacts/api-server/src/coolify-release-contract.test.ts
  git commit -m "feat(release): validate and publish immutable images"
  ```

---

### Task 4: Encrypted backup, restore proof, and retained-volume quarantine

**Files:**

- Create: `deploy/ops/backup-postgres.sh`
- Create: `deploy/ops/restore-postgres.sh`
- Create: `deploy/ops/verify-backup.sh`
- Create: `deploy/ops/classify-retained-volume.sh`
- Create: `scripts/src/backup-contract.test.ts`
- Create: `docs/operations/apollo-backup-restore.md`

**Interfaces:**

- Consumes: `PGPASSFILE`, exact source/target PostgreSQL connection
  parameters, `APOLLO_BACKUP_AGE_RECIPIENT`, backup destination, expected
  stack/database, and an immutable release ID.
- Produces: encrypted `.dump.age`, `.sha256`, and redacted `.json` metadata;
  disposable restore verification; a fail-closed retained-volume report.

- [ ] **Step 1: Write failing shell contract tests**

  Use temporary fake binaries to prove:
  - passwords/URLs are rejected on argv and never printed;
  - backup fails before writing when recipient/destination/release ID is absent;
  - `pg_dump` output is piped directly into age;
  - partial files are removed on failure;
  - final files are atomically renamed and mode `0600`;
  - metadata contains no path, host, username, password, token, or recipient;
  - restore requires matching checksum, release ID, expected database, and an
    empty disposable target;
  - classification never starts PostgreSQL on an original retained volume.

  Run:

  ```powershell
  pnpm --filter @workspace/scripts test -- src/backup-contract.test.ts
  ```

  Expected RED: operator scripts do not exist.

- [ ] **Step 2: Implement backup and verification scripts**

  Use `set -eu`, private `umask`, `mktemp` inside the destination, `pg_dump
--format=custom --no-owner --no-privileges`, `age -r`, SHA-256, and atomic
  rename. Trap every failure and redact all errors to stage names.

- [ ] **Step 3: Implement restore and retained-volume guards**

  Restore only into a disposable target explicitly named by the operator.
  Classification is metadata-only for the original volume and emits
  `DETACHED_UNKNOWN`, `ATTACHED_BLOCKED`, or `FRESH_RELEASE_VOLUME`. Unknown
  legacy data can advance only after an encrypted backup and restore against a
  cloned/disposable volume under a separate approval.

- [ ] **Step 4: Run a disposable real PostgreSQL restore proof**

  Use a generated one-run age identity and PostgreSQL 16 containers. Insert a
  marker table, back up, destroy only the disposable source, restore to a
  second disposable database, compare schema/data, and prove exact zero owned
  containers, networks, volumes, images, and temporary secret files.

  The opt-in test variable is:

  ```text
  APOLLO_RUN_BACKUP_RESTORE_DOCKER=1
  ```

- [ ] **Step 5: Document production order**

  Document backup destination creation, recipient custody, retention
  (`7 daily`, `4 weekly`, `6 monthly`), restore evidence, migration approval,
  and rollback. State that queues are reconstructable but PostgreSQL and
  download files are not; both persistent classes require a release decision.

- [ ] **Step 6: Commit**

  ```powershell
  git add deploy/ops scripts/src/backup-contract.test.ts docs/operations/apollo-backup-restore.md
  git commit -m "feat(ops): add encrypted backup and restore gate"
  ```

---

### Task 5: Caddy rollout artifact and disposable production smoke

**Files:**

- Create: `deploy/caddy/apollo.caddyfile`
- Create: `deploy/caddy/validate-caddy.ps1`
- Create: `scripts/src/caddy-release-contract.test.ts`
- Create: `scripts/src/coolify-production-smoke.test.ts`
- Create: `docs/operations/apollo-production-rollout.md`
- Modify: `.github/workflows/apollo-release-images.yml`
- Modify: `artifacts/api-server/src/coolify-release-contract.test.ts`
- Modify: `scripts/src/coolify-release.ts`
- Modify: `scripts/src/coolify-release.test.ts`
- Modify:
  `artifacts/admin-dashboard/docker-entrypoint.d/16-admin-dashboard-defaults.envsh`
- Modify: `artifacts/admin-dashboard/src/config-contract.test.ts`
- Modify: `docs/operations/apollo-backup-restore.md`
- Modify: `docs/operations/homenode-coolify-preflight.md`
- Modify: `IMPLEMENTATION_STATUS.md`

**Interfaces:**

- Consumes: four exact hostnames, ports `18200..18203`, admin Caddy username
  and password hash, digest release manifest, and disposable secret files.
- Produces: a standalone Caddy include, validated route/rollback instructions,
  exact-stack local smoke evidence, and an owner-reviewable remote change set.

- [ ] **Step 1: Write failing Caddy contract tests**

  Require exact routes:

  ```text
  api.apollot.ru -> 127.0.0.1:18200
  api.tf.apollot.ru -> 127.0.0.1:18201
  tf.apollot.ru -> 127.0.0.1:18202
  admin.apollot.ru -> 127.0.0.1:18203
  ```

  Require admin `basic_auth`, security headers, WebSocket-compatible reverse
  proxy defaults, no apex/www/quasar/GA host, no unrelated import, and no
  literal password/hash/token. Expected RED: include does not exist.

- [ ] **Step 2: Implement and container-validate the Caddy include**

  `validate-caddy.ps1` must build a temporary wrapper, supply a disposable
  admin hash, run the digest-pinned Caddy image read-only, validate config, and
  remove only its exact temporary directory/container/image reference.

- [ ] **Step 3: Write failing exact production smoke**

  The smoke must:
  - create a disposable local registry;
  - build every custom image from the exact commit and push it to that registry;
  - resolve registry digests into a temporary release env;
  - provision correctly owned disposable secrets;
  - start Platform, then TF from the production manifests;
  - verify migrations, readiness, registration mode, invitation/entitlement
    denial/grant, TF search degradation, queued download/cancel, signed
    heartbeats, admin Basic Auth/dashboard token, web health, and stale states;
  - run Caddy against the four loopback publications without host DNS changes;
  - stop and restart long-running services to prove persistent state;
  - leave exact zero owned containers, networks, volumes, image references,
    registry data, and temporary secrets.

  Gate with:

  ```text
  APOLLO_RUN_COOLIFY_PRODUCTION_SMOKE=1
  ```

- [ ] **Step 4: Implement the smoke and fix only production-package defects**

  Reuse existing bridge/search/integrations/download test helpers where
  practical. Do not weaken previous security, migration, cleanup, or exact
  output assertions. Close the deferred production-package findings by
  proving:
  - the per-build digest gate accepts only exact
    `sha256:<64 lowercase hex characters>`;
  - GHCR manifest inspection uses a bounded retry with a deterministic terminal
    error;
  - every required file-backed secret has its exact `_FILE` environment key
    and no inline credential fallback;
  - admin username, password, and dashboard-token files contain one safe line,
    and malformed multiline content disables startup without secret output;
  - the built admin image executes its real entrypoint, creates the protected
    runtime configuration, and starts successfully;
  - every custom production image accepts the Compose
    `entrypoint`/`command` contract used by its final manifest.

- [ ] **Step 5: Update tracked status and rollout documentation**

  Record the discovered detached legacy-volume class without its private
  server name. Mark the production package `LOCAL_RELEASE_VALIDATED`, not
  deployed. Include:
  - exact Coolify resource names;
  - secret provisioning metadata;
  - backup/restore evidence ID;
  - image digests and rollback mapping;
  - Caddy backup/validate/reload/rollback order;
  - per-host smoke and unaffected-service checks;
  - supported Linux backup runtime and required GNU-compatible
    `mktemp`/`sha256sum` behavior;
  - explicit approval checkpoints before each remote mutation.

- [ ] **Step 6: Full validation**

  ```powershell
  pnpm --filter @workspace/api-server test
  pnpm --filter @workspace/platform-api exec vitest run src --maxWorkers=2
  pnpm --filter @workspace/tf-search test
  pnpm --filter @workspace/tf-integrations exec vitest run src --maxWorkers=2
  pnpm --filter @workspace/tf-download-worker test
  pnpm --filter @workspace/admin-dashboard test
  pnpm --filter @workspace/scripts test
  pnpm run typecheck
  pnpm release:validate -- --env-file deploy/coolify/release.env.example
  ```

  Then run both opt-in Docker proofs. Require exact cleanup zero.

- [ ] **Step 7: Commit**

  ```powershell
  git add .github/workflows/apollo-release-images.yml `
    artifacts/api-server/src/coolify-release-contract.test.ts `
    artifacts/admin-dashboard/docker-entrypoint.d/16-admin-dashboard-defaults.envsh `
    artifacts/admin-dashboard/src/config-contract.test.ts `
    deploy/caddy scripts/src docs/operations IMPLEMENTATION_STATUS.md
  git commit -m "test(release): prove Coolify production package"
  ```

---

## Plan Self-Review

- Spec coverage: all five local blockers and five Important findings from the
  2026-07-28 local contract audit map to Tasks 1-5.
- Existing immutable migrations, provider modules, policy bridge, and admin
  topology are consumed rather than rebuilt.
- The known legacy PostgreSQL volume is quarantined and never named or adopted
  in tracked artifacts.
- The first release does not claim an apex portal, Quasar, GA, Android, remote
  deployment, Caddy reload, UFW change, or DNS cutover.
- No placeholder marker, guessed secret, unbounded port, floating production
  image, or automatic destructive step remains in the plan.
- Interfaces use consistent names across manifest, validator, workflow,
  backup, Caddy, and smoke tasks.
