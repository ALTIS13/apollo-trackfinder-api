# Apollo TF Admin Topology Dashboard Implementation Plan

> **Checkpoint (2026-07-14):** Tasks 1-5 plus the final-review hardening wave are implemented on `codex/feat/admin-topology-dashboard`. Demo mode starts live and permits local acknowledgement; production HTTP mode immediately bootstraps same-origin `/api/admin/dashboard`, validates every response, applies timeout/single-flight, and keeps remote incidents read-only. nginx owns runtime upstream/token forwarding. Local verification does not constitute deployment. Backend telemetry/token validation and owner approval remain before merge to `main`.

**Goal:** Build a standalone, container-ready Apollo TF admin dashboard that combines concept 2's topology with concept 1's four-metric summary and incident workflow.

**Architecture:** A separate React/Vite package owns the admin shell. Typed demo data feeds development mode and the unverified production fallback; production immediately requests a schema-validated same-origin snapshot through nginx. Pure model/layout helpers remain independently testable, while a later backend stage must implement telemetry and forwarded-token validation.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Tailwind CSS 4, React Flow, Dagre, Framer Motion, Lucide React, Vitest, Testing Library, nginx.

## Global Constraints

- Use concept 2 as the visual baseline and concept 1 only for the four summary modules and incident ergonomics.
- Keep the dashboard separate from `artifacts/music-player`.
- Use `pnpm`; do not introduce npm or yarn lockfiles.
- Respect `prefers-reduced-motion` and preserve non-motion status encodings.
- Keep provider credentials and HomeNode details out of the frontend and Git.
- Target a standalone Coolify container.

---

### Task 1: Package, typed snapshot, and test harness

**Files:**
- Create: `artifacts/admin-dashboard/package.json`
- Create: `artifacts/admin-dashboard/tsconfig.json`
- Create: `artifacts/admin-dashboard/vite.config.ts`
- Create: `artifacts/admin-dashboard/index.html`
- Create: `artifacts/admin-dashboard/src/types/dashboard.ts`
- Create: `artifacts/admin-dashboard/src/data/demo-snapshot.ts`
- Create: `artifacts/admin-dashboard/src/lib/dashboard-model.test.ts`
- Create: `artifacts/admin-dashboard/src/lib/dashboard-model.ts`

**Interfaces:**
- Produces: `DashboardSnapshot`, `DashboardMetric`, `ServiceModule`, `ServiceEdge`, `Incident`, `ProviderHealth`.
- Produces: `getOpenIncidentCount(snapshot)`, `getServiceNeighborhood(snapshot, serviceId)`, and `filterIncidents(snapshot, filter, serviceId)`.

- [x] **Step 1: Write the failing model tests**

```ts
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo-snapshot";
import { filterIncidents, getOpenIncidentCount, getServiceNeighborhood } from "./dashboard-model";

describe("dashboard model", () => {
  it("counts only unresolved incidents", () => {
    expect(getOpenIncidentCount(demoSnapshot)).toBe(2);
  });

  it("returns the selected service and directly connected services", () => {
    expect(getServiceNeighborhood(demoSnapshot, "core-api")).toEqual(
      new Set(["public-web", "core-api", "account-integrations", "search-media", "download-worker"]),
    );
  });

  it("filters open incidents for a focused service", () => {
    expect(filterIncidents(demoSnapshot, "open", "download-worker").map((item) => item.id)).toEqual([
      "incident-download-errors",
    ]);
  });
});
```

- [x] **Step 2: Run the test and verify RED**

Run: `pnpm --filter @workspace/admin-dashboard test -- src/lib/dashboard-model.test.ts`

Expected: FAIL because `dashboard-model.ts` and the package do not exist yet.

- [x] **Step 3: Add the package, types, deterministic snapshot, and minimal model implementation**

```ts
export function getOpenIncidentCount(snapshot: DashboardSnapshot): number {
  return snapshot.incidents.filter((incident) => incident.status === "open").length;
}

export function getServiceNeighborhood(snapshot: DashboardSnapshot, serviceId: string): Set<string> {
  const ids = new Set([serviceId]);
  for (const edge of snapshot.edges) {
    if (edge.source === serviceId) ids.add(edge.target);
    if (edge.target === serviceId) ids.add(edge.source);
  }
  return ids;
}
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter @workspace/admin-dashboard test -- src/lib/dashboard-model.test.ts`

