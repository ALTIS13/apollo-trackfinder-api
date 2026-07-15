# Admin Thin Connector Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace thick status-colored topology cables with thin neutral routes, fine parallel status lanes, and more expressive existing plug contacts.

**Architecture:** Preserve `buildConnectorGeometry` as the single source of route coordinates. `FlowingEdge` renders a neutral structural path for every physical segment and a deterministic list of fine status lanes, while the existing contact groups retain all connection, incident, and drag semantics.

**Tech Stack:** React 19, TypeScript, SVG, Framer Motion, Vitest, React Testing Library, React Flow.

## Global Constraints

- Structural route color is `#596273` and width is `1.75` topology units.
- Each status lane is opaque, width `1`, and uses fixed status ordering.
- Plug geometry, contact gaps, diagnostics, dragging, reset layout, and keyboard behavior do not change.
- No new dependency or generated asset is required.
- HomeNode/Coolify/Caddy/UFW/domain configuration is not touched.

---

### Task 1: Thin conductor renderer

**Files:**
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx`
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.tsx`
- Modify: `artifacts/admin-dashboard/src/index.css`

**Interfaces:**
- Consumes: existing `FlowingEdgeData.status`, `sharedStatuses`, `renderSharedTrunk`, and `buildConnectorGeometry()` output.
- Produces: `.topology-edge-conductor-base`, `.topology-edge-status-lane`, and enhanced existing plug classes without changing exported TypeScript interfaces.

- [ ] **Step 1: Write failing renderer tests**

Assert that both route segments use `stroke: #596273` and `stroke-width: 1.75`; healthy, warning, and degraded produce one status lane per segment with `stroke-width: 1`; a shared trunk produces one neutral base and three ordered lanes at `-1`, `0`, and `1`; contact rails retain status fills and expose outline/highlight elements.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --dir artifacts/admin-dashboard exec vitest run src/components/FlowingEdge.test.tsx --reporter=dot`

Expected: FAIL because the renderer still uses two six-unit status-colored conductors and the shared trunk still uses a six-unit green base.

- [ ] **Step 3: Implement the minimal renderer change**

Add constants for neutral route color/width and status-lane width. Render each physical segment as a neutral base plus an opaque centered status lane. Render the shared trunk once as a neutral base plus the unique ordered status lanes. Add a dark outline and inner highlight to both existing plug paths through SVG classes; keep geometry and events unchanged.

- [ ] **Step 4: Run focused GREEN and connector regression**

Run: `pnpm --dir artifacts/admin-dashboard exec vitest run src/components/FlowingEdge.test.tsx src/lib/topology-connector-geometry.test.ts src/components/TopologyPanel.test.tsx src/components/ServiceNode.test.tsx --reporter=dot`

Expected: all selected tests pass and no geometry assertion changes.

- [ ] **Step 5: Commit the implementation**

```bash
git add -- artifacts/admin-dashboard/src/components/FlowingEdge.tsx artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx artifacts/admin-dashboard/src/index.css docs/superpowers/specs/2026-07-15-admin-thin-connector-lines-design.md docs/superpowers/plans/2026-07-15-admin-thin-connector-lines.md
git commit -m "fix(admin): refine topology connector lines"
```

### Task 2: Review, rendered QA, and publication status

**Files:**
- Modify: `IMPLEMENTATION_STATUS.md`

**Interfaces:**
- Consumes: Task 1 rendered connector classes and current demo topology.
- Produces: reproducible validation evidence and publication record.

- [ ] **Step 1: Run complete automated validation**

Run:

```bash
pnpm --dir artifacts/admin-dashboard test -- --reporter=dot
pnpm --dir artifacts/admin-dashboard typecheck
pnpm --dir artifacts/admin-dashboard build
pnpm run typecheck
git diff --check
```

Expected: all admin tests, both typechecks, production build, and diff check pass.

- [ ] **Step 2: Perform Codex in-app browser QA**

The flow under test is: `#topology` loads -> thin neutral routes and separate status lanes render -> Download Worker and Account Integrations drag with attached contacts -> reset restores layout -> `DLW-E502` opens its incident journal.

Check desktop and `390x844`, console warning/error logs, status badges, line/contact continuity, module overlap, and reduced motion.

- [ ] **Step 3: Record exact evidence**

Append exact test counts, browser viewport evidence, review result, and confirmation that infrastructure was untouched to `IMPLEMENTATION_STATUS.md`.

- [ ] **Step 4: Commit status, push feature, merge and revalidate main**

```bash
git add -- IMPLEMENTATION_STATUS.md
git commit -m "docs(status): record thin connector validation"
git push -u origin codex/fix/admin-thin-connector-lines
```

Fast-forward into an up-to-date `main` only after task review and whole-branch review approve the change. Repeat full automated validation on merged `main`, then push `main`.
