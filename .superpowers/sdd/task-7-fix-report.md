# Task 7 Fix Report

## Files changed

- `artifacts/admin-dashboard/src/lib/topology-connector-geometry.ts`
- `artifacts/admin-dashboard/src/lib/topology-connector-geometry.test.ts`
- `artifacts/admin-dashboard/src/lib/topology-evidence-layout.ts`
- `artifacts/admin-dashboard/src/lib/topology-evidence-layout.test.ts`
- `artifacts/admin-dashboard/src/components/FlowingEdge.tsx`
- `artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx`
- `artifacts/admin-dashboard/src/components/TopologyPanel.tsx`
- `artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx`
- `.superpowers/sdd/task-7-fix-report.md`

## Root cause and fix

- Grouped off-row routes always used a 28-unit horizontal first leg. That leg both starved the default Core-to-Search target approach and let every solid status lane repaint the same geometry after the gradient. Grouped off-row routes now diverge vertically at the shared branch endpoint, while ungrouped normal routes reserve the full bend, plug, and terminal approach before falling back to a detour.
- Keyboard alignment preserved the node's modulo-24 phase unconditionally. Free-mode moves are now tracked explicitly: toggling modes does not move the node, the first non-Alt aligned arrow move enters the absolute grid, generated-layout nodes retain the existing 24-unit stepping contract, and Alt remains zoom-aware and unsnapped.
- Fit bounds only unioned module and evidence-label rectangles. The panel now builds canonical geometry for every edge and unions route stroke, plug hit/body, below-plug traffic, and above-plug evidence rectangles through `getConnectorVisualRects` and `getTopologyVisualBounds`.
- Gradient IDs depended on React `useId`. IDs are now deterministic, collision-resistant encodings of edge IDs, so identity and opaque semantic stops remain stable across reordered rerenders.

## RED evidence

### Routing and shared paint ownership

Command:

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/lib/topology-connector-geometry.test.ts src/components/FlowingEdge.test.tsx -t "keeps the default grouped|diverges grouped off-row|gives default grouped"
```

Result: 2 test files failed; 3 tests failed and 43 were skipped.

- Default grouped Core-to-Search route: `expected true to be false` for `usedDetour`.
- Zero-clearance grouped branch: expected second point `{ x: 0, y: -80 }`, received `{ x: 28, y: 0 }`.
- Rendered status ownership: expected vertical divergence from `M562.5 194`; received duplicate off-row paths `M562.5 194 L656 194` and same-row `M562.5 194 L598 194`.

### Alignment transition

Command:

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/components/TopologyPanel.test.tsx -t "snaps the first aligned arrow move"
```

Result: 1 test file failed; 1 test failed and 21 were skipped. Assertion: expected `264`, received `262`.

### Fit bounds

Command:

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/lib/topology-evidence-layout.test.ts src/components/TopologyPanel.test.tsx -t "includes reverse route|fits an updated reverse route"
```

Result: 2 test files failed; 2 tests failed and 26 were skipped.

- Pure helper: `TypeError: getConnectorVisualRects is not a function`.
- Manual fit: expected right bound to be at least route maximum `326`; received `214`.

### Gradient stability

Command:

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/components/FlowingEdge.test.tsx -t "keeps gradient identity"
```

Result: 1 test file failed; 1 test failed and 31 were skipped. Assertion: expected `topology-gradient-stable-owner`, received React-generated `-r0--stable-owner`.

## GREEN evidence

Targeted regression reruns:

- Routing/shared paint: 2 files passed; 3 tests passed, 43 skipped.
- Alignment transition: 1 file passed; 1 test passed, 21 skipped.
- Fit bounds: 2 files passed; 2 tests passed, 26 skipped.
- Gradient stability: 1 file passed; 1 test passed, 31 skipped.
- Generated-position compatibility plus off-grid transition: 1 file passed; 2 tests passed, 20 skipped.

Required focused command:

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/lib/topology-connector-geometry.test.ts src/lib/topology-evidence-layout.test.ts src/lib/topology-shared-routes.test.ts src/lib/topology-status-gradient.test.ts src/components/FlowingEdge.test.tsx src/components/TopologyPanel.test.tsx
```

Result: 6 files passed; 96 tests passed.

Full admin tests:

```powershell
pnpm --dir artifacts/admin-dashboard test
```

Result: 15 files passed; 181 tests passed.

Admin typecheck:

```powershell
pnpm --dir artifacts/admin-dashboard typecheck
```

Result: exit 0, no TypeScript errors.

Whitespace validation:

```powershell
git diff --check
```

Result: exit 0, no output.

## Commit

- Implementation: `94bcedf506db6d279a7b92c8903481088b556f54` (`fix(admin): keep shared topology routes inside corridor`)

## Concerns

None. No dependency, server, API, database, infrastructure, client, Android, generated status, or credential changes were made.
