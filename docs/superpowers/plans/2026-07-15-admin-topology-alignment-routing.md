# Admin Topology Alignment and Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic topology alignment, wider default spacing, straight-segment plug placement, collision-safe evidence labels, and one opaque aggregate status gradient on shared trunks.

**Architecture:** Keep React Flow as the viewport and interaction engine, but move coordinate decisions into pure, tested helpers. `TopologyPanel` owns transient mode/guides and maps snapshot data into nodes/edges; connector geometry owns one canonical orthogonal route; `FlowingEdge` only paints the geometry and generated gradient. No server contract changes are required.

**Tech Stack:** React 19, TypeScript 5.9, `@xyflow/react` 12.11, Dagre 0.8, Vitest 4, Testing Library, CSS, pnpm 10.

## Global Constraints

- Default layout uses `TOPOLOGY_RANK_SEPARATION = 132` and `TOPOLOGY_NODE_SEPARATION = 56`.
- Alignment grid is 24 topology units; magnetic threshold is 8 screen pixels at the current zoom.
- Modes are exactly `free` and `align`; the Russian labels are `Свободно` and `Выровнять`; `align` is the initial mode.
- Toggling mode never moves a node; snapping starts on the next pointer or keyboard movement.
- `Alt` is the precision modifier and moves by one screen-pixel equivalent (`1 / zoom`) without grid or magnet snapping.
- Every plug pair is centered on an eligible straight horizontal segment, at least 24 units from a bend and 28 units from a module terminal.
- A plug never lies on a bend. If no eligible segment exists, geometry adds an orthogonal detour corridor.
- Warning/error evidence is directly above its plug and moves to a higher deterministic lane until it intersects neither a module nor an earlier label.
- Shared trunks use one neutral opaque base and one fully opaque generated status gradient; translucent overlapping status strokes are forbidden.
- Gradient contributors are ordered by target center Y then edge ID, grouped by status, and weighted by contributor count.
- Aggregate severity is `degraded > warning > unknown > healthy`.
- Existing incident activation, drag/reset, reduced-motion, terminal, and mobile internal-scroll behavior must remain functional.
- Use existing colors, typography, radii, Lucide icons, and admin dashboard controls. Do not introduce a new visual system or dependency.
- HomeNode, Coolify, Caddy, UFW, DNS, Apollo GA, API contracts, provider credentials, and Android are out of scope.

---

## File Map

**Create**

- `artifacts/admin-dashboard/src/lib/topology-alignment.ts`: pure grid, magnet, guide, and keyboard movement calculations.
- `artifacts/admin-dashboard/src/lib/topology-alignment.test.ts`: alignment invariants.
- `artifacts/admin-dashboard/src/lib/topology-evidence-layout.ts`: deterministic label-lane assignment.
- `artifacts/admin-dashboard/src/lib/topology-evidence-layout.test.ts`: label/module collision tests.
- `artifacts/admin-dashboard/src/lib/topology-shared-routes.ts`: shared trunk contributor order and aggregate severity.
- `artifacts/admin-dashboard/src/lib/topology-shared-routes.test.ts`: shared-route and weighting tests.
- `artifacts/admin-dashboard/src/lib/topology-status-gradient.ts`: opaque gradient-stop generation.
- `artifacts/admin-dashboard/src/lib/topology-status-gradient.test.ts`: gradient edge cases and stability.

**Modify**

- `artifacts/admin-dashboard/src/lib/topology-layout.ts`: wider Dagre spacing.
- `artifacts/admin-dashboard/src/lib/topology-layout.test.ts`: exact spacing contracts.
- `artifacts/admin-dashboard/src/lib/topology-position-overrides.test.ts`: preserve transformed positions and unrelated changes.
- `artifacts/admin-dashboard/src/lib/topology-connector-geometry.ts`: canonical route points, rounded path splitting, and midpoint contact.
- `artifacts/admin-dashboard/src/lib/topology-connector-geometry.test.ts`: straight-segment, clearance, detour, crossed-row, and continuity invariants.
- `artifacts/admin-dashboard/src/components/TopologyPanel.tsx`: mode control, guide state, aligned changes, evidence lanes, and shared-route data.
- `artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx`: mode, drag, keyboard, guide, reset, and edge-data integration.
- `artifacts/admin-dashboard/src/components/FlowingEdge.tsx`: use canonical target path, evidence lane, and one SVG gradient.
- `artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx`: plug/line continuity, label placement, and gradient rendering.
- `artifacts/admin-dashboard/src/components/ServiceNode.tsx`: aggregate terminal uses worst status instead of a hard-coded three-color mix.
- `artifacts/admin-dashboard/src/components/ServiceNode.test.tsx`: deterministic terminal severity.
- `artifacts/admin-dashboard/src/index.css`: segmented mode control, guides, and responsive header layout.
- `artifacts/admin-dashboard/src/config-contract.test.ts`: CSS and no-alpha/no-overlap contracts.
- `IMPLEMENTATION_STATUS.md`: exact TDD, browser, review, commit, and infrastructure status.

---

### Task 1: Default Layout Spacing

**Files:**
- Modify: `artifacts/admin-dashboard/src/lib/topology-layout.ts`
- Modify: `artifacts/admin-dashboard/src/lib/topology-layout.test.ts`

