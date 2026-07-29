# HomeNode and Coolify release preflight

Date: 2026-07-29

Status: `LOCAL_RELEASE_VALIDATED`

This document records the public release constraints proven before the first
Apollo Platform and Apollo TF deployment. Exact host inventory, capacity,
listeners, versions, routes, and candidate upstreams remain in the ignored
private operator record. This is not a deployment record and does not authorize
a remote change.

## Local package closure

The final fix wave validated the production manifests, exact provenance
validator, custom image targets, file-backed secret contracts, application
flows, persistence, and the complete Caddy matrix locally from
`d0f74122d9e415d7cb9571be678188657f1ce7eb`. The proof used a task-owned local
Buildx builder and only `127.0.0.1:18200..18203`, dispatched no workflow, and
passed production smoke `43/43` in `987.59s` with exact cleanup zero. It also
exercised the exact `baseline` profile
one-shot contracts against a separate disposable database, restored granted
search after restart, held a signed producer down beyond the 90-second stale
deadline before proving `healthy -> unknown -> healthy` recovery, and proved
the shared dashboard token with both real consumer UIDs on disposable native
Linux.

The checked-in release env remains intentionally non-deployable. It was
validated in explicit `production` mode against the local ignored Task 3
zero-placeholder manifest at
`.superpowers/sdd/2026-07-29-release-contract-closure/placeholder-release-manifest.json`.
That manifest is a local ignored proof input, not a deployable or tracked
release artifact. The invocation fails with exactly `19 image_provenance`,
`18 placeholder_image_digest`, `1 release_artifact`, and
`1 release_environment_value`, with `0 environment_contract` and no other
category. An approved release must replace every image with a
workflow-produced immutable reference, set the exact source commit, and pass
production validation against the downloaded release manifest. The complete
rollout and rollback order is in
`docs/operations/apollo-production-rollout.md`.

Fresh supporting validation passed pinned Caddy `10/10` in `16.30s`,
PostgreSQL 16 and 17 encrypted restore proofs at
`1 passed / 71 skipped` in `19.08s` and `18.54s`, full scripts
`194 passed / 4 opt-in skipped` in `129.49s`, API
`607 passed / 8 skipped` in `23.63s`, Platform API
`422 passed / 21 skipped` in `14.32s`, search
`142 passed / 1 skipped` in `8.26s`, integrations
`107 passed / 10 skipped` in `5.48s`, download worker
`186 passed / 2 skipped` in `8.45s`, admin `218 passed` in `11.07s`, music
player `118 passed` in `6.28s`, and root typecheck in `18.4s`. The scripts gate
included the hostile rendered-environment matrix and the tracked exact
newline-free, binary-safe credential verifier, including silent embedded-NUL
rejection. The independent task-owned resource inventory was zero. One
unrelated concurrently created ambient image and one anonymous ambient volume
were preserved. No workflow, registry publication, retained-volume access, or
remote mutation occurred.

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
2. Target-native-Linux proof that every bind-backed secret has the exact
   declared owner and mode and is readable only by its intended service. The
   disposable local proof passed, but does not substitute for target metadata.
3. A dedicated encrypted production backup destination plus recorded
   production backup/restore evidence for PostgreSQL 16 Platform/TF and
   PostgreSQL 17 integrations. Local evidence
   `pg16-disposable-proof-001` and
   `pg17-integrations-disposable-proof-001` does not authorize production
   writes.
4. Immediate recheck of listeners, disk, memory, existing service health, and
   rollback-image availability.
5. Explicit owner approval before each resource creation, migration, Caddy
   reload, hostname cutover, rollback, or data restoration.

The apex route stays reserved. The owner must explicitly approve the TF
topology dashboard as the `admin.apollot.ru` owner before that hostname is cut
over; the final local proof covers its paired Caddy/nginx credential and shared
token boundaries but does not grant that approval.

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