Expected: PASS with 3 tests.

### Task 2: Stable layered topology layout

**Files:**
- Create: `artifacts/admin-dashboard/src/lib/topology-layout.test.ts`
- Create: `artifacts/admin-dashboard/src/lib/topology-layout.ts`

**Interfaces:**
- Consumes: `ServiceModule[]`, `ServiceEdge[]`.
- Produces: `layoutTopology(modules, edges): { nodes: LayoutNode[]; width: number; height: number }`.

- [x] **Step 1: Write the failing layout tests**

```ts
it("places request flow in stable left-to-right layers", () => {
  const layout = layoutTopology(demoSnapshot.modules, demoSnapshot.edges);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  expect(byId.get("public-web")!.x).toBeLessThan(byId.get("core-api")!.x);
  expect(byId.get("core-api")!.x).toBeLessThan(byId.get("search-media")!.x);
  expect(layout.nodes.every((node) => node.width === 190 && node.height === 76)).toBe(true);
});
```

- [x] **Step 2: Run the test and verify RED**

Run: `pnpm --filter @workspace/admin-dashboard test -- src/lib/topology-layout.test.ts`

Expected: FAIL because `layoutTopology` is missing.

- [x] **Step 3: Implement Dagre layered layout with fixed dimensions and deterministic ordering**

```ts
graph.setGraph({ rankdir: "LR", ranksep: 72, nodesep: 34, marginx: 24, marginy: 24 });
graph.setDefaultEdgeLabel(() => ({}));
modules.forEach((module) => graph.setNode(module.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
dagre.layout(graph);
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter @workspace/admin-dashboard test -- src/lib/topology-layout.test.ts`

Expected: PASS with deterministic left-to-right coordinates.

### Task 3: Interactive topology, summary strip, and incident workflow

**Files:**
- Create: `artifacts/admin-dashboard/src/App.test.tsx`
- Create: `artifacts/admin-dashboard/src/App.tsx`
- Create: `artifacts/admin-dashboard/src/main.tsx`
- Create: `artifacts/admin-dashboard/src/components/SummaryStrip.tsx`
- Create: `artifacts/admin-dashboard/src/components/TopologyPanel.tsx`
- Create: `artifacts/admin-dashboard/src/components/ServiceNode.tsx`
- Create: `artifacts/admin-dashboard/src/components/FlowingEdge.tsx`
- Create: `artifacts/admin-dashboard/src/components/IncidentRail.tsx`
- Create: `artifacts/admin-dashboard/src/hooks/use-dashboard-state.ts`

**Interfaces:**
- Consumes: `DashboardSnapshot` and model/layout helpers.
- Produces: node focus, incident filtering, local acknowledge state, refresh controls.

- [x] **Step 1: Write failing interaction tests**

```tsx
it("filters incidents when a service is selected", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Download Worker" }));
  expect(screen.getByText("Ошибки download-worker")).toBeVisible();
  expect(screen.queryByText("Деградация SoundCloud")).not.toBeInTheDocument();
});

it("acknowledges an incident", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Подтвердить инцидент Ошибки download-worker" }));
  expect(screen.getByText("Подтверждено")).toBeVisible();
});
```

- [x] **Step 2: Run the component tests and verify RED**

Run: `pnpm --filter @workspace/admin-dashboard test -- src/App.test.tsx`

Expected: FAIL because the app components do not exist.

- [x] **Step 3: Implement the app shell and interactions**

Use React Flow for selection, pan, zoom, keyboard focus, and viewport ownership. Render four metrics before the graph, preserve the incident rail on desktop, and use semantic buttons for service nodes and incident actions.

- [x] **Step 4: Implement evidence-bearing motion**

Animate packets only on active edges, use semantic warning/degraded pulses, pause motion when the document is hidden, and disable it under `prefers-reduced-motion`.

- [x] **Step 5: Run component and model tests and verify GREEN**

Run: `pnpm --filter @workspace/admin-dashboard test`

Expected: all admin dashboard tests pass.

### Task 4: Visual system, responsive tables, and Coolify container

