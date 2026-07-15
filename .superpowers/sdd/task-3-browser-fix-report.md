# Task 3 Browser Drag Warning Fix Report

## Root Cause And Fix

Controlled service nodes were regenerated after each session-only position
override with `width` and `height`, but without `measured`. React Flow therefore
lost its initialized dimensions on the first controlled drag update. Each
derived service node now also carries the same DAGRE dimensions in `measured`.

## TDD Evidence

- RED: `pnpm vitest run src/components/TopologyPanel.test.tsx` exited 1. The
  new consecutive-position-update regression test reported:
  `expected undefined to deeply equal { width: 190, height: 76 }`.
- GREEN: the same focused command passed: 1 file, 8 tests.

## Verification

- `pnpm test` in `artifacts/admin-dashboard`: passed, 11 files and 106 tests.
- `pnpm typecheck` in `artifacts/admin-dashboard`: passed.
- `pnpm typecheck` at the worktree root: passed.
- `git diff --check`: passed with no whitespace errors.

## Changed Files

- `artifacts/admin-dashboard/src/components/TopologyPanel.tsx`
- `artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx`
- `.superpowers/sdd/task-3-browser-fix-report.md`
