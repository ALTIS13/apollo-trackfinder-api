# TF System Namespace Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining PostgreSQL role-bootstrap P1 by failing closed
when a user-created object inside an excluded system namespace gives the TF
runtime unsafe effective access.

**Architecture:** Keep all mutation queries excluded from `pg_catalog`,
`information_schema`, `pg_toast`, and other `pg_*` namespaces. In the final
effective-runtime audit, treat PostgreSQL objects with OID `>= 16384` as normal
user-created objects even when their namespace is excluded; built-in catalog
objects remain below that boundary and are not audited against the application
grant projection.

**Tech Stack:** POSIX shell, PostgreSQL 16 catalogs and `psql`, TypeScript,
Vitest, Docker, pnpm 10.33.2.

## Global Constraints

- Work only in `codex/feat/tf-immutable-migrations` at
  `C:\Users\maksi\Desktop\Apollo.TF\.worktrees\tf-immutable-migrations`.
- Fix base is `da3ca4d0ce800ec7e3653e26e2959e003f1733a4`.
- Do not mutate `pg_catalog`, `information_schema`, `pg_toast`, any `pg_*`
  namespace, or built-in/extension-owned system objects.
- PostgreSQL 16 normal user-created objects begin at OID `16384`; a clean
  catalog probe proved built-in system relations and routines remain below this
  boundary.
- User-created objects with OID `>= 16384` inside an excluded namespace must
  participate in the final effective-runtime audit and make the bootstrap fail
  closed if they expose access outside the exact TF runtime projection.
- Preserve runtime DML only on the five managed tables, `USAGE` only on their
  managed sequences, `SELECT` on `apollo_tf.schema_migrations`, and no
  user-created routine execution.
- A failed audit must roll the entire bootstrap transaction back. The excluded
  object and pre-bootstrap managed-role state must remain unchanged.
- Do not change the already-reviewed migration-lock, heartbeat-key, Compose,
  HomeNode, Coolify, Caddy, UFW, DNS, Android, or application-route behavior.
- Use exact disposable Docker resources and exact cleanup only. Never run broad
  prune.

---

### Task 1: Fail Closed on User-Created System-Namespace Objects

**Files:**

- Modify:
  `artifacts/api-server/src/role-bootstrap.docker.test.ts`
- Modify:
  `artifacts/api-server/container/init-roles.sh`
- Modify:
  `docs/superpowers/plans/2026-07-27-tf-immutable-migrations.md`

**Interfaces:**

- Consumes: the existing `runManualBootstrap(true)` PostgreSQL 16 proof helper
  and the final `do $audit$` effective-runtime audit.
- Produces: a system-namespace canary proving transactional fail-closed behavior
  and an OID-aware effective audit that preserves built-in system access.

- [ ] **Step 1: Add the failing PostgreSQL 16 canary**

  In the existing retained-state normalization test, create
  `pg_catalog.apollo_tf_system_namespace_canary()` as a user-defined
  `SECURITY DEFINER` SQL function with a fixed `search_path = pg_catalog` and
  default/null ACL. Assert before bootstrap that:
  - its OID is `>= 16384`;
  - `PUBLIC` and `apollo_tf_runtime` can execute it;
  - its ACL is still null.

  Run `runManualBootstrap(true)` and require a generic nonzero bootstrap
  failure. Verify rollback by proving:
  - the canary still has default `PUBLIC EXECUTE`;
  - the canary still exists and remains unmodified;
  - the seeded runtime connection limit remains `0`.

  Drop the canary as the admin before continuing the existing successful
  normalization path.

- [ ] **Step 2: Run the focused proof to verify RED**

  Run:

  ```powershell
  $env:TF_RUN_ROLE_BOOTSTRAP_DOCKER='1'
  pnpm --filter @workspace/api-server test -- src/role-bootstrap.docker.test.ts
  ```

  Expected: exactly the retained-state normalization test fails because the
  bootstrap exits `0` while the user-created `pg_catalog` routine remains
  executable.

- [ ] **Step 3: Implement the minimal OID-aware effective audit**

  In `do $audit$`, declare one constant:

  ```sql
  first_normal_object_id constant oid := 16384;
  ```

  Keep all PUBLIC normalization queries unchanged. For effective-runtime checks
  on schemas, relations, sequences, columns, routines, and types, include an
  object when either:
  - its namespace is already in the existing non-system scope; or
  - its object OID (the parent relation OID for columns) is
    `>= first_normal_object_id`.

  This must audit but never mutate user-created objects inside excluded system
  namespaces. Built-in system objects below OID `16384` remain outside the
  application-specific projection.

- [ ] **Step 4: Run the focused proof to verify GREEN**

  Run:

  ```powershell
  $env:TF_RUN_ROLE_BOOTSTRAP_DOCKER='1'
  pnpm --filter @workspace/api-server test -- src/role-bootstrap.docker.test.ts
  ```

  Expected: `4 passed / 4 collected`, including the new rollback canary.

- [ ] **Step 5: Document and validate the correction**

  Update the immutable-migrations plan so it explicitly states that excluded
  system namespaces are never mutated, while normal-OID user-created objects
  inside them are included in the final effective-runtime fail-closed audit.

  Run:

  ```powershell
  pnpm --filter @workspace/api-server typecheck
  pnpm --filter @workspace/api-server test
  pnpm --filter @workspace/api-server build
  pnpm run typecheck
  docker compose -f docker-compose.yml config --quiet
  docker compose -f artifacts/api-server/docker-compose.yml config --quiet
  & 'C:\Program Files\Git\bin\bash.exe' -n artifacts/api-server/container/init-roles.sh
  pnpm exec prettier --check artifacts/api-server/src/role-bootstrap.docker.test.ts docs/superpowers/plans/2026-07-27-tf-immutable-migrations.md docs/superpowers/plans/2026-07-28-tf-system-namespace-audit.md
  git diff --check
  ```

  Require exact zero residual role-bootstrap proof containers, networks,
  volumes, and images.

- [ ] **Step 6: Commit**

  Commit only the three implementation files:

  ```powershell
  git add -- artifacts/api-server/container/init-roles.sh artifacts/api-server/src/role-bootstrap.docker.test.ts docs/superpowers/plans/2026-07-27-tf-immutable-migrations.md
  git commit -m "fix(db): audit user objects in system namespaces"
  ```

  Write the complete RED/GREEN and validation evidence to the ignored SDD task
  report before returning.
