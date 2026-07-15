# Admin Draggable Unified Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace overlapping topology edges with one opaque conductor/contact chain and add session-only module dragging with automatic route updates and layout reset.

**Architecture:** Move connector coordinates into a pure geometry module so route segments end exactly at plug boundaries and never continue beneath a warning/error gap. `FlowingEdge` renders one shared source trunk plus independent branch conductors, while `TopologyPanel` supplies shared-route and terminal status metadata. Session positions are maintained as an override map over dagre output and are discarded on reload or explicit reset.

**Tech Stack:** React 19, TypeScript, React Flow (`@xyflow/react`), Vitest, Testing Library, SVG, dagre, Vite.

## Global Constraints

- Structural conductor width is exactly `6` topology units across cable, plug body, and terminal junction.
- Status paint is opaque; do not use alpha blending or status dash arrays.
- Healthy uses a closed green contact; warning uses a `3`-unit contact offset; degraded uses a `7`-unit contact offset.
- Module positions are session-only and must not use API persistence, `localStorage`, HomeNode, or Coolify.
- Existing incident pointer/Enter/Space activation and `prefers-reduced-motion` behavior must remain intact.
- Do not add edge creation, deletion, or reconnection controls.

---

### Task 1: Pure Connector Geometry

**Files:**
- Create: `artifacts/admin-dashboard/src/lib/topology-connector-geometry.ts`
- Create: `artifacts/admin-dashboard/src/lib/topology-connector-geometry.test.ts`

**Interfaces:**
- Produces: `buildConnectorGeometry(input: ConnectorGeometryInput): ConnectorGeometry`.
- Produces fields: `sourcePath`, `targetStubPath`, `contactX`, `contactY`, `femaleOuterX`, `maleOuterX`, `branchSourceX`, and optional `sharedTrunkPath`.

- [ ] **Step 1: Write the failing geometry tests**

```ts
const geometry = buildConnectorGeometry({
  sourceX: 0,
  sourceY: 0,
  sourcePosition: Position.Right,
  targetX: 120,
  targetY: 80,
  targetPosition: Position.Left,
  sharedSource: false,
});

expect(geometry.contactX).toBe(92);
expect(geometry.femaleOuterX).toBe(76);
expect(geometry.maleOuterX).toBe(108);
expect(geometry.sourcePath).toMatch(/L76 80$/);
expect(geometry.targetStubPath).toBe("M 108 80 H 120");
```

Add a grouped-edge case with `sharedSource: true` that requires `sharedTrunkPath === "M 0 0 H 24"`, `branchSourceX === 24`, and `sourcePath` beginning at `M24 0`.

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run src/lib/topology-connector-geometry.test.ts`

Expected: FAIL because the geometry module does not exist.

- [ ] **Step 3: Implement the geometry module**

```ts
export const CONDUCTOR_WIDTH = 6;
export const CONTACT_HALF_LENGTH = 16;
export const TARGET_STUB_LENGTH = 12;
export const SHARED_TRUNK_LENGTH = 24;

