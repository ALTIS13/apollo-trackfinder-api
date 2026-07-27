# TF Immutable Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Apollo TF API startup DDL with immutable, checksum-verified
PostgreSQL migrations executed by a dedicated one-shot `tf-migrate` container
and a least-privilege migrator role.

**Architecture:** `@workspace/db` owns numbered SQL, an exact checksum manifest,
a fail-closed migration runner, runtime migration-readiness, and separate pool
profiles. The API image contains both API and migrator entrypoints; Compose uses
a dedicated TF PostgreSQL cluster, creates admin/migrator/runtime database roles
on a fresh volume, runs `tf-migrate` once, and starts API only after successful
completion. Normal migration deliberately rejects unmanaged tables. Separate
manual role-bootstrap and baseline services, both disabled by default, can adopt
only the exact legacy startup schema after backup, complete catalog validation,
and explicit ownership transfer.

**Tech Stack:** TypeScript, Node.js 20, PostgreSQL 16, `pg`, Vitest, esbuild,
Docker Compose, pnpm 10.33.2.

## Global Constraints

- Follow strict RED -> verify expected failure -> GREEN -> verify pass for every
  production behavior.
- No HomeNode, Coolify, Caddy, UFW, DNS, remote Docker, domain, or Android
  mutation is part of this plan.
- No migration creates, reads, grants access to, or records legacy
  `spotify_tokens` or `yandex_tokens`.
- Migration filenames match `^\d{4}_[a-z0-9_]+\.sql$`; filesystem names and
  manifest names are exact, unique, sorted equals.
- SQL files are immutable after publication. Every manifest checksum is
  lowercase SHA-256 of exact UTF-8 file bytes.
- Persisted history is an exact manifest prefix during migration and the exact
  full manifest during runtime readiness. Extra, missing-middle, reordered, or
  checksum-drifted history fails closed.
- Lock acquisition polls `pg_try_advisory_lock(hashtext($1))` every `250ms` for
  at most `10s` and fails with `migration_lock_timeout`. Every probe uses the
  remaining aggregate budget as its node-postgres `query_timeout`; the clock is
  checked again before accepting acquisition, retry sleep is capped to the
  remaining budget, and a probe timeout poison-releases the uncertain physical
  client without replacing the primary contract error.
- The migrator preserves the primary error. Any uncertain lock, rollback,
  unlock, or release state destroys the pooled client by passing an error to
  `client.release(error)`.
- Runtime pool: connection `5s`, query/statement `10s`, lock `3s`,
  idle-in-transaction `10s`, idle pool `30s`, maximum `10`.
- Migration pool: connection `10s`, query/statement `120s`, lock `10s`,
  idle-in-transaction `30s`, idle pool `30s`, maximum `2`.
- PostgreSQL roles are exactly `apollo_tf_migrator` and `apollo_tf_runtime`;
  both are login, non-superuser, no-createdb, no-createrole, noinherit,
  noreplication, nobypassrls, connection limit `-1`, and valid until
  `infinity`.
- Role bootstrap is supported only on a dedicated TF PostgreSQL cluster. It
  revokes `PUBLIC` and both managed roles from every database, restores access
  only to the current TF database, removes stale direct/default ACLs,
  memberships, every global/current/foreign-database managed-role setting, and
  managed-role ownership across PostgreSQL 16 catalog classes. Unsafe `PUBLIC`
  privileges are removed from current-database non-system/non-extension
  schemas, relations, columns, sequences, routines, types, large objects,
  foreign-data wrappers, and foreign servers; extension-owned pollution fails
  closed without mutation. Final direct and effective-runtime catalog audits
  must both pass. Foreign object ACLs or foreign runtime-owned default ACLs are
  rejected.
- Runtime receives DML only for the five active TF tables, sequence USAGE only,
  and SELECT-only access to `apollo_tf.schema_migrations`. Runtime cannot
  CREATE, ALTER, DROP, TRUNCATE, call `setval`, or mutate migration history.