**Interfaces:**
- Produces: `TOPOLOGY_RANK_SEPARATION = 132`, `TOPOLOGY_NODE_SEPARATION = 56`.
- Preserves: `layoutTopology(modules, edges): TopologyLayout`, node dimensions, input-order stability.

- [ ] **Step 1: Write the failing spacing assertions**

```ts
expect(TOPOLOGY_RANK_SEPARATION).toBe(132);
expect(TOPOLOGY_NODE_SEPARATION).toBe(56);
expect(byId.get("core-api")!.x - byId.get("public-web")!.x).toBe(
  NODE_WIDTH + 132,
);
expect(
  byId.get("download-worker")!.y - byId.get("account-integrations")!.y,
).toBe(NODE_HEIGHT + 56);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/lib/topology-layout.test.ts
```

Expected: FAIL because the current constants are `84` and `40`.

- [ ] **Step 3: Change only the spacing constants**

```ts
export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 76;
export const TOPOLOGY_RANK_SEPARATION = 132;
export const TOPOLOGY_NODE_SEPARATION = 56;
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: all `topology-layout` tests PASS.

- [ ] **Step 5: Commit the independently reviewable layout change**

```powershell
git add artifacts/admin-dashboard/src/lib/topology-layout.ts artifacts/admin-dashboard/src/lib/topology-layout.test.ts
git commit -m "feat(admin): widen topology module spacing"
```

---

### Task 2: Pure Alignment Engine

**Files:**
- Create: `artifacts/admin-dashboard/src/lib/topology-alignment.ts`
- Create: `artifacts/admin-dashboard/src/lib/topology-alignment.test.ts`
- Modify: `artifacts/admin-dashboard/src/lib/topology-position-overrides.test.ts`

**Interfaces:**
- Produces: `TopologyAlignmentMode`, `AlignableTopologyNode`, `AlignmentGuide`, `alignTopologyPosition`, `moveTopologyPositionByKeyboard`, `TOPOLOGY_GRID_SIZE`, `TOPOLOGY_MAGNETIC_THRESHOLD_PX`.
- Consumes: `XYPosition` from `@xyflow/react`.

- [ ] **Step 1: Write failing tests for grid, magnetic anchors, zoom, ties, free mode, and precision**

```ts
const moving = {
  id: "moving",
  position: { x: 47, y: 49 },
  width: 190,
  height: 76,
};

expect(
  alignTopologyPosition({
    nodeId: "moving",
    position: moving.position,
    width: 190,
    height: 76,
    nodes: [moving],
    zoom: 1,
    mode: "align",
    precision: false,
  }).position,
).toEqual({ x: 48, y: 48 });

expect(
  moveTopologyPositionByKeyboard({
    key: "ArrowRight",
    position: { x: 48, y: 48 },
    zoom: 0.5,
    precision: true,
  }),
).toEqual({ x: 50, y: 48 });
```

Also assert:

```ts
const peer = {
  id: "peer",
  position: { x: 240, y: 94 },
  width: 190,
  height: 76,
};
const magneticResult = alignTopologyPosition({
  nodeId: "moving",
  position: moving.position,
  width: 190,
  height: 76,
  nodes: [moving, peer],
  zoom: 1,
  mode: "align",
  precision: false,
});
const freeResult = alignTopologyPosition({
  nodeId: "moving",
  position: moving.position,
  width: 190,
  height: 76,
  nodes: [moving, peer],
  zoom: 1,
  mode: "free",
  precision: false,
});

expect(TOPOLOGY_GRID_SIZE).toBe(24);
expect(TOPOLOGY_MAGNETIC_THRESHOLD_PX).toBe(8);
expect(freeResult).toEqual({ position: moving.position, guides: [] });
expect(magneticResult.position).toEqual({ x: 50, y: 56 });
expect(magneticResult.guides).toEqual([
  { axis: "x", position: 240 },
  { axis: "y", position: 94 },
]);
```

Use candidate IDs and anchor order (`start`, `center`, `end`) to assert deterministic ties when two peers are equally close.

- [ ] **Step 2: Run the alignment tests and verify RED**

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/lib/topology-alignment.test.ts src/lib/topology-position-overrides.test.ts
```

Expected: FAIL because `topology-alignment.ts` does not exist.

- [ ] **Step 3: Implement the public types and constants**

```ts
import type { XYPosition } from "@xyflow/react";

export const TOPOLOGY_GRID_SIZE = 24;
export const TOPOLOGY_MAGNETIC_THRESHOLD_PX = 8;

export type TopologyAlignmentMode = "free" | "align";
export type AlignmentAxis = "x" | "y";

export interface AlignableTopologyNode {
  id: string;
  position: XYPosition;
  width: number;
  height: number;
}

export interface AlignmentGuide {
  axis: AlignmentAxis;
  position: number;
}

export interface AlignTopologyPositionInput {
  nodeId: string;
  position: XYPosition;
  width: number;
  height: number;
  nodes: readonly AlignableTopologyNode[];
  zoom: number;
  mode: TopologyAlignmentMode;
  precision: boolean;
}
```

- [ ] **Step 4: Implement deterministic grid-then-magnet alignment**

Use this exact behavior:

