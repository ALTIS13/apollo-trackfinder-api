# Admin Telemetry API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the validated Apollo TF admin dashboard snapshot from `GET /api/admin/dashboard` with server-side token authentication and truthful process telemetry that can later accept independent module sources.

**Architecture:** Move the snapshot DTO and Zod validation into `@workspace/admin-dashboard-contract`, consumed by both the admin frontend and API. The API owns a bounded rolling request tracker and an async snapshot builder with injected runtime dependencies. A dedicated Express router authenticates with a constant-time token comparison, validates the outgoing snapshot, disables itself when no token is configured, and never exposes credentials or raw infrastructure data.

**Tech Stack:** TypeScript 5.9, Zod 3, Express 5, Node crypto/fetch/http, Vitest 4, pnpm workspaces, Docker Compose.

## Global Constraints

- Do not access or modify HomeNode, Coolify, Caddy, Remnawave, or UFW in this stage.
- `GET /api/admin/dashboard` must require `X-Admin-Dashboard-Token`; an empty server token disables the endpoint with `503`.
- Token comparison must use constant-time digest comparison and must never log or return the token.
- The admin nginx surface must require separate operator authentication, rate-limit probes, and deny access when operator credentials are absent.
- Outgoing payloads must pass the same Zod contract used by the admin frontend.
- Telemetry buffers must be bounded and contain no request bodies, query strings, cookies, authorization values, account tokens, or provider credentials.
- Unknown external/container health must be reported as `unknown`, not fabricated as healthy.
- The endpoint must return `Cache-Control: no-store`.

---

### Task 1: Shared Dashboard Snapshot Contract

**Files:**
- Create: `lib/admin-dashboard-contract/package.json`
- Create: `lib/admin-dashboard-contract/tsconfig.json`
- Create: `lib/admin-dashboard-contract/src/index.test.ts`
- Create: `lib/admin-dashboard-contract/src/index.ts`
- Modify: `artifacts/admin-dashboard/package.json`
- Modify: `artifacts/admin-dashboard/src/types/dashboard.ts`
- Modify: `artifacts/admin-dashboard/src/data/dashboard-snapshot-schema.ts`
- Modify: `artifacts/api-server/package.json`
- Modify: `artifacts/api-server/tsconfig.json`
- Modify: `tsconfig.json`
- Modify: `artifacts/api-server/Dockerfile`

**Interfaces:**
- Produces: `@workspace/admin-dashboard-contract` exports `HealthStatus`, `DashboardMetric`, `ServiceModule`, `ServiceEdge`, `IncidentDiagnostic`, `Incident`, `ProviderHealth`, `DashboardSnapshot`, `dashboardSnapshotSchema`, and `parseDashboardSnapshot(value)`.
- Consumes: Zod `3.25.76`.

- [x] **Step 1: Add the package manifest and failing contract test**

The test imports the not-yet-created contract and asserts acceptance of a minimal four-metric snapshot plus rejection of invalid edge-to-incident relations.

- [x] **Step 2: Install and verify RED**

Run: `pnpm install && pnpm --filter @workspace/admin-dashboard-contract test`

Expected: FAIL because `src/index.ts` does not exist.

- [x] **Step 3: Implement the shared Zod schema and typed exports**

Move the existing strict limits and referential checks unchanged, including warning/degraded incident links, required linked diagnostics, and endpoint service ownership.

- [x] **Step 4: Re-export the contract from the admin frontend and wire workspace references**

Keep UI-only types (`IncidentFilter`, adapter modes/capabilities) local while importing/re-exporting snapshot DTO types from the shared package. Make the admin schema module a compatibility re-export of `parseDashboardSnapshot`.

- [x] **Step 5: Verify GREEN and existing admin compatibility**

Run: `pnpm --filter @workspace/admin-dashboard-contract test && pnpm --filter @workspace/admin-dashboard test -- --reporter=dot && pnpm run typecheck:libs`

Expected: shared tests and all 82 admin tests pass; TypeScript project references exit `0`.

### Task 2: Bounded Runtime Telemetry And Snapshot Builder

**Files:**
- Create: `artifacts/api-server/src/lib/admin-telemetry.test.ts`
- Create: `artifacts/api-server/src/lib/admin-telemetry.ts`
- Modify: `artifacts/api-server/src/lib/background-queue.ts`

**Interfaces:**
- Produces: `RollingRequestTelemetry.record({ method, path, statusCode, at? })` and `snapshot(at?)`.
- Produces: `createAdminDashboardSnapshot(dependencies): Promise<DashboardSnapshot>`.
- Produces: `getDownloadQueueDepth(): Promise<number>`.
- Produces: singleton `adminRequestTelemetry`; database health is probed live only for an authenticated snapshot request.

- [x] **Step 1: Write failing telemetry tests**

