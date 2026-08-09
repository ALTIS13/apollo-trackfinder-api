# Apollo TF Admin And Parser Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default demo-track rejection and expose live parser, account, and connected-service state through the existing containerized admin dashboard boundary.

**Architecture:** `tf-search` filters incomplete media and emits bounded parser telemetry through signed heartbeats. `platform-api` and `tf-integrations` expose signed read-only summaries; `tf-api` joins them into one strict snapshot consumed by `admin-dashboard`. Browser code never calls internal containers directly.

**Tech Stack:** TypeScript, Zod, Express, PostgreSQL, React 19, Vitest, signed module-runtime HMAC

## Global Constraints

- Preserve independent `tf-search`, `tf-integrations`, `platform-api`, `tf-api`, and admin-dashboard containers.
- Do not expose provider tokens, session digests, password data, service secrets, or direct database access to the browser.
- Keep the existing topology implementation and interaction behavior unchanged.
- Add no GitHub Actions, billing code, Android work, or consumer-player redesign.
- Run only package-local tests for changed behavior; do not run the full workspace suite.
- Do not mutate HomeNode, Coolify, Caddy, UFW, DNS, Docker resources, or existing remote services.

---

### Task 1: Reject Demo And Preview Tracks

**Files:**
- Create: `artifacts/tf-search/src/media-completeness.ts`
- Create: `artifacts/tf-search/src/media-completeness.test.ts`
- Modify: `artifacts/tf-search/src/search-service.ts`
- Modify: `artifacts/tf-search/src/search-service.test.ts`

**Interfaces:**
- Produces: `assessMediaCompleteness(track, referenceDuration): MediaCompletenessAssessment`
- Produces: `filterCompleteMedia(tracks): { accepted; rejected }`
- Extends: `SearchService.telemetry()` with per-source rolling parser counters.

- [x] Write one table-driven test covering explicit preview URL, title marker, duration outlier, and a normal full track.
- [x] Run only `media-completeness.test.ts` and verify RED because the module is absent.
- [x] Implement categorical reasons `provider_preview_url`, `title_marker`, and `duration_outlier`; compute the reference median from non-explicit-preview original tracks.
- [x] Apply the filter before ranking and cache writes in search and artist discovery, then record rejected counts by source.
- [x] Add one search-service integration assertion that rejected results never reach the response and telemetry counts them.
- [x] Run only the two touched test files and `@workspace/tf-search` typecheck.

### Task 2: Transport Parser Telemetry To The Admin Snapshot

**Files:**
- Modify: `lib/module-runtime-contract/src/index.ts`
- Modify: `lib/module-runtime-contract/src/index.test.ts`
- Modify: `artifacts/tf-search/src/heartbeat.ts`
- Modify: `artifacts/tf-search/src/heartbeat.test.ts`
- Modify: `artifacts/api-server/src/lib/module-heartbeat.ts`
- Modify: `artifacts/api-server/src/lib/module-heartbeat.test.ts`
- Modify: `lib/admin-dashboard-contract/src/index.ts`
- Modify: `lib/admin-dashboard-contract/src/index.test.ts`
- Modify: `artifacts/api-server/src/lib/admin-telemetry.ts`
- Modify: `artifacts/api-server/src/lib/admin-telemetry.test.ts`

**Interfaces:**
- Extends heartbeat payload with optional bounded `parsers` entries.
- Adds required `parsers` array to `DashboardSnapshot`.
- Keeps heartbeat `schemaVersion: 1` because the field is backward-compatible and optional on ingest.

- [ ] Add one contract test that accepts four unique bounded parser entries and rejects duplicates or negative counters.
- [ ] Thread accepted parser telemetry through heartbeat storage and snapshot observations.
- [ ] Map `search-media` heartbeat parser entries into the dashboard snapshot; absent telemetry yields four `unknown` parser rows.
- [ ] Run only the changed contract, heartbeat, and admin-telemetry test files plus their package typechecks.

### Task 3: Render Live Parser State

**Files:**
- Create: `artifacts/admin-dashboard/src/components/ParserTable.tsx`
- Modify: `artifacts/admin-dashboard/src/App.tsx`
- Modify: `artifacts/admin-dashboard/src/components/AdminSidebar.tsx`
- Modify: `artifacts/admin-dashboard/src/data/demo-snapshot.ts`
- Modify: `artifacts/admin-dashboard/src/index.css`
- Modify: `artifacts/admin-dashboard/src/App.test.tsx`

**Interfaces:**
- Consumes: `snapshot.parsers` from Task 2.

- [ ] Add one component-level assertion that the parser section renders status, version, requests, failures, and demo rejection values from the snapshot.
- [ ] Add the `Парсеры` navigation target and table without changing topology geometry or incident behavior.
- [ ] Run only `App.test.tsx`, admin-dashboard typecheck, and build.

### Task 4: Read-Only Account And Connection Overview

**Files:**
- Modify: `artifacts/platform-api/src/domain/repository.ts`
- Modify: `artifacts/platform-api/src/domain/postgres-repository.ts`
- Create: `artifacts/platform-api/src/domain/admin-overview.ts`
- Create: `artifacts/platform-api/src/routes/internal-admin.ts`
- Modify: `lib/tf-integrations-db/src/repository.ts`
- Create: `artifacts/tf-integrations/src/admin-overview.ts`
- Modify: `artifacts/tf-integrations/src/app.ts`
- Create: `artifacts/api-server/src/lib/admin-account-overview-client.ts`
- Modify: `lib/admin-dashboard-contract/src/index.ts`
- Modify: `artifacts/api-server/src/routes/admin.ts`
- Modify: `artifacts/admin-dashboard/src/App.tsx`
- Create: `artifacts/admin-dashboard/src/components/AccountsTable.tsx`

**Interfaces:**
- Platform overview returns at most 100 recent accounts and 15-minute activity counts.
- Integrations overview accepts at most 100 canonical account IDs and returns only provider, display name, and updated timestamp.
- Dashboard snapshot adds `accountSummary` and `accounts` with bounded strict schemas.

- [ ] Add one repository test for active-session aggregation and one integrations test for bounded account-ID lookup.
- [ ] Add signed internal endpoints using existing module-runtime canonical request signatures.
- [ ] Add one tf-api aggregation test proving unavailable integrations degrade connection fields without losing account rows.
- [ ] Render the `Пользователи` section and compact summary without exposing secrets or provider user IDs.
- [ ] Run only the touched Platform, Integrations, API, contract, and dashboard tests plus package typechecks/builds.

### Task 5: Final Selective Validation And Publication

- [ ] Run focused tests named in Tasks 1-4, package-local typechecks, and builds.
- [ ] Run one local admin-dashboard desktop visual smoke-check without touching remote infrastructure.
- [ ] Inspect `git diff --check`, commit logical slices, push the feature branch, and update the existing implementation-status document with exact commit IDs and deferred player work.