```ts
function snap(value: number): number {
  return Math.round(value / TOPOLOGY_GRID_SIZE) * TOPOLOGY_GRID_SIZE;
}

function anchors(start: number, size: number): number[] {
  return [start, start + size / 2, start + size];
}

export function alignTopologyPosition(
  input: AlignTopologyPositionInput,
): { position: XYPosition; guides: AlignmentGuide[] } {
  if (input.mode === "free" || input.precision) {
    return { position: input.position, guides: [] };
  }

  const base = { x: snap(input.position.x), y: snap(input.position.y) };
  const threshold = TOPOLOGY_MAGNETIC_THRESHOLD_PX / Math.max(input.zoom, 0.01);
  const peers = [...input.nodes]
    .filter((node) => node.id !== input.nodeId)
    .sort((left, right) => left.id.localeCompare(right.id));
  const result = { ...base };
  const guides: AlignmentGuide[] = [];

  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? input.width : input.height;
    const moving = anchors(result[axis], size);
    let best: { distance: number; delta: number; guide: number; key: string } | undefined;

    peers.forEach((peer) => {
      const peerStart = peer.position[axis];
      const peerSize = axis === "x" ? peer.width : peer.height;
      anchors(peerStart, peerSize).forEach((target, targetIndex) => {
        moving.forEach((source, sourceIndex) => {
          const delta = target - source;
          const distance = Math.abs(delta);
          const candidate = {
            distance,
            delta,
            guide: target,
            key: `${peer.id}:${targetIndex}:${sourceIndex}`,
          };
          if (
            distance <= threshold &&
            (best === undefined ||
              distance < best.distance ||
              (distance === best.distance && candidate.key < best.key))
          ) {
            best = candidate;
          }
        });
      });
    });

    if (best !== undefined) {
      result[axis] += best.delta;
      guides.push({ axis, position: best.guide });
    }
  }

  return { position: result, guides };
}
```

- [ ] **Step 5: Implement keyboard deltas without hidden state**

```ts
export function moveTopologyPositionByKeyboard(input: {
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
  position: XYPosition;
  zoom: number;
  precision: boolean;
}): XYPosition {
  const step = input.precision
    ? 1 / Math.max(input.zoom, 0.01)
    : TOPOLOGY_GRID_SIZE;
  const delta = {
    ArrowLeft: { x: -step, y: 0 },
    ArrowRight: { x: step, y: 0 },
    ArrowUp: { x: 0, y: -step },
    ArrowDown: { x: 0, y: step },
  }[input.key];
  return { x: input.position.x + delta.x, y: input.position.y + delta.y };
}
```

- [ ] **Step 6: Run focused tests and commit**

Run Step 2. Expected: all alignment and position-override tests PASS.

```powershell
git add artifacts/admin-dashboard/src/lib/topology-alignment.ts artifacts/admin-dashboard/src/lib/topology-alignment.test.ts artifacts/admin-dashboard/src/lib/topology-position-overrides.test.ts
git commit -m "feat(admin): add deterministic topology alignment"
```

---

### Task 3: Alignment Controls, Guides, Drag, and Keyboard Integration

**Files:**
- Modify: `artifacts/admin-dashboard/src/components/TopologyPanel.tsx`
- Modify: `artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx`
- Modify: `artifacts/admin-dashboard/src/index.css`
- Modify: `artifacts/admin-dashboard/src/config-contract.test.ts`

**Interfaces:**
- Consumes: all Task 2 exports.
- Produces: accessible `Свободно`/`Выровнять` segmented control, `data-alignment-axis` guide elements, normalized pointer/keyboard overrides.
- Preserves: selection, fit/zoom/reset, measured dimensions, unmount reset, mobile scroller.

- [ ] **Step 1: Write failing component tests**

Add exact assertions:

```ts
expect(screen.getByRole("radio", { name: "Выровнять" })).toBeChecked();
fireEvent.click(screen.getByRole("radio", { name: "Свободно" }));
expect(getReactFlowProps().snapToGrid).toBe(false);
fireEvent.click(screen.getByRole("radio", { name: "Выровнять" }));
expect(getReactFlowProps().snapGrid).toEqual([24, 24]);
```

Invoke captured `onNodesChange` with `dragging: true` at `{ x: 49, y: 71 }`; assert the controlled node becomes `{ x: 48, y: 72 }` and a guide appears only when a peer anchor is within the 8-screen-pixel threshold. Invoke the same change with free mode selected and assert `{ x: 49, y: 71 }` is preserved.

For keyboard behavior:

```ts
node.focus();
fireEvent.keyDown(node, { key: "ArrowRight" });
expect(updatedPosition.x - initialPosition.x).toBe(24);
fireEvent.keyDown(node, { key: "ArrowRight", altKey: true });
expect(nextPosition.x - updatedPosition.x).toBeCloseTo(1 / 0.8, 6);
```

Assert guides clear on `dragging: false`, mode toggle, reset, and unmount.

- [ ] **Step 2: Run the panel/CSS tests and verify RED**

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/components/TopologyPanel.test.tsx src/config-contract.test.ts
```

Expected: FAIL because the segmented control, snap props, guide state, and aligned changes do not exist.

- [ ] **Step 3: Add transient alignment state and accessible mode control**

Use radio semantics so the selected mode is explicit:

```tsx
// TopologyPanel owns the selected mode so the control stays in the fixed header.
const [alignmentMode, setAlignmentMode] =
  useState<TopologyAlignmentMode>("align");

