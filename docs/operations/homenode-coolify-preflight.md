# HomeNode and Coolify release preflight

Date: 2026-07-29

Status: `LOCAL_RELEASE_VALIDATED`

This document records the public release constraints proven before the first
Apollo Platform and Apollo TF deployment. Exact host inventory, capacity,
listeners, versions, routes, and candidate upstreams remain in the ignored
private operator record. This is not a deployment record and does not authorize
a remote change.

## Local package closure

Task 5 validated the production manifests, digest validator, custom image
targets, file-backed secret contracts, application flows, persistence, and
Caddy routes locally from
`7ac1bcdfa51bf39f5a9c242276bef5b369d05e89`. The proof used only
`127.0.0.1:18200..18203`, dispatched no workflow, and left exact cleanup zero.
It also exercised the exact `baseline` profile one-shot contracts against a
separate disposable database, restored granted search after restart, and held
a signed producer down beyond the 90-second stale deadline before proving
`healthy -> unknown -> healthy` recovery.

The checked-in release env remains intentionally non-deployable. It fails with
only `placeholder_image_digest`; an approved release must replace every image
with a workflow-produced immutable digest. The complete rollout and rollback
order is in `docs/operations/apollo-production-rollout.md`.

The preflight's remote observation remains read-only. The retained legacy class
is recorded only as `DETACHED_UNKNOWN`; it remains unnamed, unmounted,
unstarted, and unmodified.

## Proven boundary

- The existing public ingress, container control plane, and firewall are active.
  Apollo must use the already selected ingress boundary and must not start a
  competing proxy.
- No Apollo-specific public firewall rule is required. Application publications
  use operator-selected loopback listeners behind the existing ingress.
- Existing data services and application containers remain isolated from this
  rollout. No running container, network, volume, route, service, or firewall
  rule was changed during preflight.
- Initial capacity was checked and must be checked again immediately before
  deploy. Exact evidence is private operator data.

## Listener and route findings

The development port defaults are not production-safe on this host. Production
manifests must require explicit operator-selected loopback ports and must fail
when they are omitted; they must never fall back to development values.

The private runbook records a candidate loopback allocation and current route
state. Every candidate must be checked again immediately before container
creation. All published application ports bind to `127.0.0.1`, never
`0.0.0.0` or `[::]`.

## Coolify deployment shape

The intended deployment shape uses two independently versioned Docker Compose
resources. Independent local start, restart, persistence, and teardown are
proven; remote rollback still requires an approved digest map:

1. `apollo-platform`
   - Platform PostgreSQL
   - Platform Redis
   - one-shot Platform migration
   - Platform API on an explicit operator-selected loopback port
2. `apollo-tf`
   - TF PostgreSQL and Redis
   - integrations PostgreSQL and one-shot migration
   - download queue Redis
   - TF API, search, integrations, download worker, and web
   - API, web, and the authenticated TF topology dashboard receive only the
     exact loopback publications `18201`, `18202`, and `18203`

Run these as Raw Docker Compose resources without control-plane domains or proxy
router labels. The existing ingress remains the only public boundary. Database,
Redis, search, integrations, worker, and control-plane ports remain private to
their Compose networks.

Cross-node module placement remains supported by the signed command and
heartbeat contracts, but it is not part of the first HomeNode rollout. A remote
module needs an owner-approved private route or exact HTTPS origin; it must not
receive Platform/TF database, browser session, Docker, SSH, Coolify, Caddy, or
UFW credentials.

## Remote rollout gates

Local package blockers are closed. The following still block remote mutation:

1. Owner approval for the exact `apollo-platform` and `apollo-tf` resources,
   secret files, image digest map, and rollback map.
2. Native-Linux proof that every bind-backed secret has the exact declared
   owner and mode and is readable only by its intended service.
3. A dedicated encrypted production backup destination plus a recorded
   production backup/restore evidence ID. Local evidence
   `TASK4-77b2e21-89` does not authorize production writes.
4. Immediate recheck of listeners, disk, memory, existing service health, and
   rollback-image availability.
5. Explicit owner approval before each resource creation, migration, Caddy
   reload, hostname cutover, rollback, or data restoration.

The apex route stays reserved. The owner must explicitly approve the TF
topology dashboard as the `admin.apollot.ru` owner before that hostname is cut
over; Task 5 proves its two-layer secret/token boundary locally but does not
grant that approval.

## Approval and rollout order

Remote mutation remains split into explicit checkpoints:

1. Owner approves creation of the two Coolify resources and secret files.
2. Deploy Platform data services, migration, and API without Caddy cutover.
3. Validate Platform health, readiness, registration modes, invitation flow,
   policy decisions, audit, backup, and rollback.
4. Owner approves the Platform API ingress cutover.
5. Deploy the TF stack without Caddy cutover.
6. Validate entitlement denial/grant, search, provider degradation, queued
   download, cancellation, signed heartbeats, admin auth, and stale states.
7. Owner approves the TF API and TF web ingress cutovers one hostname at a time.
   Admin remains blocked until its owning UI/auth boundary is approved.
8. Verify all pre-existing services after each cutover.

No Caddy reload, Coolify resource change, migration, UFW change, Docker cleanup,
DNS change, service restart, or volume mutation occurred during this preflight.
