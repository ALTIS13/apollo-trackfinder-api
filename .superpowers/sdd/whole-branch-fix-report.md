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
- `git diff --check` -- exit `0`.
- `git diff --cached --check` -- exit `0` after force-staging the ignored report.