export function buildConnectorGeometry(input: ConnectorGeometryInput): ConnectorGeometry {
  const contactX = input.targetX - CONTACT_HALF_LENGTH - TARGET_STUB_LENGTH;
  const femaleOuterX = contactX - CONTACT_HALF_LENGTH;
  const maleOuterX = contactX + CONTACT_HALF_LENGTH;
  const canShare =
    input.sharedSource &&
    input.sourcePosition === Position.Right &&
    input.targetPosition === Position.Left &&
    femaleOuterX > input.sourceX + SHARED_TRUNK_LENGTH + 7.5;
  const branchSourceX = canShare ? input.sourceX + SHARED_TRUNK_LENGTH : input.sourceX;
  const [sourcePath] = getSmoothStepPath({
    sourceX: branchSourceX,
    sourceY: input.sourceY,
    sourcePosition: input.sourcePosition,
    targetX: femaleOuterX,
    targetY: input.targetY,
    targetPosition: input.targetPosition,
    borderRadius: 7.5,
    offset: TARGET_STUB_LENGTH,
  });

  return {
    sourcePath,
    targetStubPath: `M ${maleOuterX} ${input.targetY} H ${input.targetX}`,
    contactX,
    contactY: input.targetY,
    femaleOuterX,
    maleOuterX,
    branchSourceX,
    sharedTrunkPath: canShare ? `M ${input.sourceX} ${input.sourceY} H ${branchSourceX}` : undefined,
  };
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run src/lib/topology-connector-geometry.test.ts`

Expected: 2 tests passed.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- artifacts/admin-dashboard/src/lib/topology-connector-geometry.ts artifacts/admin-dashboard/src/lib/topology-connector-geometry.test.ts
git commit -m "refactor(admin): isolate connector geometry"
```

---

### Task 2: Opaque Conductors, Contacts, Shared Lanes, And Terminals

**Files:**
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.tsx`
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx`
- Modify: `artifacts/admin-dashboard/src/components/TopologyPanel.tsx`
- Modify: `artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx`
- Modify: `artifacts/admin-dashboard/src/components/ServiceNode.tsx`
- Modify: `artifacts/admin-dashboard/src/components/ServiceNode.test.tsx`
- Modify: `artifacts/admin-dashboard/src/index.css`

**Interfaces:**
- Produces: `SharedSourceRoute { statuses: HealthStatus[]; renderTrunk: boolean }`.
- Produces: `getSharedSourceRoutes(edges: ServiceEdge[]): Map<string, SharedSourceRoute>`.
- Extends `ServiceNodeData` with `sourceStatuses` and `targetStatuses`.
- Consumes `buildConnectorGeometry` and `CONDUCTOR_WIDTH` from Task 1.

- [ ] **Step 1: Write failing unified-conductor tests**

```ts
it.each([
  ["healthy", "#22c55e", 0],
  ["warning", "#f59e0b", 3],
  ["degraded", "#ef4444", 7],
] as const)("renders %s as an opaque conductor", (status, color, offset) => {
  const { container } = renderEdge({ status });
  const segments = container.querySelectorAll(".topology-edge-conductor");
  expect(segments).toHaveLength(2);
  segments.forEach((segment) => {
    expect(segment).toHaveStyle({ stroke: color, strokeWidth: "6" });
    expect(segment.getAttribute("style")).not.toContain("stroke-dasharray");
  });
  container.querySelectorAll(".topology-edge-contact-rail").forEach((rail) =>
    expect(rail).toHaveStyle({ fill: color }),
  );
  expect(container.querySelector(".topology-edge-contact-route-cover")).not.toBeInTheDocument();
  expect(container.querySelector(".topology-edge-contact")).toHaveAttribute("data-offset", String(offset));
});
```

Update the grouping test so all three `core-api-*` edges receive the same ordered statuses and only the last one has `renderTrunk: true`.

- [ ] **Step 2: Run component tests and verify RED**

Run: `pnpm vitest run src/components/FlowingEdge.test.tsx src/components/TopologyPanel.test.tsx src/components/ServiceNode.test.tsx`

Expected: FAIL on the old full `BaseEdge`, route cover, dash arrays, and missing shared metadata.

- [ ] **Step 3: Implement shared-route metadata**

```ts
export function getSharedSourceRoutes(edges: ServiceEdge[]): Map<string, SharedSourceRoute> {
  const bySource = new Map<string, ServiceEdge[]>();
  edges.forEach((edge) => bySource.set(edge.source, [...(bySource.get(edge.source) ?? []), edge]));
  const routes = new Map<string, SharedSourceRoute>();
  bySource.forEach((sourceEdges) => {
    if (sourceEdges.length < 2) return;
    const statuses = statusOrder.filter((status) =>
      sourceEdges.some((edge) => edge.status === status),
    );
    sourceEdges.forEach((edge, index) => routes.set(edge.id, {
      statuses,
      renderTrunk: index === sourceEdges.length - 1,
    }));
  });
  return routes;
}
```

- [ ] **Step 4: Render split opaque conductors**

Remove `edgeDashes`, the full `BaseEdge`, route occlusion/cover, and SVG gradient. Render `geometry.sourcePath` and `geometry.targetStubPath` as `.topology-edge-conductor` paths with `strokeWidth: CONDUCTOR_WIDTH`, `strokeLinecap: "butt"`, and the edge status color. Render `geometry.sharedTrunkPath` once: a green 6-unit base plus opaque 1.5-unit warning/degraded lanes at fixed offsets. Use filled status-color plug bodies for every state and preserve the `3`/`7` unit warning/error gaps.

- [ ] **Step 5: Align terminals with conductor metadata**

Aggregate incoming/outgoing edge statuses once in `TopologyCanvas` and pass them to `ServiceNode`. Change `.service-node-terminal` to `height: 6px; width: 7px; border: 0`; a single status uses one solid color and multiple statuses use fixed opaque green/amber/red bands. Remove `nodrag` from the module button but keep `nopan`, pointer selection, and keyboard semantics.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `pnpm vitest run src/lib/topology-connector-geometry.test.ts src/components/FlowingEdge.test.tsx src/components/TopologyPanel.test.tsx src/components/ServiceNode.test.tsx`

Expected: all connector, grouping, and terminal tests passed.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- artifacts/admin-dashboard/src/components/FlowingEdge.tsx artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx artifacts/admin-dashboard/src/components/TopologyPanel.tsx artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx artifacts/admin-dashboard/src/components/ServiceNode.tsx artifacts/admin-dashboard/src/components/ServiceNode.test.tsx artifacts/admin-dashboard/src/index.css
git commit -m "feat(admin): render unified topology conductors"
```

---

### Task 3: Session-Only Dragging And Layout Reset

**Files:**
- Create: `artifacts/admin-dashboard/src/lib/topology-position-overrides.ts`
- Create: `artifacts/admin-dashboard/src/lib/topology-position-overrides.test.ts`
- Modify: `artifacts/admin-dashboard/src/components/TopologyPanel.tsx`
- Modify: `artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx`
- Modify: `artifacts/admin-dashboard/src/components/ServiceNode.tsx`

**Interfaces:**
- Produces: `applyPositionChanges(overrides, changes): Map<string, XYPosition>`.
- Produces: `prunePositionOverrides(overrides, moduleIds): Map<string, XYPosition>`.

- [ ] **Step 1: Write failing override tests**

```ts
const moved = applyPositionChanges(new Map(), [
  { type: "position", id: "core-api", position: { x: 320, y: 180 }, dragging: true },
  { type: "select", id: "core-api", selected: true },
]);
expect(moved.get("core-api")).toEqual({ x: 320, y: 180 });

const pruned = prunePositionOverrides(
  new Map([["core-api", { x: 320, y: 180 }], ["removed", { x: 1, y: 1 }]]),
  new Set(["core-api"]),
);
expect(Array.from(pruned)).toEqual([["core-api", { x: 320, y: 180 }]]);
```

- [ ] **Step 2: Run helper tests and verify RED**

Run: `pnpm vitest run src/lib/topology-position-overrides.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement immutable position helpers**

```ts
export function applyPositionChanges(
  overrides: Map<string, XYPosition>,
  changes: NodeChange<ServiceFlowNode>[],
): Map<string, XYPosition> {
  const next = new Map(overrides);
  let changed = false;
  changes.forEach((change) => {
    if (change.type === "position" && change.position !== undefined) {
      next.set(change.id, change.position);
      changed = true;
    }
  });
  return changed ? next : overrides;
}

export function prunePositionOverrides(
  overrides: Map<string, XYPosition>,
  moduleIds: Set<string>,
): Map<string, XYPosition> {
  const next = new Map(Array.from(overrides).filter(([id]) => moduleIds.has(id)));
  return next.size === overrides.size ? overrides : next;
}
```

- [ ] **Step 4: Wire controlled session positions**

Create `positionOverrides` state in `TopologyCanvas`. Resolve node positions with `positionOverrides.get(module.id) ?? dagrePosition`, set every node `draggable: true`, enable `nodesDraggable`, and apply position changes before selection handling. Prune overrides when module IDs change; do not add storage or API calls.

- [ ] **Step 5: Add reset-layout control**

Add a `RotateCcw` icon button named `Сбросить раскладку` to `ViewportControls`. Disable it while the override map is empty and clear the map on activation. Keep the existing header `Сбросить выбор` behavior unchanged.

- [ ] **Step 6: Run drag/reset tests and verify GREEN**

Run: `pnpm vitest run src/lib/topology-position-overrides.test.ts src/components/TopologyPanel.test.tsx src/components/ServiceNode.test.tsx`

Expected: all position, reset, selection, and node tests passed.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- artifacts/admin-dashboard/src/lib/topology-position-overrides.ts artifacts/admin-dashboard/src/lib/topology-position-overrides.test.ts artifacts/admin-dashboard/src/components/TopologyPanel.tsx artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx artifacts/admin-dashboard/src/components/ServiceNode.tsx
git commit -m "feat(admin): add session topology dragging"
```

---

### Task 4: Browser QA, Regression Validation, Status, And Publish

**Files:**
- Modify: `IMPLEMENTATION_STATUS.md`

**Interfaces:**
- Consumes the completed UI from Tasks 1-3.
- Produces a validated feature branch ready for fast-forward merge to `main`.

- [ ] **Step 1: Run complete automated validation**

Run from `artifacts/admin-dashboard`: `pnpm vitest run`, `pnpm typecheck`, and `pnpm build`.

Run from repository root: `git diff --check`.

Expected: all tests passed, TypeScript and Vite exit code `0`, no whitespace errors.

- [ ] **Step 2: Validate the accepted browser flow**

The flow under test is: `#topology` loads -> drag `Download Worker` and `Account Integrations` -> connected cable/plug/terminal geometry follows -> reset layout restores dagre positions -> `DLW-E502` opens the exact journal.

At fit view and two zoom-in steps verify seven routes, one shared Core API trunk, opaque warning/error paint, no route beneath contact gaps, no module/label collisions, no framework overlay, and no relevant console warnings/errors. Reload must discard dragged positions.

- [ ] **Step 3: Update implementation status**

Append exact test counts, browser geometry/collision evidence, commit SHAs, branch name, and the statement that HomeNode/Coolify were not changed to `IMPLEMENTATION_STATUS.md`.

- [ ] **Step 4: Commit status**

```powershell
git add -- IMPLEMENTATION_STATUS.md
git commit -m "docs(status): record draggable connector validation"
```

- [ ] **Step 5: Publish and integrate**

Push `codex/feat/admin-draggable-connectors`, fast-forward merge it into an up-to-date `main`, push `main`, and repeat the complete automated and browser smoke checks on the merged result.
