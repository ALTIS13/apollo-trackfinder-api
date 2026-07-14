# Apollo TF Admin Dashboard Design Specification

## Approved direction

- Use concept 2 as the visual and structural baseline.
- Preserve the left-to-right service topology as the primary workspace.
- Add the four scan-first summary modules from concept 1 above the topology.
- Keep incidents in a persistent right rail with fast severity scanning and one-click service focus.
- Treat the generated images as layout references, not pixel-perfect text or icon assets; correct generation artifacts in code.

## Reading path

1. Four stable summary metrics: active modules, searches per minute, queue depth, and error rate.
2. Service topology showing request flow from public web through core modules to storage and providers.
3. Incident rail ordered by severity and recency.
4. Deployment and provider health tables below the topology for operational detail.

## Visualization contract

- Graph family: directed acyclic graph with a dominant left-to-right request flow.
- Layout: layered layout with stable node order and real node dimensions.
- Routing: smooth orthogonal-style edges; colors redundantly encode healthy, warning, degraded, and unknown states.
- Selection: selecting a node highlights its immediate upstream/downstream neighborhood and filters related incidents.
- Motion: edge packets indicate active traffic, warning edges pulse slowly, and degraded nodes use a restrained status pulse.
- Reduced motion: packets and pulses stop while status colors, dashes, labels, and focus states remain visible.
- Mobile portrait: summary metrics remain first, topology becomes a horizontally scrollable focus canvas, and incidents move below it.

## Dashboard update model

- The typed adapter exposes `demo`/`http` mode and acknowledgement capability.
- Demo mode starts live from the deterministic snapshot and may acknowledge incidents locally.
- Configured production HTTP mode renders the demo snapshot only as an unverified visual fallback, starts an initial GET on mount, becomes live only after validated remote data, reports offline until the first success, and reports stale only when a later request fails.
- Target production cadence is a 15-second snapshot refresh. Requests use a deterministic 10-second abort timeout and single-flight behavior so manual and interval refreshes cannot overlap.
- Every HTTP 200 JSON response is validated before state mutation. The schema covers all fields, enums and timestamps, bounds every collection, requires unique service/incident IDs, and verifies edge/incident service references.
- The last known good validated remote snapshot remains visible during reconnects.
- Provider latency, module versions, incident state, and deployment availability are represented in the snapshot contract.

## Design system

- Background: near-black neutral, not blue-tinted.
- Surfaces: charcoal panels with subtle transparency and 1px neutral borders.
- Primary accent: violet for selection and commands.
- Small-text tokens meet WCAG AA: white on refresh accent and subtle text on the dashboard surface are both at least 4.5:1.
- Semantic colors: green healthy, amber warning, red degraded, blue informational, gray unknown.
- Radius: 6px panels and controls; 8px only for major repeated metric modules.
- Typography: Plus Jakarta Sans for UI, Outfit for major metric values and headings.
- Icons: Lucide outline icons at consistent 1.75px stroke.
- Motion: 160ms controls, 240ms panel transitions, 1.8-3.2s evidence-bearing flow loops.

## Component inventory

- `AdminShell`: sidebar, command bar, main workspace, incident rail.
- `SummaryStrip`: four metric modules with value, comparison, and compact sparkline.
- `TopologyPanel`: controls, status legend, canvas, focus/reset behavior.
- `ServiceNode`: icon, display name, service id, version, status, traffic value.
- `FlowingEdge`: status-aware line, directional marker, optional traffic packet.
- `IncidentRail`: severity tabs, incident rows, service-focus actions, demo acknowledgement, and an accessible remote read-only state.
- `DeploymentsTable`: current and available versions with update state.
- `ProviderTable`: provider health, latency, and compact trend.

## Core interactions

- Select a topology node to highlight its neighborhood and related incidents.
- Click an incident to focus its service in the topology.
- Toggle between all and open incidents.
- Acknowledge an open incident locally only in demo mode; remote mode must not imply backend acceptance.
- Reset topology focus.
- Toggle automatic refresh and manually refresh through the adapter's single-flight request.

## Container boundary

- The dashboard is a standalone Vite artifact served by nginx.
- Coolify builds it from the monorepo root with `artifacts/admin-dashboard/Dockerfile`.
- The production browser always requests same-origin `/api/admin/dashboard`; no API base, cross-origin credentials, or admin token is compiled into the bundle.
- nginx proxies `/api/` to runtime `APOLLO_API_UPSTREAM` and forwards server-side `ADMIN_DASHBOARD_TOKEN` as `X-Admin-Dashboard-Token`. The standalone image must start and answer `/healthz` even when upstream is unavailable.
- The future backend endpoint must validate the forwarded token. This specification does not claim that the endpoint, auth validation, Coolify deployment, or HomeNode deployment exists.
- The workspace override pins patched `lodash@4.18.1` for the admin `dagre`/`graphlib` production paths.
