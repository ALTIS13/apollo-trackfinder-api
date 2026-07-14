# Admin Edge Connector Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace topology traffic callouts with physical connector states that open the exact linked incident and sanitized journal evidence.

**Architecture:** `ServiceEdge.incidentId` links a topology edge to an `Incident`; optional `Incident.diagnostic` owns the error code, operator-facing message, timestamp, and bounded journal excerpt. `TopologyPanel` resolves that relation once per snapshot and passes a narrow diagnostic object to `FlowingEdge`. `App` owns the selected incident so a connector click can focus the related service and expand the matching row in `IncidentRail`.

**Tech Stack:** React 19, TypeScript, React Flow, Framer Motion, Zod, Vitest, Testing Library, Vite.

## Global Constraints

- Keep the dashboard isolated in `artifacts/admin-dashboard`.
- Never invent an error code when the incident payload does not provide one.
- Degraded connections must have a visible physical gap and no traffic animation across it.
- `prefers-reduced-motion` and hidden documents disable flicker and connector transitions while preserving status evidence.
- Journal excerpts are optional, schema-bounded, and treated as sanitized backend output.

---

### Task 1: Diagnostic Data Contract

**Files:**
- Modify: `artifacts/admin-dashboard/src/types/dashboard.ts`
- Modify: `artifacts/admin-dashboard/src/data/dashboard-snapshot-schema.ts`
- Modify: `artifacts/admin-dashboard/src/data/demo-snapshot.ts`
- Test: `artifacts/admin-dashboard/src/data/http-snapshot-adapter.test.ts`

**Interfaces:**
- Produces: `IncidentDiagnostic { code?: string; message: string; observedAt: string; logExcerpt?: string }`.
- Produces: optional `ServiceEdge.incidentId` and `Incident.diagnostic`.

- [x] **Step 1: Write failing schema tests**

Add cases proving an unknown `edge.incidentId` is rejected and a valid bounded diagnostic is accepted without requiring a code.

- [x] **Step 2: Run the focused test**

Run: `pnpm --filter @workspace/admin-dashboard test -- src/data/http-snapshot-adapter.test.ts`

Expected: FAIL because the strict schemas do not accept `incidentId` or `diagnostic`.

- [x] **Step 3: Implement the typed and validated relation**

Add the interfaces above, schema limits of 64 characters for `code`, 512 for `message`, 2048 for `logExcerpt`, and an edge-to-incident referential check.

- [x] **Step 4: Add deterministic demo evidence and rerun**

Link the warning search edge to `SC-429` and both degraded download edges to `DLW-E502`, then rerun the focused test until it passes.

### Task 2: Physical Connector Edge

**Files:**
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx`
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.tsx`
- Modify: `artifacts/admin-dashboard/src/components/TopologyPanel.tsx`
- Modify: `artifacts/admin-dashboard/src/index.css`

**Interfaces:**
- Consumes: `FlowingEdgeData.diagnostic?: { incidentId: string; code?: string; message: string }`.
- Produces: `TopologyPanelProps.onOpenIncident?: (incidentId: string) => void`.

- [x] **Step 1: Replace rejected callout tests with connector-state tests**

Assert `data-state=connected|unstable|disconnected|unknown`, a physical path mask, visible `WARNING`/`ERROR` evidence, optional error code rendering, keyboard activation, and no warning flicker when motion is disabled.

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @workspace/admin-dashboard test -- src/components/FlowingEdge.test.tsx`

Expected: FAIL because the current edge still renders callouts and phase pulses.

- [x] **Step 3: Implement connector geometry and state behavior**

Mask the base path beneath the midpoint contact, render straight female/male connector rails with fixed outer endpoints, place traffic below them, animate only warning flicker, and expose click/Enter/Space on the React Flow edge wrapper only when an incident link exists.

- [x] **Step 4: Verify GREEN**

Run the focused test and confirm all connector-state assertions pass.

### Task 3: Incident Journal Interaction

**Files:**
- Modify: `artifacts/admin-dashboard/src/App.tsx`
- Modify: `artifacts/admin-dashboard/src/App.test.tsx`
- Modify: `artifacts/admin-dashboard/src/components/IncidentRail.tsx`
- Modify: `artifacts/admin-dashboard/src/index.css`

**Interfaces:**
- Consumes: `selectedIncidentId?: string` and `onOpenIncident(incidentId?: string)`.
- Produces: one expanded incident row with code, timestamp, message, and optional journal excerpt.

- [x] **Step 1: Write the failing end-to-end component test**

Click the disconnected `DLW-E502` contact, assert `Download Worker` is focused, and assert the incident rail reveals the code and journal excerpt. Add a no-code diagnostic case proving the UI does not invent a code.

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @workspace/admin-dashboard test -- src/App.test.tsx`

Expected: FAIL because connector-to-incident selection and journal details do not exist.

- [x] **Step 3: Implement selected incident state and expandable evidence**

Keep selected incident state in `App`, pass the open action into both topology and rail, scroll the selected incident into view with reduced-motion-aware behavior, and render bounded diagnostic fields semantically.

- [x] **Step 4: Run full verification and browser QA**

Run: `pnpm --filter @workspace/admin-dashboard test && pnpm --filter @workspace/admin-dashboard typecheck && pnpm --filter @workspace/admin-dashboard build`

Expected: all tests pass, typecheck exits `0`, and Vite builds successfully. Then verify desktop, `390x844`, reduced motion, keyboard activation, connector-to-journal focus, console health, and screenshot fidelity in the in-app browser.