- An unmanaged database containing any of the five active TF tables but no
  migration history fails normal migration. Baseline exists only as explicit
  `--baseline-existing-startup-schema`; it requires an admin URL for the current
  PostgreSQL superuser, exact catalog validation, and empty/no history. Compose
  exposes it only through the disabled-by-default `baseline` profile and never
  invokes it during normal startup.
- Database, Redis, worker, search, integrations, and migration ports are never
  published. Existing web/API/admin publications remain loopback-only in local
  Compose and are not changed to public interfaces.
- Secrets remain file-backed. No URL, password, token, key, or canary enters
  tracked files, Docker build arguments, image metadata, rendered Compose
  output, or logs.
- TF database, migrator, API, search, integrations, and worker definitions in
  root and `artifacts/api-server/docker-compose.yml` must remain semantically
  synchronized. Root-only web/admin services remain root-only. Platform bridge
  Compose is updated in a separate reviewed task.

---

### Task 1: Immutable migration package and readiness

**Files:**

- Create: `lib/db/migrations/0001_tf_core_collections.sql`
- Create: `lib/db/migrations/0002_tf_runtime_privileges.sql`
- Create: `lib/db/src/pool.ts`
- Create: `lib/db/src/migrations.ts`
- Create: `lib/db/src/migrations.test.ts`
- Create: `lib/db/src/migration-manifest.test.ts`
- Modify: `lib/db/src/index.ts`
- Modify: `lib/db/package.json`
- Test: `lib/db/src/migrations.test.ts`
- Test: `lib/db/src/migration-manifest.test.ts`

**Interfaces:**

- Produces:
  `createTfPool(connectionString, profile: "runtime" | "migration"): Pool`.
- Produces:
  `TF_MIGRATION_MANIFEST: readonly MigrationManifestEntry[]`.
- Produces:
  `runTfMigrations(pool, directory?, manifest?): Promise<MigrationResult>`.
- Produces:
  `baselineTfStartupSchema(pool, directory?, manifest?): Promise<MigrationResult>`.
- Produces:
  `createTfMigrationReadinessProbe(queryable, manifest): () => Promise<boolean>`.
- Migration history table is exactly `apollo_tf.schema_migrations`.

- [ ] **Step 1: Write RED manifest and runner tests**

Create tests that require:

```ts
expect(TF_MIGRATION_MANIFEST.map(({ name }) => name)).toEqual([
  "0001_tf_core_collections.sql",
  "0002_tf_runtime_privileges.sql",
]);
expect(recomputed).toEqual(TF_MIGRATION_MANIFEST);
```

Runner fake-client cases must assert:

```ts
await expect(runTfMigrations(pool, directory, manifest)).rejects.toMatchObject({
  code: "migration_manifest_mismatch",
});
await expect(
  runTfMigrations(poolWithTimedOutLock(), directory, manifest),
).rejects.toMatchObject({ code: "migration_lock_timeout" });
await expect(
  runTfMigrations(
    poolWithHistory([{ name: "9999_unknown.sql", checksum: "x" }]),
    directory,
    manifest,
  ),
).rejects.toMatchObject({
  code: "migration_history_mismatch",
});
```

Also cover checksum drift, non-prefix history, bounded lock retry at exact
`250ms` intervals, idempotent second run, transaction rollback, unlock failure,
release failure, preservation of the primary error, and
`client.release(error)` on uncertain cleanup.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --filter @workspace/db test
```

Expected: FAIL because the migration files, manifest, runner, pool factory, and
package test script do not exist.

- [ ] **Step 3: Add exact first migration**

Create `0001_tf_core_collections.sql` with schema-qualified plain
`CREATE TABLE public.<name>`, not `IF NOT EXISTS`, for:

```sql
track_search_cache
play_history
liked_tracks
playlists
playlist_tracks
```

Match the existing startup SQL columns, nullability, defaults, primary keys,
unique constraints, and indexes. Do not put grants in `0001`.

Create `0002_tf_runtime_privileges.sql` with explicit grants only to
`apollo_tf_runtime`:

```sql
grant usage on schema apollo_tf to apollo_tf_runtime;
grant select on apollo_tf.schema_migrations to apollo_tf_runtime;
grant select, insert, update, delete on
  public.track_search_cache,
  public.play_history,
  public.liked_tracks,
  public.playlists,
  public.playlist_tracks
