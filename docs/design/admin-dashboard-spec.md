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

- Initial implementation uses a deterministic demo snapshot behind a typed data adapter.
- Target production cadence is a 15-second snapshot refresh with last-updated and stale/offline states.
- The last known good snapshot remains visible during reconnects.
- Provider latency, module versions, incident state, and deployment availability are represented in the snapshot contract.

## Design system

- Background: near-black neutral, not blue-tinted.
- Surfaces: charcoal panels with subtle transparency and 1px neutral borders.
- Primary accent: violet for selection and commands.
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
- `IncidentRail`: severity tabs, incident rows, acknowledge and service-focus actions.
- `DeploymentsTable`: current and available versions with update state.
- `ProviderTable`: provider health, latency, and compact trend.

## Core interactions

- Select a topology node to highlight its neighborhood and related incidents.
- Click an incident to focus its service in the topology.
- Toggle between all and open incidents.
- Acknowledge an open incident locally in the demo state.
- Reset topology focus.
- Toggle automatic refresh and manually refresh the deterministic snapshot.

## Container boundary

- The dashboard is a standalone Vite artifact served by nginx.
- Coolify builds it from the monorepo root with `artifacts/admin-dashboard/Dockerfile`.
- Runtime API base is supplied through `VITE_ADMIN_API_URL` at build time.
- No public provider credentials are embedded in the frontend image.
