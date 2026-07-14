# Admin Connector Ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace arrow/dot edge endings with module-status terminals and preserve a visible straight line between each plug pair and its target module.

**Architecture:** `FlowingEdge` continues to own route/contact geometry and moves the contact pair twelve topology units away from the target. `ServiceNode` owns one terminal per side so shared handles do not produce overlapping per-edge ports; React Flow handles remain available for routing but become visually transparent.

**Tech Stack:** React 19, TypeScript 5.9, `@xyflow/react`, Vitest, Testing Library, CSS.

## Global Constraints

- Keep the accepted straight male/female plug geometry unchanged.
- Remove `ArrowClosed` and visible round handles.
- Terminal color follows module status, not individual edge status.
- Preserve edge keyboard activation, diagnostic labels, incident journal behavior, warning motion, and reduced-motion behavior.
- Do not change topology data contracts or backend telemetry.

---

### Task 1: Contact-To-Module Stub

**Files:**
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.test.tsx`
- Modify: `artifacts/admin-dashboard/src/components/FlowingEdge.tsx`
- Modify: `artifacts/admin-dashboard/src/components/TopologyPanel.tsx`

**Interfaces:**
- Produces: `TARGET_LINE_STUB = 12` internal geometry; contact center at `targetX - CONTACT_HALF_LENGTH - TARGET_LINE_STUB`.
- Preserves: `FlowingEdgeData`, `TopologyFlowEdge`, accessible edge labels and diagnostics.

- [x] **Step 1: Write the failing geometry test**

Change the bent-edge assertions to require the target stub:

```ts
expect(contact).toHaveAttribute("transform", "translate(92 80)");
expect(maskGap).toHaveAttribute("x", "76");
expect(maskGap).toHaveAttribute("width", "32");
```

Add a source assertion that `TopologyPanel.tsx` does not configure `MarkerType.ArrowClosed`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @workspace/admin-dashboard test -- src/components/FlowingEdge.test.tsx src/config-contract.test.ts --reporter=dot`

Expected: FAIL because the contact still renders at `translate(104 80)` and `TopologyPanel.tsx` still contains `MarkerType.ArrowClosed`.

- [x] **Step 3: Implement the target stub and remove arrows**

Use:

```ts
const TARGET_LINE_STUB = 12;
const contactX = targetX - CONTACT_HALF_LENGTH - TARGET_LINE_STUB;
```

Remove the `MarkerType` import and `markerEnd` assignment from `TopologyPanel.tsx`. Keep `BaseEdge` route rendering and the existing contact mask unchanged apart from its translated position.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --filter @workspace/admin-dashboard test -- src/components/FlowingEdge.test.tsx src/config-contract.test.ts --reporter=dot`

Expected: both files pass.

### Task 2: Module Status Terminals

**Files:**
- Create: `artifacts/admin-dashboard/src/components/ServiceNode.test.tsx`
- Modify: `artifacts/admin-dashboard/src/components/ServiceNode.tsx`
- Modify: `artifacts/admin-dashboard/src/index.css`
- Modify: `artifacts/admin-dashboard/src/config-contract.test.ts`

**Interfaces:**
- Produces: `.service-node-terminal--target` and `.service-node-terminal--source`, each with `data-status: HealthStatus` and `aria-hidden="true"`.
- Preserves: native React Flow target/source handles for edge routing.

- [x] **Step 1: Write failing component and CSS contract tests**

Render `ServiceNode` inside `ReactFlowProvider` and assert:

```ts
expect(container.querySelectorAll(".service-node-terminal")).toHaveLength(2);
expect(container.querySelector(".service-node-terminal--target")).toHaveAttribute("data-status", "warning");
expect(container.querySelector(".service-node-terminal--source")).toHaveAttribute("aria-hidden", "true");
```

In `config-contract.test.ts`, require transparent handles and fixed terminal geometry:

```ts
expect(dashboardCss).toMatch(/\.react-flow__handle\s*{[^}]*opacity:\s*0/s);
expect(dashboardCss).toMatch(/\.service-node-terminal\s*{[^}]*width:\s*6px;[^}]*height:\s*16px/s);
```

- [x] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @workspace/admin-dashboard test -- src/components/ServiceNode.test.tsx src/config-contract.test.ts --reporter=dot`

Expected: FAIL because terminal elements and CSS do not exist and handles remain visible.

- [x] **Step 3: Implement terminal markup and styling**

Add two decorative spans next to the existing handles:

```tsx
<span className="service-node-terminal service-node-terminal--target" data-status={module.status} aria-hidden="true" />
<span className="service-node-terminal service-node-terminal--source" data-status={module.status} aria-hidden="true" />
```

Make `.service-node-root` positioned, hide handles with `opacity: 0`, and style terminals as `position: absolute`, `width: 6px`, `height: 16px`, vertically centered and half-overlapping the card edge. Reuse existing health CSS variables for `[data-status]` colors and keep pointer events disabled.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --filter @workspace/admin-dashboard test -- src/components/ServiceNode.test.tsx src/config-contract.test.ts --reporter=dot`

Expected: both files pass.

### Task 3: Integrated Validation And Publication

**Files:**
- Modify: `IMPLEMENTATION_STATUS.md`
- Modify: `docs/superpowers/plans/2026-07-15-admin-connector-ports.md`

**Interfaces:**
- Produces: verified connector-port stage on `codex/fix/admin-connector-ports`.

- [x] **Step 1: Run the complete admin checks**

Run:

```powershell
pnpm --filter @workspace/admin-dashboard test -- --reporter=dot
pnpm --filter @workspace/admin-dashboard typecheck
pnpm --filter @workspace/admin-dashboard build
git diff --check
```

Expected: all tests, typecheck, build and diff check pass.

- [x] **Step 2: Verify rendered desktop and mobile behavior**

Use the current Codex in-app browser tab. Reload after the change and verify page identity, nonblank DOM, no framework overlay, no console warnings/errors, status terminals on both module sides, no arrow markers or round handles, a visible target stub, and incident edge activation. Repeat at the current desktop viewport and `390 x 844`.

- [ ] **Step 3: Record status and publish**

Update `IMPLEMENTATION_STATUS.md` with exact validation counts and rendered QA evidence, commit implementation and status separately, push `codex/fix/admin-connector-ports`, fast-forward `main` only after review, and push `main`.