to apollo_tf_runtime;
grant usage on sequence
  public.track_search_cache_id_seq,
  public.play_history_id_seq,
  public.liked_tracks_id_seq,
  public.playlists_id_seq,
  public.playlist_tracks_id_seq
to apollo_tf_runtime;
```

Do not mention provider token tables in either SQL file.

- [ ] **Step 4: Implement pool profiles, manifest, runner, and readiness**

Follow the established Platform/Integrations cleanup structure. Before opening a
database connection, verify exact filesystem names and checksums. Acquire:

```sql
select pg_try_advisory_lock(hashtext($1)) as acquired
```

with lock name `apollo_tf_migrations`. Retry every `250ms` until the `10s`
deadline; make `now` and `sleep` injectable in runner options for zero-delay
unit tests.

After lock acquisition, execute this exact sequence:

1. `BEGIN`;
2. create `apollo_tf` and `apollo_tf.schema_migrations`;
3. `COMMIT`;
4. load persisted rows ordered by name and require an exact manifest prefix;
5. for each remaining migration: `BEGIN`, migration SQL, history INSERT,
   `COMMIT`;
6. on migration failure, `ROLLBACK` only that migration transaction;
7. unlock and release in `finally`.

Readiness queries the full history and returns false on any exception or
mismatch.

Implement `baselineTfStartupSchema` under the same manifest and lock contract.
It accepts only full name/checksum equality with the canonical two-entry
manifest above, requires the connection's current role to be a PostgreSQL
superuser, requires history to be absent or empty, and queries PostgreSQL
catalogs to compare exact managed tables:

- column name, ordinal, PostgreSQL type, nullability, and normalized default;
- every constraint name, type, and normalized full definition, with no extra
  CHECK, foreign-key, exclusion, or other constraint;
- every non-constraint index name and normalized full definition, including
  uniqueness, method, keys/expressions, predicate, INCLUDE columns, collation,
  and opclass.

All five managed tables must match `0001` exactly; missing/extra managed columns,
constraints, or indexes fail with `migration_baseline_mismatch`. Extra unrelated
tables are ignored and receive no grants. One transaction must:

1. lock all five managed tables in `ACCESS EXCLUSIVE` mode;
2. validate the catalog while those locks are held;
3. create `apollo_tf` and `apollo_tf.schema_migrations`;
4. transfer ownership of all five managed tables and their owned sequences to
   `apollo_tf_migrator`;
5. transfer ownership of the `apollo_tf` schema and history table to
   `apollo_tf_migrator`;
6. insert the exact `0001` checksum without running `0001` DDL;
7. commit.

The baseline runner then applies `0002` in its own transaction and records its
checksum. A failure while applying `0002` leaves the exact `0001` prefix so the
normal migrator can safely resume. Provider token tables are neither validated,
transferred, nor granted.

Refactor the current root pool construction through `createTfPool`; do not
change the required `DATABASE_URL` startup contract.

Set package exports and scripts exactly:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./schema": "./src/schema/index.ts",
    "./migrations": "./src/migrations.ts",
    "./pool": "./src/pool.ts"
  },
  "scripts": {
    "push": "drizzle-kit push --config ./drizzle.config.ts",
    "push-force": "drizzle-kit push --force --config ./drizzle.config.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Add `vitest` to `devDependencies`; preserve existing package dependencies.

- [ ] **Step 5: Verify GREEN and typecheck**

Run:

```powershell
pnpm --filter @workspace/db test
pnpm --filter @workspace/db typecheck
pnpm --filter @workspace/api-server test -- src/routes/health.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add lib/db
git commit -m "feat(db): add immutable TF migrations"
```

---

### Task 2: API migrator entrypoint and DDL-free runtime

**Files:**

- Create: `artifacts/api-server/src/migrate.ts`
- Create: `artifacts/api-server/src/lib/tf-migrator.ts`
- Create: `artifacts/api-server/src/lib/tf-migrator.test.ts`
- Modify: `artifacts/api-server/src/index.ts`
- Delete: `artifacts/api-server/src/lib/migrate.ts`
- Delete: `artifacts/api-server/src/lib/migrate.test.ts`
- Modify: `artifacts/api-server/src/index.smoke.test.ts`
- Modify: `artifacts/api-server/build.mjs`
- Modify: `artifacts/api-server/Dockerfile`
- Test: `artifacts/api-server/src/lib/tf-migrator.test.ts`
- Test: `artifacts/api-server/src/index.smoke.test.ts`

**Interfaces:**

- Consumes Task 1 migration APIs through `@workspace/db/migrations` and
  `@workspace/db/pool`.
- Normal migrator secret variable is exactly
  `TF_MIGRATOR_DATABASE_URL_FILE`.
- Manual baseline secret variable is exactly
  `TF_BASELINE_DATABASE_URL_FILE`; it is accepted only with
  `--baseline-existing-startup-schema`.
- Optional process argument is exactly `--baseline-existing-startup-schema`; no
  other argument is accepted. The normal path rejects the baseline variable and
  the baseline path rejects the migrator variable.
- Emits one success event:
  `{"event":"tf_migrations_complete","applied":N,"alreadyApplied":N}`.
- Failure output is exactly `TF migration failed` and never contains a secret,
  path, SQL, or underlying error text.

- [ ] **Step 1: Write RED migrator/startup/build tests**

Tests must prove:

```ts
expect(indexSource).not.toContain("runMigrations");
expect(indexSource).not.toContain("./lib/migrate");
expect(buildSource).toContain(
  'migrate: path.resolve(artifactDir, "src/migrate.ts")',
);
expect(dockerfile).toContain("COPY lib/db/migrations /app/migrations");
```

Migrator-library tests inject `readFile`, pool creation, runner, and stdout.
Require missing/unreadable/empty/over-4096-byte URL files to fail generically;
require `pool.end()` after success and failure; require exact success JSON.
`src/migrate.ts` is only the process wrapper: it invokes the tested library,
writes exact generic stderr on rejection, and sets exit code `1`.
Tests require the default path to consume only
`TF_MIGRATOR_DATABASE_URL_FILE` and call `runTfMigrations`; the exact optional
argument must consume only `TF_BASELINE_DATABASE_URL_FILE` and call
`baselineTfStartupSchema`. Unknown/duplicate arguments or cross-scoped database
URL variables fail before opening a pool.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --filter @workspace/api-server test -- src/lib/tf-migrator.test.ts src/index.smoke.test.ts
```