<div className="topology-alignment-mode" role="radiogroup" aria-label="Режим размещения">
  {(["free", "align"] as const).map((mode) => (
    <button
      key={mode}
      type="button"
      role="radio"
      aria-checked={alignmentMode === mode}
      onClick={() => {
        setAlignmentMode(mode);
        setAlignmentGuides([]);
      }}
    >
      {mode === "free" ? "Свободно" : "Выровнять"}
    </button>
  ))}
</div>
```

Pass `alignmentMode` into `TopologyCanvas`. `TopologyCanvas` owns `alignmentGuides` and clears them in an effect whenever the mode prop changes.

- [ ] **Step 4: Normalize pointer changes before storing overrides**

For every position change, look up the node dimensions and current peer positions, call `alignTopologyPosition`, replace only `change.position`, and pass the transformed array to `applyPositionChanges`. Publish guides only while `change.dragging === true`; clear them on drag stop. Keep selection changes byte-for-byte equivalent to the existing behavior.

```ts
const normalizedChanges = changes.map((change) => {
  if (change.type !== "position" || change.position === undefined) return change;
  const moving = currentNodePositions.get(change.id);
  if (moving === undefined) return change;
  const aligned = alignTopologyPosition({
    nodeId: change.id,
    position: change.position,
    width: moving.width,
    height: moving.height,
    nodes: Array.from(currentNodePositions, ([id, node]) => ({
      id,
      position: { x: node.x, y: node.y },
      width: node.width,
      height: node.height,
    })),
    zoom: getZoom(),
    mode: alignmentMode,
    precision: false,
  });
  if (change.dragging === true) setAlignmentGuides(aligned.guides);
  else setAlignmentGuides([]);
  return { ...change, position: aligned.position };
});
```

- [ ] **Step 5: Integrate snap props, keyboard movement, and viewport guides**

Set:

```tsx
snapToGrid={alignmentMode === "align"}
snapGrid={[TOPOLOGY_GRID_SIZE, TOPOLOGY_GRID_SIZE]}
```

On `onKeyDownCapture`, handle arrow keys only when alignment mode is active and the event target is inside `.react-flow__node[data-id]`. Prevent React Flow's duplicate movement, call `moveTopologyPositionByKeyboard`, then call `alignTopologyPosition` unless `event.altKey` is true. Update only that node override. Render guides in `ViewportPortal`:

```tsx
<ViewportPortal>
  {alignmentGuides.map((guide) => (
    <span
      key={`${guide.axis}:${guide.position}`}
      className={`topology-alignment-guide topology-alignment-guide--${guide.axis}`}
      data-alignment-axis={guide.axis}
      style={guide.axis === "x" ? { left: guide.position } : { top: guide.position }}
      aria-hidden="true"
    />
  ))}
</ViewportPortal>
```

- [ ] **Step 6: Style the segmented control and non-layout-shifting guides**

```css
.topology-alignment-mode {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface-soft);
}

.topology-alignment-mode button {
  min-height: 30px;
  padding: 0 9px;
  border: 0;
  border-right: 1px solid var(--color-border);
  color: var(--color-muted);
  background: transparent;
  font-size: 10px;
}

.topology-alignment-mode button:last-child { border-right: 0; }
.topology-alignment-mode button[aria-checked="true"] {
  color: var(--color-text);
  background: var(--color-surface-raised);
}

.topology-alignment-guide {
  position: absolute;
  z-index: 3;
  pointer-events: none;
  background: var(--color-accent);
}
.topology-alignment-guide--x { top: -4096px; width: 1px; height: 8192px; }
.topology-alignment-guide--y { left: -4096px; width: 8192px; height: 1px; }
```

Add a mobile header rule that gives the mode control its own row without overlapping legend/reset controls.

- [ ] **Step 7: Run focused tests and commit**

Run Step 2 plus:

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/lib/topology-alignment.test.ts src/lib/topology-position-overrides.test.ts
```

Expected: all focused tests PASS.

```powershell
git add artifacts/admin-dashboard/src/components/TopologyPanel.tsx artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx artifacts/admin-dashboard/src/index.css artifacts/admin-dashboard/src/config-contract.test.ts
git commit -m "feat(admin): add topology alignment mode"
```

---

### Task 4: Canonical Orthogonal Route and Straight-Segment Plug

**Files:**
- Modify: `artifacts/admin-dashboard/src/lib/topology-connector-geometry.ts`
- Modify: `artifacts/admin-dashboard/src/lib/topology-connector-geometry.test.ts`
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.tsx`
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx`

**Interfaces:**
- Produces: `RoutePoint`, `sourcePath`, `targetPath`, `routePoints`, `contactSegmentIndex`, contact coordinates/faces.
- Replaces: `targetStubPath` with `targetPath` because the contact can precede bends.
- Preserves: `sharedTrunkPath`, `branchSourceX`, rounded 7.5-unit bends, plug shape/state/hit target.

- [ ] **Step 1: Replace fixed-target expectations with geometry invariants**

