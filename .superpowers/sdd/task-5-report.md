# Task 5 Report: Apollo TF Admin Topology Dashboard

## Status

DONE_WITH_CONCERNS

## Files Changed

- `IMPLEMENTATION_STATUS.md`
- `MODULES.md`
- `docs/superpowers/plans/2026-07-14-admin-topology-dashboard.md`
- `.superpowers/sdd/task-5-report.md`

## Commit

`1d241df6ba064bb04a6d4437e8a398e4631107f7` (`docs(admin): record topology dashboard checkpoint`)

## Verification

- `pnpm --filter @workspace/admin-dashboard test` -- passed, 8 files / 41 tests.
- `pnpm --filter @workspace/admin-dashboard typecheck` -- passed.
- `pnpm --filter @workspace/admin-dashboard build` -- passed.
- `pnpm run typecheck` -- passed for the full workspace.
- Fresh local Docker build `apollo-tf-admin:verify` -- passed; disposable container returned `200` / `ok` from `/healthz` and was removed. Docker image, Compose configuration, and Coolify readiness were validated locally; no deployment to Coolify or HomeNode occurred.
- Codex in-app browser desktop QA at `1536x1090` -- page identity, meaningful content, console, interactions, and page-level overflow checks passed.
- Codex in-app browser mobile QA at `390x844` -- metrics-first layout, internal topology scroller, incident/deployment flow, and page-level overflow checks passed.
- Interaction path -- service focus, incident-to-service focus, acknowledgement, dashboard refresh persistence, all/open filters, and command refresh passed.
- Reduced motion -- normal mode rendered seven traffic packet paths; emulated `prefers-reduced-motion: reduce` rendered zero packet paths while retaining eight status dots.
- `git diff --check` -- passed for the checkpoint files.

## Concept fidelity comparison

Compared captures (local evidence only; screenshot binaries are not committed):

- Concept 2: `C:\Users\maksi\.codex\generated_images\019ef2c2-95cb-7d01-9951-aa0abfe25d37\exec-37cf8f7e-5782-4788-b291-4e730547aec4.png`
- Concept 1: `C:\Users\maksi\.codex\generated_images\019ef2c2-95cb-7d01-9951-aa0abfe25d37\exec-4bfeca2b-6ba7-41d7-9492-bcc4cdeebab2.png`
- Implementation: `C:\Users\maksi\AppData\Local\Temp\apollo-admin-desktop.png`

Native comparison mapping recorded during QA: concept target `1536x1090` -> implementation desktop browser viewport `1536x1090` (1:1 mapping). For audit clarity, the persisted PNG files currently decode to `1487x1058` for each generated concept and `1521x1079` for the implementation; those are the evidence-file dimensions, while `1536x1090` is the logged concept/viewport mapping and is not presented as the encoded PNG size.

### Mismatch/resolution ledger

| Observed mismatch | Resolution in implementation | Disposition |
| --- | --- | --- |
| Concept 2 has the topology and incident rail but no four-metric summary. | Added concept 1's active modules, searches/minute, queue depth, and error-rate metrics above the topology. | Resolved; concept 2 remains the structural baseline. |
| Concept 1 centers a throughput chart instead of a service topology. | Replaced the chart as the primary surface with concept 2's stable left-to-right React Flow topology. | Resolved; topology is the largest desktop workspace. |
| Concept 2 shows a persistent event stream, while the product requires actionable incident filtering and acknowledgement. | Kept the desktop incident rail and added all/open filters and service focus. Demo mode supports local acknowledgement; remote mode is explicitly read-only and does not imply backend acceptance. | Resolved and interaction-tested. |
| Concept 2 uses hand-positioned topology cards; production data requires deterministic layout and focus behavior. | Dagre computes stable left-to-right layers, React Flow owns pan/zoom/focus, and the topology alone scrolls horizontally on portrait. | Resolved; data-driven placement intentionally differs from exact concept coordinates. |
| Concept 2's command bar includes date/deployment controls that have no current backend contract. | Retained environment, last-update/timezone, and refresh controls; did not fake date/deployment actions before telemetry/API exists. | Intentional product-safe deviation; backend telemetry/API remains next-stage work. |
| The references keep deployment/provider data dense and visible below the topology. | Implemented compact semantic tables with version, update, health, latency, trend, and timestamp information visible without hover. | Resolved; no nested cards or oversized table typography. |
| Reference status is strongly color-coded. | Preserved near-black/charcoal/violet styling while adding text labels, icons, edge dash patterns, and reduced-motion-safe status dots. | Resolved; status does not rely on color or animation alone. |

## Concerns

- Backend telemetry/API for `GET /api/admin/dashboard` remains required for production data.
- Owner visual approval remains required before merge to `main`; the implementation stays on `codex/feat/admin-topology-dashboard` until that review.

## Final Review Hardening

### Status

DONE_WITH_CONCERNS

### Findings addressed

1. Forced `dagre` and `graphlib` production paths to patched `lodash@4.18.1`; parsed admin audit paths are zero while unrelated API/Expo advisories remain outside scope.
2. Added typed adapter mode/capabilities and correct remote bootstrap transitions: unverified refreshing fallback, offline before first success, live after validated data, stale only after later failure.
3. Restricted local acknowledgement to demo mode and made remote incidents explicitly/accessibly read-only.
4. Added bounded Zod validation for every snapshot field/enum/timestamp, unique service/incident IDs, and valid edge/incident service references before state mutation.
5. Added a 10-second abort timeout and single-flight refresh across manual and interval triggers.
6. Replaced the build-time cross-origin URL with same-origin `/api/admin/dashboard`; nginx receives runtime `APOLLO_API_UPSTREAM`/`ADMIN_DASHBOARD_TOKEN` and forwards `X-Admin-Dashboard-Token` without exposing it to the browser.
7. Corrected refresh-accent and subtle-text contrast with deterministic WCAG calculations.

### Verification and remaining work

Exact RED/GREEN and final command evidence is recorded in `.superpowers/sdd/final-review-fix-report.md`. Backend telemetry plus validation of the forwarded token are still required, and owner approval remains required before merge. No Coolify/HomeNode deployment occurred.

## Review Fix

### Status

DONE_WITH_CONCERNS

### Findings addressed

1. Added the three exact local capture paths, the concept/implementation `1536x1090` native mapping, decoded capture dimensions, and an auditable mismatch/resolution ledger; no screenshot binaries were added.
2. Replaced Coolify delivery claims with local Docker image/Compose/Coolify-readiness validation and explicitly recorded that no Coolify/HomeNode deployment occurred.
3. Updated the project tree and deployment documentation so the root compose consistently contains PostgreSQL, API, and admin service; the nested API compose remains documented as PostgreSQL + API only.
4. Recast the `origin/main` equality as a historical baseline and recorded current feature-branch containment plus the clean pre-fix `HEAD`.
5. Renumbered database subsections to `5.1` and `5.2`.

### Verification

`git diff --check -- IMPLEMENTATION_STATUS.md MODULES.md docs/superpowers/plans/2026-07-14-admin-topology-dashboard.md .superpowers/sdd/task-5-report.md` -- passed with exit code `0` and no whitespace errors.