Expected: FAIL because API still imports startup DDL and no migrator entrypoint
is built.

- [ ] **Step 3: Implement the migrator**

`tf-migrator.ts` reads at most `4096` UTF-8 bytes from the mode-specific required
file, trims only the final loaded value, creates a migration-profile pool, runs
migrations from `/app/migrations`, emits exact JSON, and closes the pool in
`finally`. `migrate.ts` contains only the process wrapper, so tests never
import-execute an entrypoint. The optional baseline path reports the combined
baseline plus remaining-migration counts in the same event shape.

- [ ] **Step 4: Remove runtime DDL and gate readiness on exact history**

Delete the old migration module and call. In API readiness, replace the generic
database ping with the Task 1 migration-readiness probe against the runtime
pool. Keep Redis readiness and provider/module independence unchanged.

- [ ] **Step 5: Package both entrypoints and SQL**

Build with named esbuild entries:

```js
entryPoints: {
  index: path.resolve(artifactDir, "src/index.ts"),
  migrate: path.resolve(artifactDir, "src/migrate.ts"),
}
```

Copy exact migrations to `/app/migrations`; keep app files root-owned and
non-writable.

- [ ] **Step 6: Verify GREEN**

Run:

```powershell
pnpm --filter @workspace/api-server test -- src/lib/tf-migrator.test.ts src/index.smoke.test.ts src/routes/health.test.ts
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/api-server build
node --check artifacts/api-server/dist/index.mjs
node --check artifacts/api-server/dist/migrate.mjs
```

Expected: all pass, no startup DDL reference in `index.mjs`.