Write RED tests that assert:

```ts
expect(geometry.contactX).toBeGreaterThan(geometry.branchSourceX + 28);
expect(geometry.contactX).toBeLessThan(input.targetX - 28);
expect(geometry.routePoints[geometry.contactSegmentIndex].y).toBe(
  geometry.contactY,
);
expect(geometry.femaleOuterX).toBe(geometry.contactX - 16);
expect(geometry.maleOuterX).toBe(geometry.contactX + 16);
expect(geometry.sourcePath).toMatch(new RegExp(`${geometry.femaleOuterX}`));
expect(geometry.targetPath).toMatch(new RegExp(`${geometry.maleOuterX}`));
```

Add fixtures for same-row, different-row, shortened shared trunk, target moved left of source, and a gap too short for the plug. For every fixture, calculate the selected segment endpoint distances and assert at least 24 from a bend and 28 from a module terminal. The short fixture must expose `usedDetour: true` and still satisfy the invariants.

- [ ] **Step 2: Run geometry/edge tests and verify RED**

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/lib/topology-connector-geometry.test.ts src/components/FlowingEdge.test.tsx
```

Expected: FAIL because the contact is fixed 28 units from the target and `targetPath`/route metadata do not exist.

- [ ] **Step 3: Define the canonical geometry contract**

```ts
export const CONTACT_HALF_LENGTH = 16;
export const CONTACT_BEND_CLEARANCE = 24;
export const CONTACT_TERMINAL_CLEARANCE = 28;
export const CONNECTOR_BEND_RADIUS = 7.5;

export interface RoutePoint { x: number; y: number }

export interface ConnectorGeometry {
  sourcePath: string;
  targetPath: string;
  contactX: number;
  contactY: number;
  femaleOuterX: number;
  maleOuterX: number;
  branchSourceX: number;
  routePoints: RoutePoint[];
  contactSegmentIndex: number;
  usedDetour: boolean;
  sharedTrunkPath?: string;
}
```

- [ ] **Step 4: Build one orthogonal point list and select the longest eligible horizontal interval**

Generate the normal route as:

```ts
const points = input.sourceY === input.targetY
  ? [source, target]
  : input.sourceX <= input.targetX
    ? [
        source,
        { x: Math.min(source.x + 28, target.x - 28), y: source.y },
        { x: Math.min(source.x + 28, target.x - 28), y: target.y },
        target,
      ]
    : [
        source,
        { x: Math.max(source.x, target.x) + 112, y: source.y },
        { x: Math.max(source.x, target.x) + 112, y: target.y },
        target,
      ];
```

For each left-to-right horizontal segment (`end.x > start.x`), reserve 28 units at a route terminal and 24 at an internal bend. Ignoring right-to-left segments keeps the female half on the source-facing side and the male half on the target-facing side after modules are crossed. A segment is eligible when the remaining interval is at least 32 units. Choose the largest remaining interval; ties choose the interval whose midpoint is closest to the whole-route bounding-box center, then the lowest segment index. The plug center is the midpoint of that remaining interval.

If no segment is eligible, replace the point list with this deterministic detour and re-run selection:

```ts
const detourX = Math.max(source.x, target.x) + 112;
const detourY = Math.max(source.y, target.y) + 64;
const approachX = target.x - CONTACT_TERMINAL_CLEARANCE;
const points = [
  source,
  { x: detourX, y: source.y },
  { x: detourX, y: detourY },
  { x: approachX, y: detourY },
  { x: approachX, y: target.y },
  target,
];
```

Collapse consecutive duplicate/collinear points before path generation. Split the selected segment at `femaleOuterX` and `maleOuterX`; build rounded SVG paths independently from source to female face and male face to target. Clamp every corner radius to half of both adjacent segment lengths so a short segment cannot backtrack.

- [ ] **Step 5: Paint `targetPath` and keep conductor/plug continuity exact**

Change both target-side base/lane paths from `geometry.targetStubPath` to `geometry.targetPath`. Keep the neutral/status widths at `1.75`/`1`, keep plug outer faces at `±16`, and do not add masks or transparent route covers.

- [ ] **Step 6: Run focused tests and commit**

Run Step 2. Expected: all connector geometry and FlowingEdge tests PASS, including prior crossed/short-route regressions rewritten as invariants rather than obsolete fixed coordinates.

```powershell
git add artifacts/admin-dashboard/src/lib/topology-connector-geometry.ts artifacts/admin-dashboard/src/lib/topology-connector-geometry.test.ts artifacts/admin-dashboard/src/components/FlowingEdge.tsx artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx
git commit -m "feat(admin): center plugs on straight topology routes"
```

---

### Task 5: Collision-Safe Evidence Labels

**Files:**
- Create: `artifacts/admin-dashboard/src/lib/topology-evidence-layout.ts`
- Create: `artifacts/admin-dashboard/src/lib/topology-evidence-layout.test.ts`
- Modify: `artifacts/admin-dashboard/src/components/TopologyPanel.tsx`
- Modify: `artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx`
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.tsx`
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx`

**Interfaces:**
- Produces: `EvidenceAnchor`, `EvidenceObstacle`, `assignEvidenceLabelLanes` returning `Map<edgeId, lane>`, and `getTopologyVisualBounds`.
- Adds: `FlowingEdgeData.evidenceLane?: number`.
- Consumes: canonical connector geometry from Task 4 and current node rectangles.

- [ ] **Step 1: Write RED collision tests**

```ts
const lanes = assignEvidenceLabelLanes({
  anchors: [
    { id: "a", x: 300, y: 120, width: 84 },
    { id: "b", x: 318, y: 126, width: 84 },
  ],
  obstacles: [{ x: 250, y: 40, width: 190, height: 76 }],
  labelHeight: 14,
  baseOffset: 22,
  laneGap: 4,
});
expect(lanes.get("a")).toBeGreaterThanOrEqual(1);
expect(lanes.get("b")).toBeGreaterThan(lanes.get("a")!);
```

Also assert that reversing `anchors` produces the same map, no-label healthy edges are omitted by the caller, and a clear anchor receives lane `0`.

- [ ] **Step 2: Run evidence tests and verify RED**

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/lib/topology-evidence-layout.test.ts src/components/TopologyPanel.test.tsx src/components/FlowingEdge.test.tsx
```

