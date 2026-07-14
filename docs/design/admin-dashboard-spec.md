# Apollo TF Admin Dashboard Design Specification

## Approved direction

- Use concept 2 as the visual and structural baseline.
- Preserve the left-to-right service topology as the primary workspace.
- Add the four scan-first summary modules from concept 1 above the topology.
- Keep incidents in a fixed document-flow right rail aligned with the topology. The rail must never float over lower modules; only its incident list may scroll when its content exceeds the topology height.
- Treat the generated images as layout references, not pixel-perfect text or icon assets; correct generation artifacts in code.

## Reading path

1. Four stable summary metrics: active modules, searches per minute, queue depth, and error rate.
2. Service topology showing request flow from public web through core modules to storage and providers.
3. Incident rail ordered by severity and recency.
4. Deployment and provider health tables in a full-width row below the topology and incident rail so provider status remains visible without page-level scrolling at the desktop reference viewport.

## Visualization contract

- Graph family: directed acyclic graph with a dominant left-to-right request flow.
- Layout: layered layout with stable node order and real node dimensions.
- Routing: smooth orthogonal-style edges; colors redundantly encode healthy, warning, degraded, and unknown states.
- Selection: selecting a node highlights its immediate upstream/downstream neighborhood and filters related incidents.
- Connection state: every edge has two straight, constant-width connector rails. The source-side female half has a rectangular receiving notch; the target-side male half has a stepped rectangular tongue. Healthy halves are locked together, warning halves retain a small unstable gap, degraded halves are visibly disconnected, and unknown halves remain separated in neutral gray.
- Diagnostics: warning and degraded contacts display a compact status label. A degraded contact shows the related error code only when the incident payload contains one; selecting the contact opens the linked incident and its sanitized journal excerpt in the incident rail.
- Traffic labels: request volume sits directly below the connector pair so it remains associated with the edge without covering the route.
- Attachment: each rail's outer endpoint remains fixed on the underlying service edge, so only the inner contact geometry separates and the connector never appears detached from a module.
- Motion: warning contacts use a restrained electrical flicker around the inner contact. Degraded connections never animate traffic across the physical break.
- Reduced motion: connector separation and all diagnostic labels remain visible while flicker, jitter, and animated transitions stop.
- Mobile portrait: summary metrics remain first, topology becomes a horizontally scrollable focus canvas, and incidents move below it.

## Dashboard update model

- The typed adapter exposes `demo`/`http` mode and acknowledgement capability.
- The command bar exposes the active adapter context as `Демо` for the demo adapter and `Продакшн` for the HTTP adapter.
- Demo mode starts live from the deterministic snapshot and may acknowledge incidents locally.
- Configured production HTTP mode renders the demo snapshot only as an unverified visual fallback, starts an initial GET on mount, becomes live only after validated remote data, reports offline until the first success, and reports stale only when a later request fails.
- Target production cadence is a 15-second snapshot refresh. Requests use a deterministic 10-second abort timeout and single-flight behavior so manual and interval refreshes cannot overlap.
- Every HTTP 200 JSON response is validated before state mutation. The schema covers all fields, enums and timestamps, requires exactly four metrics, bounds every collection, requires unique IDs across metrics/modules/edges/incidents/providers, and verifies edge/incident service references.
- The last known good validated remote snapshot remains visible during reconnects.
- Provider latency, module versions, incident state, and deployment availability are represented in the snapshot contract.

## Design system

- Background: near-black neutral, not blue-tinted.
- Surfaces: charcoal panels with subtle transparency and 1px neutral borders.
- Primary accent: violet for selection and commands.
- Small-text tokens meet WCAG AA: white on the refresh base and hover accents, plus subtle text on the dashboard surface, are each at least 4.5:1.
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
- `FlowingEdge`: status-aware line, physical connector pair, optional incident diagnostic, and keyboard-accessible journal action.
- `IncidentRail`: severity tabs, incident rows, expandable sanitized journal evidence, service-focus actions, demo acknowledgement, and an accessible remote read-only state.
- `DeploymentsTable`: current and available versions with update state.
- `ProviderTable`: provider health, latency, and compact trend.

## Core interactions

- Select a topology node to highlight its neighborhood and related incidents.
- Click an incident to focus its service in the topology.
- Click a warning or disconnected edge contact to focus its linked service and expand the exact incident journal entry.
- Toggle between all and open incidents.
- Acknowledge an open incident locally only in demo mode; remote mode must not imply backend acceptance.
- Reset topology focus.
- Toggle automatic refresh and manually refresh through the adapter's single-flight request.

## Container boundary

- The dashboard is a standalone Vite artifact served by nginx.
- Coolify builds it from the monorepo root with `artifacts/admin-dashboard/Dockerfile`.
- The production browser always requests same-origin `/api/admin/dashboard`; no API base, cross-origin credentials, or admin token is compiled into the bundle.
- nginx proxies only exact `GET /api/admin/dashboard` to runtime `APOLLO_API_UPSTREAM` and forwards server-side `ADMIN_DASHBOARD_TOKEN` as `X-Admin-Dashboard-Token` only on that request. Non-GET requests on the exact path return `405`; every other `/api/*` path returns `404` without proxying or token injection.
- The nginx Docker resolver and variable-form upstream defer DNS resolution until an API request while preserving the original request URI and query. The standalone image must start and answer `/healthz` when the configured upstream hostname is unresolvable.
- Root Compose omits the obsolete top-level `version` key so configuration validation is warning-free.
- The future backend endpoint must validate the forwarded token. This specification does not claim that the endpoint, auth validation, Coolify deployment, or HomeNode deployment exists.
- Journal excerpts must be sanitized server-side, bounded by the snapshot schema, and must not include credentials, authorization headers, cookies, or provider tokens.
- The workspace override pins patched `lodash@4.18.1` for the admin `dagre`/`graphlib` production paths.