- [ ] **Step 7: Commit**

```powershell
git add artifacts/api-server lib/db/package.json pnpm-lock.yaml
git commit -m "feat(api): separate TF migration runtime"
```

---

### Task 3: Fresh-volume roles and one-shot Compose service

**Files:**

- Create: `artifacts/api-server/container/init-roles.sh`
- Create: `artifacts/api-server/container/read-bounded-secret.c`
- Create: `artifacts/api-server/src/role-bootstrap.docker.test.ts`
- Modify: `artifacts/api-server/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `artifacts/api-server/docker-compose.yml`
- Modify: `artifacts/api-server/src/deployment-contract.test.ts`
- Modify: `artifacts/tf-search/src/deployment-contract.test.ts`
- Modify: `artifacts/tf-download-worker/src/deployment-contract.test.ts`
- Modify: `artifacts/tf-integrations/src/smoke.test.ts`
- Modify: `artifacts/tf-search/src/smoke.test.ts`
- Modify: `artifacts/tf-search/scripts/smoke.mjs`
- Modify: `artifacts/tf-download-worker/src/smoke.test.ts`

**Interfaces:**

- Secret names:
  `tf_postgres_admin_password`, `tf_admin_database_url`,
  `tf_migrator_password`, `tf_runtime_password`,
  `tf_migrator_database_url`, `tf_runtime_database_url`.
- Service name: `tf-migrate`.
- Manual service names: `tf-role-bootstrap` and `tf-baseline`, both under
  profile `baseline`.
- PostgreSQL target: `postgres-role-init`.
- API image variable: `TF_API_IMAGE`.
- Physical `tf_admin_database_url` source contract: owner/group
  `root:10002`, mode `0440`; only `tf-role-bootstrap` and `tf-baseline` receive
  supplemental group `10002`.

- [ ] **Step 1: Write RED deployment contracts**

Parse both Compose files and require:

```ts
expect(serviceNames).toContain("tf-migrate");
expect(api.depends_on["tf-migrate"].condition).toBe(
  "service_completed_successfully",
);
expect(migrate.restart).toBe("no");
expect(migrate.networks).toEqual(["tf-data"]);
expect(migrate.secrets.map(source)).toEqual(["tf_migrator_database_url"]);
expect(migrate.environment.TF_MIGRATOR_DATABASE_URL_FILE).toBe(
  "/run/secrets/tf_migrator_database_url",
);
expect(api.secrets.map(source)).toContain("tf_runtime_database_url");
expect(api.secrets.map(source)).not.toContain("tf_migrator_database_url");
expect(baseline.profiles).toEqual(["baseline"]);
expect(baseline.secrets.map(source)).toEqual(["tf_admin_database_url"]);
expect(baseline.environment.TF_BASELINE_DATABASE_URL_FILE).toBe(
  "/run/secrets/tf_admin_database_url",
);
```

Require no old `tf_database_url` or `tf_postgres_password`, no host port on DB
or migrator, non-root/read-only/init/no-new-privileges/cap-drop/pids/resource
limits, disabled-by-default role-bootstrap and baseline services, exact
per-service secret scope, and root/nested semantic parity.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --filter @workspace/api-server test -- src/deployment-contract.test.ts
pnpm --filter @workspace/tf-search test -- src/deployment-contract.test.ts
pnpm --filter @workspace/tf-download-worker test -- src/deployment-contract.test.ts
```

Expected: FAIL because the new roles, secrets, image target, and service are
absent.

- [ ] **Step 3: Implement fresh-volume role bootstrap**

Add a `postgres:16-bookworm` Docker target that installs the same executable
script at `/usr/local/bin/bootstrap-tf-roles.sh` and
`/docker-entrypoint-initdb.d/010-tf-roles.sh`. The script reads each password
from `/run/secrets` through a compiled bounded reader that single-opens a regular
file, reads at most `max + 1` bytes, preserves exact bytes including a trailing
newline, and rejects empty, oversized, NUL-containing, replaced, or mutated
sources. It creates or alters the two exact roles with the Global Constraints
attributes and transactionally normalizes database, tablespace, schema,
relation, column, sequence, routine, type, large-object, language, foreign-data,
parameter, membership, default-ACL, ownership, and role-setting state. It
revokes public and managed-role access from every database, grants access only
to the current TF database, restores the exact migrator/runtime contract, and
runs a final fail-closed catalog audit. Admin bootstrap, not migration `0002`,
grants runtime `USAGE` on the admin-owned `public` schema. It must use
`psql -X`, `ON_ERROR_STOP=1`, `\getenv`, and `%L` formatting; never interpolate
a password into shell-generated SQL.