Expected: FAIL because the helper and `evidenceLane` do not exist.

- [ ] **Step 3: Implement deterministic above-only lane assignment**

```ts
export interface EvidenceAnchor { id: string; x: number; y: number; width: number }
export interface EvidenceObstacle { x: number; y: number; width: number; height: number }

export function assignEvidenceLabelLanes(input: {
  anchors: readonly EvidenceAnchor[];
  obstacles: readonly EvidenceObstacle[];
  labelHeight: number;
  baseOffset: number;
  laneGap: number;
}): Map<string, number> {
  const placed: EvidenceObstacle[] = [];
  const result = new Map<string, number>();
  const ordered = [...input.anchors].sort(
    (a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id),
  );
  const intersects = (a: EvidenceObstacle, b: EvidenceObstacle) =>
    a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;

  ordered.forEach((anchor) => {
    let lane = 0;
    while (true) {
      const rect = {
        x: anchor.x - anchor.width / 2,
        y: anchor.y - input.baseOffset - input.labelHeight -
          lane * (input.labelHeight + input.laneGap),
        width: anchor.width,
        height: input.labelHeight,
      };
      if (![...input.obstacles, ...placed].some((item) => intersects(rect, item))) {
        result.set(anchor.id, lane);
        placed.push(rect);
        break;
      }
      lane += 1;
    }
  });
  return result;
}
```

Export `getEvidenceLabelRect(anchor, lane, metrics)` and `getTopologyVisualBounds(moduleRects, labelRects)`. The latter returns the smallest `{ x, y, width, height }` containing every module and evidence rectangle; empty inputs return `undefined`.

- [ ] **Step 4: Calculate geometry/label width in `TopologyPanel` and pass lanes**

For warning/degraded/unknown edges, compute handle centers from `currentNodePositions`, call `buildConnectorGeometry`, derive the same visible status width formula as a shared exported helper from `FlowingEdge`, and call `assignEvidenceLabelLanes`. Add the resulting lane to edge data. Healthy edges do not reserve a lane. Build `topologyVisualBounds` from all module rectangles and assigned label rectangles.

- [ ] **Step 5: Anchor every status badge above the plug**

Replace the current source/target direction switch with:

```ts
const STATUS_BADGE_BASE_Y = -36;
const STATUS_BADGE_LANE_STEP = 18;
const statusBadgeY =
  STATUS_BADGE_BASE_Y - (data?.evidenceLane ?? 0) * STATUS_BADGE_LANE_STEP;
```

Traffic remains below the plug at `y=19`. Add `data-evidence-lane` to the status group for browser inspection.

- [ ] **Step 6: Use visual bounds for initial and manual fit**

Extend `ViewportControls` to receive `topologyVisualBounds` and call `fitBounds(bounds, { duration, padding: 0.12 })` instead of node-only `fitView`. In `TopologyCanvas`, call the same `fitBounds` once after the first non-empty bounds calculation; guard it with `useRef(false)` so dragging never triggers automatic re-fit. Tests must assert the bounds include the highest evidence rectangle and that repeated node changes do not invoke automatic fit again.

```tsx
const { fitBounds } = useReactFlow();
const didInitialFit = useRef(false);

useEffect(() => {
  if (didInitialFit.current || topologyVisualBounds === undefined) return;
  didInitialFit.current = true;
  void fitBounds(topologyVisualBounds, {
    duration: reducedMotion ? 0 : 160,
    padding: 0.12,
  });
}, [fitBounds, reducedMotion, topologyVisualBounds]);
```

- [ ] **Step 7: Run focused tests and commit**

Run Step 2. Expected: all evidence, panel, and edge tests PASS.

```powershell
git add artifacts/admin-dashboard/src/lib/topology-evidence-layout.ts artifacts/admin-dashboard/src/lib/topology-evidence-layout.test.ts artifacts/admin-dashboard/src/components/TopologyPanel.tsx artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx artifacts/admin-dashboard/src/components/FlowingEdge.tsx artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx
git commit -m "feat(admin): keep topology evidence above connectors"
```

---

### Task 6: Aggregate Status Gradient and Terminal Severity