Cover a bounded 60-second window, search request counting, 5xx error rate, queue depth, truthful `unknown` external modules/providers, four metric cardinality, and parsing through `parseDashboardSnapshot`.

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @workspace/api-server test -- src/lib/admin-telemetry.test.ts`

Expected: FAIL because `admin-telemetry.ts` and queue depth export do not exist.

- [x] **Step 3: Implement the bounded tracker**

Store only method, normalized path, status code, and timestamp. Prune entries older than 60 seconds on every record/snapshot and cap the buffer at 10,000 records.

- [x] **Step 4: Implement the snapshot builder and queue depth adapter**

Build the eight-module/seven-edge topology expected by the admin UI, derive live API/search/download request rates, queue depth, and error rate, report PostgreSQL/Redis from injected readiness functions, and report unprobed providers as `unknown`.

- [x] **Step 5: Verify GREEN**

Run: `pnpm --filter @workspace/api-server test -- src/lib/admin-telemetry.test.ts && pnpm --filter @workspace/api-server typecheck`

Expected: telemetry tests pass and TypeScript exits `0`.

### Task 3: Authenticated Admin Dashboard Route

**Files:**
- Create: `artifacts/api-server/src/routes/admin.test.ts`
- Create: `artifacts/api-server/src/routes/admin.ts`
- Modify: `artifacts/api-server/src/routes/index.ts`
- Modify: `artifacts/api-server/src/app.ts`
- Modify: `artifacts/api-server/src/index.ts`

**Interfaces:**
- Produces: `createAdminRouter({ token, loadSnapshot })` for dependency-injected tests.
- Produces: `isDashboardTokenValid(provided, expected): boolean` using SHA-256 plus `timingSafeEqual`.
- Consumes: `createAdminDashboardSnapshot`, `adminRequestTelemetry`, and an authenticated live database probe.

- [x] **Step 1: Write failing real-HTTP route tests**

Start an ephemeral Express server and assert: missing/invalid header returns `401`; absent configured token returns `503`; valid token returns `200`, `Cache-Control: no-store`, and a payload accepted by the shared parser; a builder failure returns sanitized `503`.

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @workspace/api-server test -- src/routes/admin.test.ts`

Expected: FAIL because the admin router does not exist.

- [x] **Step 3: Implement constant-time authentication and route behavior**

Hash both supplied and expected values with SHA-256 before `timingSafeEqual`; reject empty values; validate the snapshot immediately before `res.json`; return only stable error codes.

- [x] **Step 4: Wire request observation and database readiness**

Record response completion without bodies or query strings in `app.ts`. Probe PostgreSQL live with a bounded query only after successful admin authentication. Mount the route beneath the existing `/api` router.

- [x] **Step 5: Verify GREEN**

Run: `pnpm --filter @workspace/api-server test -- src/routes/admin.test.ts && pnpm --filter @workspace/api-server typecheck && pnpm --filter @workspace/api-server build`

Expected: route tests pass, typecheck exits `0`, and esbuild emits `dist/index.mjs`.

### Task 4: Container Contract And End-To-End Validation

**Files:**
- Create: `artifacts/api-server/src/admin-config-contract.test.ts`
- Modify: `docker-compose.yml`
- Modify: `artifacts/api-server/docker-compose.yml`
- Modify: `MODULES.md`
- Modify: `IMPLEMENTATION_STATUS.md`

**Interfaces:**
- Consumes: `ADMIN_DASHBOARD_TOKEN` and optional `APOLLO_API_VERSION` in the API container; `ADMIN_ACCESS_USER`/`ADMIN_ACCESS_PASSWORD` protect the admin nginx surface.
- Produces: same token forwarded server-side by the existing admin nginx container.

- [x] **Step 1: Write failing configuration contract tests**

Assert both Compose definitions pass `ADMIN_DASHBOARD_TOKEN` only to API/admin containers, the API Docker build includes `lib/admin-dashboard-contract`, and no browser build variable or hard-coded token is introduced.

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @workspace/api-server test -- src/admin-config-contract.test.ts`

Expected: FAIL until Compose and Docker inputs include the shared contract/token wiring.

- [x] **Step 3: Update container configuration and project documentation**

Use `${ADMIN_DASHBOARD_TOKEN:-}` so an unconfigured backend starts disabled. Require operator Basic Auth at nginx, rate-limit probes, and bind the local Compose admin port to loopback. Document the current in-process telemetry boundary and future independent module telemetry adapter as not yet deployed.

- [x] **Step 4: Run complete verification**

Run: `pnpm --filter @workspace/admin-dashboard-contract test && pnpm --filter @workspace/api-server test -- --reporter=dot && pnpm --filter @workspace/admin-dashboard test -- --reporter=dot && pnpm run typecheck && pnpm --filter @workspace/api-server build && pnpm --filter @workspace/admin-dashboard build && docker compose config`

Expected: all tests/typechecks/builds pass; Compose renders without exposing a literal credential; no HomeNode or Coolify changes occur.

- [ ] **Step 5: Independent review and publication checkpoint**

Request read-only review for auth, secret handling, contract drift, bounded memory, and container wiring. Fix all Critical/Important findings, rerun complete verification, commit to `codex/feat/admin-telemetry-api`, push the feature branch, and leave merge to `main` only after the stage is reviewed.