Fresh-volume initialization is invoked by the official PostgreSQL entrypoint.
Manual mode requires `TF_ROLE_BOOTSTRAP_DATABASE_URL_FILE` pointing to
`/run/secrets/tf_admin_database_url`; it reads the bounded admin URL and passes
it to `psql` without printing it. Add a `tf-role-bootstrap` service under profile
`baseline`, attached only to `tf-data`, with exactly admin URL plus
migrator/runtime password secrets, `restart: "no"`, and no host port. Its
entrypoint is explicitly `/usr/local/bin/bootstrap-tf-roles.sh`, so it never
starts a PostgreSQL server or relies on initdb discovery. It depends on the TF
PostgreSQL service reaching `service_healthy`. Normal Compose startup never runs
this service.

- [ ] **Step 4: Add and harden `tf-migrate` in both Compose files**

Use the same API image for API/migrator, override migrator entrypoint to
`node artifacts/api-server/dist/migrate.mjs`, attach only `tf-data`, and add the
exact one-shot dependency. Set
`TF_MIGRATOR_DATABASE_URL_FILE=/run/secrets/tf_migrator_database_url`. Replace
old single-role secrets with the six exact secrets. Keep DB data volume name
unchanged, but document that the new role-init contract initializes new volumes.
Compose never passes the manual baseline argument and never deletes an old
volume automatically.

Add `tf-baseline` under profile `baseline`, using the same API image and exact
entrypoint:

```yaml
entrypoint:
  - node
  - artifacts/api-server/dist/migrate.mjs
  - --baseline-existing-startup-schema
```

It is attached only to `tf-data`, receives exactly `tf_admin_database_url`, sets
only
`TF_BASELINE_DATABASE_URL_FILE=/run/secrets/tf_admin_database_url`, has
`restart: "no"`, no published port, and the same one-shot hardening as
`tf-migrate`. It depends on `tf-role-bootstrap` completing successfully.
`tf-migrate` never depends on or invokes `tf-baseline`; the operator invokes the
profile services manually in the documented order.

- [ ] **Step 5: Update disposable smoke fixtures**

Every fixture that renders/starts root or nested Compose must create all six new
secret files, assign the database admin/migrator/runtime password files to
UID/GID `999:999` with mode `0400`, assign runtime/migrator URL files to
`10001:10001` with mode `0400`, and assign the shared admin URL source to
`root:10002` with mode `0440`. Use distinct admin, migrator, and runtime
passwords. Only the two disabled manual services receive supplemental group
`10002`; normal services cannot read the admin URL. Update expected
service/profile/secret-scope maps without weakening canary scans or cleanup
assertions.

- [ ] **Step 6: Verify GREEN**

Run:

```powershell
pnpm --filter @workspace/api-server test -- src/deployment-contract.test.ts
pnpm --filter @workspace/tf-search test -- src/deployment-contract.test.ts
pnpm --filter @workspace/tf-download-worker test -- src/deployment-contract.test.ts
pnpm --filter @workspace/tf-integrations test -- src/smoke.test.ts
$env:TF_RUN_ROLE_BOOTSTRAP_DOCKER="1"
pnpm --filter @workspace/api-server test -- src/role-bootstrap.docker.test.ts
docker compose -f docker-compose.yml config --quiet
docker compose -f artifacts/api-server/docker-compose.yml config --quiet
```

Expected: all pass with disposable canary secret setup where required. The
Docker proof covers fresh bootstrap, repeat normalization after migrations,
managed-role login boundaries, cross-database isolation, and rejection with
rollback for foreign ACL/default-ACL ownership. It removes only exact resources
created by the proof and confirms none remain; it never performs a broad prune.