**Files:**
- Create: `artifacts/admin-dashboard/src/lib/topology-shared-routes.ts`
- Create: `artifacts/admin-dashboard/src/lib/topology-shared-routes.test.ts`
- Create: `artifacts/admin-dashboard/src/lib/topology-status-gradient.ts`
- Create: `artifacts/admin-dashboard/src/lib/topology-status-gradient.test.ts`
- Modify: `artifacts/admin-dashboard/src/components/TopologyPanel.tsx`
- Modify: `artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx`
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.tsx`
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx`
- Modify: `artifacts/admin-dashboard/src/components/ServiceNode.tsx`
- Modify: `artifacts/admin-dashboard/src/components/ServiceNode.test.tsx`

**Interfaces:**
- Produces: `SharedStatusBand`, `SharedSourceRoute`, `getSharedSourceRoutes`, `getWorstHealthStatus`, `buildStatusGradientStops`.
- Adds: `FlowingEdgeData.sharedStatusBands?: SharedStatusBand[]`.
- Removes: `sharedStatuses`, three translated shared-lane strokes, and hard-coded multi-status terminal gradient.

- [ ] **Step 1: Write RED shared-route and gradient tests**

Order three Core branches by target center Y and assert:

```ts
expect(route.statusBands).toEqual([
  { status: "healthy", count: 1 },
  { status: "degraded", count: 1 },
  { status: "warning", count: 1 },
]);
expect(route.aggregateStatus).toBe("degraded");
```

Use `healthy, warning, healthy` to assert duplicate grouping and weighting:

```ts
expect(bands).toEqual([
  { status: "healthy", count: 2 },
  { status: "warning", count: 1 },
]);
```

For gradient stops assert offsets are finite, monotonic, start at `0`, end at `1`, contain no opacity field, and remain identical when unrelated edge input order changes. One status returns two stops of the same status. Empty bands return `[]` and do not render a gradient.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/lib/topology-shared-routes.test.ts src/lib/topology-status-gradient.test.ts src/components/FlowingEdge.test.tsx src/components/ServiceNode.test.tsx
```

Expected: FAIL because the helpers and aggregate gradient contract do not exist.

- [ ] **Step 3: Move shared-route calculation into a pure helper**

```ts
export interface SharedStatusBand {
  status: HealthStatus;
  count: number;
}

export interface SharedSourceRoute {
  statusBands: SharedStatusBand[];
  aggregateStatus: HealthStatus;
  renderTrunk: boolean;
  sharedBranchLength: number;
}

const severity: HealthStatus[] = ["healthy", "unknown", "warning", "degraded"];
export function getWorstHealthStatus(statuses: readonly HealthStatus[]): HealthStatus {
  return statuses.reduce(
    (worst, status) =>
      severity.indexOf(status) > severity.indexOf(worst) ? status : worst,
    "healthy",
  );
}
```

Sort source edges by target center (`node.y + node.height / 2`) then edge ID. Group the ordered list by status while preserving each status's first occurrence and increment `count` for duplicates. Keep the existing shared-clearance calculation and one deterministic trunk owner.

- [ ] **Step 4: Implement opaque weighted transition stops**

```ts
export interface StatusGradientStop { offset: number; status: HealthStatus }

export function buildStatusGradientStops(
  bands: readonly SharedStatusBand[],
): StatusGradientStop[] {
  const total = bands.reduce((sum, band) => sum + band.count, 0);
  if (total <= 0 || bands.length === 0) return [];
  if (bands.length === 1) {
    return [
      { offset: 0, status: bands[0].status },
      { offset: 1, status: bands[0].status },
    ];
  }
  const stops: StatusGradientStop[] = [{ offset: 0, status: bands[0].status }];
  let consumed = bands[0].count;
  for (let index = 1; index < bands.length; index += 1) {
    const previousWidth = bands[index - 1].count / total;
    const nextWidth = bands[index].count / total;
    const boundary = consumed / total;
    const halfTransition = Math.min(0.04, previousWidth / 4, nextWidth / 4);
    stops.push(
      { offset: boundary - halfTransition, status: bands[index - 1].status },
      { offset: boundary + halfTransition, status: bands[index].status },
    );
    consumed += bands[index].count;
  }
  stops.push({ offset: 1, status: bands[bands.length - 1].status });
  return stops;
}
```

- [ ] **Step 5: Render one SVG gradient lane**

Create an ID from React `useId()` plus the edge ID with non-alphanumeric characters replaced by `-`. Use `gradientUnits="userSpaceOnUse"`, `x1=sourceX`, `x2=branchSourceX`, and exact semantic colors. Render one shared status path:

```tsx
<defs>
  <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={sourceX} x2={geometry.branchSourceX}>
    {stops.map((stop, index) => (
      <stop
        key={`${stop.offset}:${stop.status}:${index}`}
        offset={`${stop.offset * 100}%`}
        stopColor={edgeColors[stop.status]}
        stopOpacity={1}
      />
    ))}
  </linearGradient>
</defs>
<path
  className="topology-edge-shared-trunk topology-edge-status-lane"
  d={geometry.sharedTrunkPath}
  stroke={`url(#${gradientId})`}
  strokeWidth={STATUS_LANE_WIDTH}
  fill="none"
