# Whole-Branch Fix Report

## Scope

- Branch: `codex/feat/admin-draggable-connectors`
- Pre-fix HEAD: `5311604`
- Changed only the six production/test files authorized by the brief and this report.
- Did not change status documents, API/persistence code, HomeNode, Coolify, browser storage, or unrelated files.
- No browser automation or dev server was run.

## Root Cause And Fix

`buildConnectorGeometry` previously decided shared-source eligibility per edge.
Only the final edge in a source group could render the trunk, so moving that
owner left could disable its trunk while its siblings still started 24 units
from the source terminal.

`TopologyPanel` now derives one clearance from the current controlled node
positions for each source group. The calculation uses the source handle X
(`node.x + width`), each target handle X (`node.x`), contact dimensions, and
the smooth-step bend radius. It clamps the shared branch length to 24 units,
uses the shortened positive clearance for every group edge, and uses zero for
the entire group when no trunk fits. That explicit length flows through edge
data to pure geometry; only the designated edge paints the trunk.

## TDD Evidence

### RED

1. `pnpm vitest run src/lib/topology-connector-geometry.test.ts` -- exit `1`.
   The required short-clearance owner/sibling regression had 1 failed and 2
   passed tests: expected shared branch origins `[1, 1]`, received `[0, 24]`.
2. `pnpm vitest run src/components/TopologyPanel.test.tsx -t "keeps every shared Core API branch"` -- exit `1`.
   1 failed and 8 skipped tests: no group branch length was supplied after
   moving Download Worker to `{ x: 545.936, y: 140 }`.
3. `pnpm vitest run src/components/FlowingEdge.test.tsx -t "uses the group branch length"` -- exit `1`.
   1 failed and 24 skipped tests: an explicit one-unit edge-data length still
   rendered a branch beginning `M24 0`.

### GREEN

1. `pnpm vitest run src/lib/topology-connector-geometry.test.ts` -- exit `0`; 3 passed immediately after the minimal geometry implementation.
2. `pnpm vitest run src/lib/topology-connector-geometry.test.ts src/components/FlowingEdge.test.tsx src/components/TopologyPanel.test.tsx` -- exit `0`; 40 passed from the final source state.

The focused GREEN suite covers the shortened 6.436-unit Core API trunk after
the documented Download Worker drag, a disabled zero-clearance trunk with all
branches returning to the source terminal, the explicit edge-data handoff,
warning/degraded female and male contact path coordinates, and unmount/remount
session-only positions.

## Final Validation

- `pnpm test` in `artifacts/admin-dashboard` -- exit `0`; 11 files and 112 tests passed.
- `pnpm typecheck` in `artifacts/admin-dashboard` -- exit `0`.
- `pnpm run typecheck` at repository root -- exit `0`; libraries and all six filtered artifact/script projects typechecked.
- `pnpm build` in `artifacts/admin-dashboard` -- exit `0`; Vite transformed 2556 modules and built the production bundle.
- `git diff --check` -- exit `0` after the follow-up report append.
- `git diff --check` -- exit `0`.
- `git diff --cached --check` -- exit `0` after force-staging the ignored report.

---

## Short-Span Contact Gap Follow-Up

### Scope

- Pre-follow-up HEAD: `b43f711`
- Changed only `topology-connector-geometry.ts`, its test, and this existing report.
- No browser automation or dev server was run. No status, API, persistence,
  HomeNode, Coolify, layout, styling, or infrastructure files were changed.

### Root Cause And Fix

The group-wide branch length can leave a same-row source path only 2.5 units
from the female outer edge. Passing the fixed 12-unit smooth-step offset to
that span generated forward and backward control coordinates outside the
physical conductor interval.

Same-row right-to-left routes now use one direct horizontal `L` segment from
the branch origin to the female outer edge. Multi-row routes retain the
existing rounded `getSmoothStepPath` implementation. This also keeps a
zero-clearance crossed target bounded at its no-trunk fallback.

### TDD Evidence

#### RED

1. `pnpm vitest run src/lib/topology-connector-geometry.test.ts` -- exit `1`.
   The short-span path-bounds regression had 1 failed and 4 passed tests:
   coordinate `517.142` exceeded the female boundary `507.64200000000005`.
2. `pnpm vitest run src/lib/topology-connector-geometry.test.ts -t "zero-clearance crossed target"` -- exit `1`.
   1 failed and 5 skipped tests: coordinate `500` exceeded the source bound
   `488` for the crossed no-trunk fallback.

#### GREEN

1. `pnpm vitest run src/lib/topology-connector-geometry.test.ts` -- exit `0`; 6 passed after the direct same-row implementation.
2. `pnpm vitest run src/lib/topology-connector-geometry.test.ts src/components/FlowingEdge.test.tsx src/components/TopologyPanel.test.tsx` -- exit `0`; 3 files and 42 tests passed from the final source state.

The new geometry coverage parses all absolute source-path X coordinates and
asserts that they stay in the closed branch-origin/female-outer interval for
the 2.5-unit same-row route and the zero-clearance crossed target. The normal
multi-row regression continues to require a rounded `Q` segment.

### Final Validation

- `pnpm test` in `artifacts/admin-dashboard` -- exit `0`; 11 files and 114 tests passed.
- `pnpm typecheck` in `artifacts/admin-dashboard` -- exit `0`.
- `pnpm run typecheck` at repository root -- exit `0`; libraries and all six filtered artifact/script projects typechecked.
- `pnpm build` in `artifacts/admin-dashboard` -- exit `0`; Vite transformed 2556 modules and built the production bundle.