- [ ] **Step 7: Commit**

```powershell
git add artifacts/api-server artifacts/tf-search artifacts/tf-download-worker artifacts/tf-integrations docker-compose.yml
git commit -m "feat(deploy): add one-shot TF migration service"
```

---

### Task 4: Platform bridge migration ordering

**Files:**

- Modify: `artifacts/platform-api/docker-compose.bridge.yml`
- Modify: `artifacts/platform-api/src/bridge-e2e.test.ts`
- Modify: `artifacts/platform-api/scripts/bridge-smoke.mjs`

**Interfaces:**

- Reuses Task 3 exact TF secret and role names.
- Service order is `tf-postgres -> tf-migrate -> tf-api`.
- Reuses the disabled `baseline` profile with `tf-role-bootstrap` and
  `tf-baseline`; neither participates in normal bridge startup.
- Platform services receive no TF admin, migrator, runtime, or database secret.

- [ ] **Step 1: Write RED bridge contracts**

Require bridge Compose to include `tf-migrate`, exact role-init target, both
profiled manual services, exact secret scopes, no old single-role secrets, and
API `service_completed_successfully` dependency.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --filter @workspace/platform-api test -- src/bridge-e2e.test.ts
```

Expected: FAIL on missing `tf-migrate` and old secret names.

- [ ] **Step 3: Update bridge Compose and smoke**

Use the Task 3 API/PostgreSQL image targets and exact secrets. Update the bridge
smoke secret factory, ownership, service matrix, startup order, secret scans,
and cleanup checks. Do not expose any new host port.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
pnpm --filter @workspace/platform-api test -- src/bridge-e2e.test.ts
pnpm --filter @workspace/platform-api typecheck
docker compose -f artifacts/platform-api/docker-compose.bridge.yml config --quiet
```

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add artifacts/platform-api
git commit -m "feat(platform): gate TF bridge on migrations"
```

---

### Task 5: Real PostgreSQL proof, documentation, and release validation

**Files:**

- Create: `lib/db/src/integration.test.ts`
- Modify: `MODULES.md`
- Modify: `IMPLEMENTATION_STATUS.md`

**Interfaces:**

- PostgreSQL integration is gated by `TF_TEST_RUN_ID`,
  `TF_TEST_ADMIN_DATABASE_URL`, `TF_TEST_MIGRATOR_DATABASE_URL`, and
  `TF_TEST_RUNTIME_DATABASE_URL`. Incomplete configuration skips before
  connection.
- `TF_TEST_RUN_ID` is a non-secret 8-32 character lowercase ASCII identifier.
  The runner creates `apollo_tf_test_<run_id>`, an alternate database, and an
  external sentinel outside the managed/reset object list. It sets the exact
  target marker `apollo.tf.integration-run:<run_id>` and sentinel content
  derived from the run ID; the test never creates the sentinel.
- The harness checks out exactly one admin, migrator, and runtime `PoolClient`.
  Before any DDL/reset, read-only probes on those exact clients require the
  marked PostgreSQL 16 database on one non-null server address/port, with a
  PostgreSQL superuser plus the exact migrator/runtime roles. All reset,
  migration, readiness, baseline, CRUD, denial, history, and cleanup SQL then
  uses pinned adapters over those clients; a dropped connection fails instead
  of transparently acquiring another backend.
- Wrong run ID, expected marker, database target, cross-target session, and
  role assignment must fail before the destructive callback and preserve the
  runner-owned sentinel. Final reset runs in `try`; physical client release and
  every `Pool.end()` attempt run in `finally`, preserving the primary reset
  failure.
- Any mismatch closes acquired clients and all pools and fails with one generic
  error.
- Target-validation errors never print a URL, password, raw run ID, marker,
  host, database name, or connection detail.
- Old-volume adoption is manual-only and exact; normal migration and Compose
  never invoke it.

- [ ] **Step 1: Write RED real-PostgreSQL integration cases**

Against disposable PostgreSQL with the exact two roles, prove:

1. clean migration applies `0001` and `0002`;
2. second run reports both already applied;
3. runtime reads exact history and CRUDs the five active tables;
4. runtime cannot CREATE/ALTER/DROP/TRUNCATE, mutate history, or access a
   canary table not explicitly granted; canary isolation checks SELECT, INSERT,
   UPDATE, DELETE, TRUNCATE, REFERENCES, and TRIGGER privileges and executes
   denied SELECT/INSERT/UPDATE/DELETE/TRUNCATE statements;
5. extra/checksum-drifted history fails;
6. normal migration against pre-existing managed tables with no history fails
   and inserts no history row;
7. manual baseline through the PostgreSQL superuser admin URL accepts the exact
   old startup schema, transfers all managed table/sequence/history ownership to
   `apollo_tf_migrator`, and normal migration then reports both migrations
   already applied; an owner-only non-superuser connection is rejected;
8. a test-only wrapper injects a generic query failure only for the exact
   `0002` SQL during manual baseline, leaving exact `0001` history and
   transferred ownership, after which normal migrator applies `0002`; no
   cluster-global role is renamed;
9. manual baseline rejects missing/extra/changed managed columns, defaults,
   constraints, or indexes and inserts no history;
10. runtime cannot call `setval` on managed sequences;
11. no provider token table is created or granted.

- [ ] **Step 2: Verify RED**

Run the integration test with disposable URLs. Expected: FAIL until the Docker
role/migration contract is complete.

- [ ] **Step 3: Complete only the minimal fixes required by the proof**

Do not weaken baseline catalog equality or invoke it from normal migration. Fix
grants, cleanup, or SQL only when a RED case proves the mismatch.

- [ ] **Step 4: Update operator documentation**

Replace old `tf_postgres_password`/`tf_database_url` instructions with the six
new secret files. State:

- role init runs only on a fresh database volume;
- the PostgreSQL instance is dedicated to Apollo TF; role bootstrap must not run
  against a shared cluster;
- the physical `tf_admin_database_url` file is `root:10002` mode `0440`, and
  only the two profiled manual services receive supplemental group `10002`;
- this project has no remote TF volume to adopt;
- an old local volume must be backed up and inspected, then upgraded in exact
  order: configure `tf_admin_database_url` for its PostgreSQL superuser, run
  the profiled `tf-role-bootstrap`, run the profiled `tf-baseline`, and run
  normal `tf-migrate`; it is never silently reused or automatically deleted;
- production migration requires backup/restore evidence and owner approval;
- API liveness may be healthy while readiness stays unavailable until exact
  migration history exists.

- [ ] **Step 5: Run full validation**

Run:

```powershell
pnpm --filter @workspace/db test
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/tf-search test
pnpm --filter @workspace/tf-integrations test
pnpm --filter @workspace/tf-download-worker test
pnpm --filter @workspace/platform-api test
pnpm run typecheck
pnpm --filter @workspace/api-server build
pnpm --filter @workspace/platform-api build
docker compose -f docker-compose.yml config --quiet
docker compose -f artifacts/api-server/docker-compose.yml config --quiet
docker compose -f artifacts/platform-api/docker-compose.bridge.yml config --quiet
git diff --check
```

Run the existing real-Docker smoke suites affected by changed secret fixtures.
Verify exact owned-container/network/volume/temp cleanup afterward. Do not prune
unrelated Docker resources.

- [ ] **Step 6: Independent whole-branch review and fixes**

Review the exact base-to-head range for migration ordering, privilege escape,
history drift, cleanup uncertainty, secret leakage, Compose scope, old-volume
behavior, and test gaps. Resolve all P0-P2 findings with a scoped re-review.

- [ ] **Step 7: Commit**

```powershell
git add lib/db/src/integration.test.ts MODULES.md IMPLEMENTATION_STATUS.md
git commit -m "docs: record immutable TF migration validation"
```

- [ ] **Step 8: Publication**

Push `codex/feat/tf-immutable-migrations`, fast-forward reviewed commits into
`main`, rerun the merged-result focused gate, push `main`, and preserve the
remote feature ref as an audit trail. Remote infrastructure remains unchanged.