/>
```

There must be exactly one shared status lane regardless of contributor count.

- [ ] **Step 6: Replace mixed terminal stripes with aggregate severity**

In `ServiceNode`, compute each side with `getWorstHealthStatus` and set one solid `terminalColors[status]`. Keep `data-statuses` for diagnostics and add `data-aggregate-status`. Update tests to expect a solid degraded source terminal for `healthy warning degraded`.

- [ ] **Step 7: Run focused tests and commit**

Run Step 2. Expected: all shared-route, gradient, edge, panel, and node tests PASS.

```powershell
git add artifacts/admin-dashboard/src/lib/topology-shared-routes.ts artifacts/admin-dashboard/src/lib/topology-shared-routes.test.ts artifacts/admin-dashboard/src/lib/topology-status-gradient.ts artifacts/admin-dashboard/src/lib/topology-status-gradient.test.ts artifacts/admin-dashboard/src/components/TopologyPanel.tsx artifacts/admin-dashboard/src/components/TopologyPanel.test.tsx artifacts/admin-dashboard/src/components/FlowingEdge.tsx artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx artifacts/admin-dashboard/src/components/ServiceNode.tsx artifacts/admin-dashboard/src/components/ServiceNode.test.tsx
git commit -m "feat(admin): aggregate shared topology status"
```

---

### Task 7: Regression, Browser QA, Review Fixes, and Status

**Files:**
- Modify as required by concrete failures: files from Tasks 1-6 only.
- Modify: `IMPLEMENTATION_STATUS.md`

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: validated feature branch, browser evidence, review verdict, exact status record.

- [ ] **Step 1: Run the focused topology suite**

```powershell
pnpm --dir artifacts/admin-dashboard exec vitest run src/lib/topology-layout.test.ts src/lib/topology-alignment.test.ts src/lib/topology-position-overrides.test.ts src/lib/topology-connector-geometry.test.ts src/lib/topology-evidence-layout.test.ts src/lib/topology-shared-routes.test.ts src/lib/topology-status-gradient.test.ts src/components/TopologyPanel.test.tsx src/components/FlowingEdge.test.tsx src/components/ServiceNode.test.tsx src/config-contract.test.ts
```

Expected: all focused files PASS with zero unhandled errors.

- [ ] **Step 2: Run full admin and workspace validation**

```powershell
pnpm --dir artifacts/admin-dashboard test
pnpm --dir artifacts/admin-dashboard typecheck
pnpm --dir artifacts/admin-dashboard build
pnpm run typecheck
git diff --check
```

Expected: every command exits `0`. The known unrelated root Android/static-build issue is not invoked by this stage.

- [ ] **Step 3: Run Codex in-app browser visual/interaction QA**

Use the existing approved in-app browser and the admin preview route. Validate at desktop and `390x844`:

- initial `Выровнять` state and no node jump on mode toggle;
- pointer drag grid/magnetic guides, free drag, `Alt` keyboard precision, and reset;
- wider default rank/row spacing;
- every plug centered on a straight segment and separated from bends/cards;
- labels directly above plugs and no label/card intersections at fit and two zoom-in steps;
- one opaque gradient lane on the Core shared trunk, correct branch solids, and solid worst-severity terminal;
- incident click, Enter, and Space still open the exact sanitized journal;
- reduced motion, mobile internal horizontal scroll, no page overflow;
- zero browser console warnings/errors.

Capture matching viewport screenshots of the supplied reference and implementation, combine them for visual comparison, and fix concrete geometry/layout discrepancies before acceptance.

- [ ] **Step 4: Dispatch two independent reviews**

Use one specification-compliance reviewer against `2026-07-15-admin-topology-alignment-routing-design.md` and this plan, then one code-quality reviewer against the complete feature diff. Fix every validated Critical/Important finding with a failing regression test first, rerun focused/full validation, and request re-review until no actionable finding remains.

- [ ] **Step 5: Record exact status and commit**

Update `IMPLEMENTATION_STATUS.md` under the required headings with:

- implemented behavior and boundaries;
- focused/full test counts and commands;
- browser viewports and interaction evidence;
- review verdict and fix commits;
- branch/commit/push/merge state;
- explicit statement that HomeNode/Coolify/Caddy/UFW/DNS/GA/Android were unchanged;
- next stage: Apollo Identity/Policy plan.

```powershell
git add IMPLEMENTATION_STATUS.md
git commit -m "docs(status): record topology alignment validation"
```

- [ ] **Step 6: Finish the feature branch**

Use `superpowers:finishing-a-development-branch`. Push the reviewed feature branch, fast-forward merge to `main`, rerun focused tests/typecheck/build on the merged result, push `main`, and record the final merge/push status. Do not squash away the task-level TDD commits.

---

## Plan Self-Review Checklist

- Every requirement in `2026-07-15-admin-topology-alignment-routing-design.md` maps to Tasks 1-7.
- All new exported types and functions are defined before consumers use them.
- Pointer and keyboard movement share one pure alignment contract.
- Route geometry and painting share one canonical point list and split faces.
- Label collision and aggregate gradient behavior are pure and independently tested.
- No incomplete marker, deferred implementation note, new dependency, server contract, or infrastructure mutation is present.
- Every implementation task starts RED, reaches GREEN, and ends in a focused commit/review gate.
