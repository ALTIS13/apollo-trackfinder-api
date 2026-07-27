# HomeNode and Coolify release preflight

Date: 2026-07-27

Status: `READ_ONLY_COMPLETE`

This document records the public release constraints proven before the first
Apollo Platform and Apollo TF deployment. Exact host inventory, capacity,
listeners, versions, routes, and candidate upstreams remain in the ignored
private operator record. This is not a deployment record and does not authorize
a remote change.

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
resources. Independent rollback is a release blocker and is not yet proven:

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
   - only API and web receive candidate loopback publications
   - the existing TF topology dashboard remains deployment-optional and private
     until the admin hostname/authentication decision is approved

Run these as Raw Docker Compose resources without control-plane domains or proxy
router labels. The existing ingress remains the only public boundary. Database,
Redis, search, integrations, worker, and control-plane ports remain private to
their Compose networks.

Cross-node module placement remains supported by the signed command and
heartbeat contracts, but it is not part of the first HomeNode rollout. A remote
module needs an owner-approved private route or exact HTTPS origin; it must not
receive Platform/TF database, browser session, Docker, SSH, Coolify, Caddy, or
UFW credentials.

## Release blockers

The following are required before any owner-approved remote mutation:

1. Move TF schema initialization out of API startup into a dedicated one-shot
   `tf-migrate` service with immutable migration history. The current
   `CREATE TABLE IF NOT EXISTS` startup routine is not a production migration
   or rollback contract.
2. Produce Coolify-specific Compose manifests with mandatory operator-selected
   loopback ports, no development defaults, no `build` entries, and only
   immutable image references.
3. Remove operator/admin credentials from container environment and deliver all
   runtime credentials through the existing `/run/secrets/*` boundary.
4. Prove the selected Coolify secret-to-file mechanism on rootful native Linux
   for runtime UID/GID `10001:10001` and database UID/GID `999:999`. Compose
   `uid`/`gid`/`mode` declarations alone are not ownership evidence for
   bind-backed file secrets.
5. Allocate explicit CPU, memory, PID, graceful-stop, log-size, and
   log-retention limits for both stacks.
6. Create a dedicated encrypted Apollo backup destination and pass a disposable
   PostgreSQL restore test before the first production migration. The preflight
   found no provisioned Apollo backup path.
7. Render and validate an operator-owned Caddy rollout artifact with exact
   hostname-to-loopback mappings, backup, validation, smoke, and rollback
   steps. It must include separate operator protection for
   `admin.apollot.ru` and must not change unrelated routes.
8. Complete a dry-run deployment with the exact production manifests and
   canary secrets on disposable native-Linux infrastructure.
9. Recheck listeners, disk, memory, existing container health, and rollback
   image availability immediately before approval.

The Apollo portal and Platform operator UI declared by the release architecture
are not present in the current Platform Compose stack. The apex route stays
reserved until the portal is implemented and validated. The existing TF
topology dashboard does not replace the Platform registration, invitation,
account, and entitlement administration UI.

`admin.apollot.ru` has no approved owning UI yet. Its cutover remains blocked
until the owner explicitly assigns the hostname to either the Platform operator
UI or the TF topology UI and the selected application has a complete
operator-authentication policy.

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