**Files:**
- Create: `artifacts/admin-dashboard/src/index.css`
- Create: `artifacts/admin-dashboard/src/components/AdminSidebar.tsx`
- Create: `artifacts/admin-dashboard/src/components/CommandBar.tsx`
- Create: `artifacts/admin-dashboard/src/components/DeploymentsTable.tsx`
- Create: `artifacts/admin-dashboard/src/components/ProviderTable.tsx`
- Create: `artifacts/admin-dashboard/Dockerfile`
- Create: `artifacts/admin-dashboard/nginx.conf`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: approved design tokens and `DashboardSnapshot`.
- Produces: responsive desktop/mobile shell and nginx health endpoint `/healthz`.

- [x] **Step 1: Add the accepted design tokens and responsive layout**

Implement the exact near-black, charcoal, violet, green, amber, red, blue, and gray roles from the design spec. Use 6px controls/panels, 8px metric modules, stable graph dimensions, horizontal topology scrolling on portrait, and no nested card containers.

- [x] **Step 2: Add deployments and provider tables**

Keep versions, health, latency, and update state visible without hover. Use compact in-cell trends and semantic text labels in addition to color.

- [x] **Step 3: Add the production image**

```dockerfile
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY artifacts/admin-dashboard ./artifacts/admin-dashboard
RUN pnpm install --frozen-lockfile --filter @workspace/admin-dashboard...
RUN pnpm --filter @workspace/admin-dashboard build

FROM nginx:1.27-alpine
COPY artifacts/admin-dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/artifacts/admin-dashboard/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK CMD wget -qO- http://127.0.0.1/healthz || exit 1
```

- [x] **Step 4: Validate the container configuration**

Run: `docker build -f artifacts/admin-dashboard/Dockerfile -t apollo-tf-admin:local .`

Expected: image builds and `/healthz` returns `200`.

### Task 5: Verification, documentation, and commit

**Files:**
- Modify: `IMPLEMENTATION_STATUS.md`
- Modify: `MODULES.md`
- Modify: `docs/superpowers/plans/2026-07-14-admin-topology-dashboard.md`

- [x] **Step 1: Run all focused checks**

Run: `pnpm --filter @workspace/admin-dashboard test && pnpm --filter @workspace/admin-dashboard typecheck && pnpm --filter @workspace/admin-dashboard build`

Expected: all commands pass without warnings from application code.

- [x] **Step 2: Run workspace regression checks**

Run: `pnpm run typecheck`

Expected: workspace typecheck passes.

- [x] **Step 3: Verify in the Codex in-app browser**

Open the Vite URL, validate desktop and mobile portrait, exercise node focus, incident acknowledgement, incident filters, refresh controls, and reduced-motion behavior.

- [x] **Step 4: Perform concept fidelity comparison**

Capture the implementation at the closest practical native concept viewport. Inspect concept 1, concept 2, and the implementation screenshot with `view_image`; record at least five comparison points and fix all material mismatches.

- [x] **Step 5: Update project status and commit the feature branch**

```bash
git add IMPLEMENTATION_STATUS.md MODULES.md docs/superpowers/plans/2026-07-14-admin-topology-dashboard.md .superpowers/sdd/task-5-report.md
git commit -m "docs(admin): record topology dashboard checkpoint"
```

## Final checkpoint record

- Dashboard remains isolated in `artifacts/admin-dashboard` on feature branch `codex/feat/admin-topology-dashboard`; HomeNode was not changed.
- Final-review status is based on 54 admin tests, dashboard typecheck/build, workspace typecheck, local Docker image plus disposable `/healthz`, Compose config, `git diff --check`, and parsed production audit with 0 admin paths. Exact RED/GREEN and command evidence is in `.superpowers/sdd/final-review-fix-report.md`; no Coolify/HomeNode deployment occurred.
- The typed adapter exposes mode/capabilities. Demo starts live from `demoSnapshot`; HTTP starts refreshing with an unverified visual fallback, issues an initial GET, becomes offline on first failure, live only after schema validation, and stale only after a later failure. Remote incidents are read-only. Responses have bounded Zod validation, 10-second abort timeout, and single-flight refresh.
- Production uses fixed same-origin `/api/admin/dashboard`. nginx reads runtime `APOLLO_API_UPSTREAM`, forwards server-side `ADMIN_DASHBOARD_TOKEN` as `X-Admin-Dashboard-Token`, and keeps `/healthz` independent. `lodash@4.18.1` patches the `dagre`/`graphlib` paths. The backend endpoint and token validation do not yet exist; implement both and obtain owner approval before merge to `main`.
