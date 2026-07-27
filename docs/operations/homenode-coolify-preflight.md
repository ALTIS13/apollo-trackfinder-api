# HomeNode and Coolify release preflight

Date: 2026-07-27

Status: `READ_ONLY_COMPLETE`

This document records the non-sensitive release constraints proven before the
first Apollo Platform and Apollo TF deployment. It is not a deployment record
and does not authorize a remote change.

## Proven boundary

- Caddy is the active public ingress and owns host TCP `80/443`; it also serves
  HTTP/3 on UDP `443`.
- Coolify `4.1.2` is reachable and usable, but its stored server configuration
  describes a Traefik proxy that is not the active host ingress. Apollo must not
  assign Coolify domains or start a competing proxy on `80/443`.
- Docker, Caddy, and UFW are active. UFW keeps default incoming and routed
  traffic denied; no Apollo-specific firewall rule is required.
- Existing data services and application containers remain isolated from this
  rollout. No running container, network, volume, route, service, or firewall
  rule was changed during preflight.
- The host has sufficient initial headroom for a staged beta deployment:
  approximately `15 GiB` memory available and `112 GiB` disk available at the
  time of inspection. Capacity must be checked again immediately before deploy.

## Listener and route findings

The development defaults are not production-safe on this host:

| Default          | Conflict         |
| ---------------- | ---------------- |
| `127.0.0.1:3000` | Existing service |
| `127.0.0.1:3001` | Existing service |
| `127.0.0.1:8081` | Existing service |

`api.apollot.ru` currently routes to an unused loopback listener and returns
`502`. The other new Apollo application hostnames resolve publicly but do not
yet have complete Caddy TLS/application bindings. This is expected before
cutover and must not be treated as a successful deployment.

The host range `127.0.0.1:18200-18220` was unused during preflight. It is a
candidate range, not a permanent reservation:

| Candidate port | Intended upstream                                    |
| -------------- | ---------------------------------------------------- |
| `18200`        | Apollo Platform API (`api.apollot.ru`)               |
| `18201`        | Apollo TF API (`api.tf.apollot.ru`)                  |
| `18202`        | Apollo TF web (`tf.apollot.ru`)                      |
| `18203`        | Apollo Admin (`admin.apollot.ru`)                    |
| `18204`        | Reserved for the future Apollo portal (`apollot.ru`) |

Every candidate must be checked again with `ss` immediately before container
creation. All published application ports must bind to `127.0.0.1`, never
`0.0.0.0` or `[::]`.

## Coolify deployment shape

Use two independently rollbackable Docker Compose resources:

1. `apollo-platform`
   - Platform PostgreSQL
   - Platform Redis
   - one-shot Platform migration
   - Platform API on candidate loopback port `18200`
2. `apollo-tf`
   - TF PostgreSQL and Redis
   - integrations PostgreSQL and one-shot migration
   - download queue Redis
   - TF API, search, integrations, download worker, web, and admin
   - only API, web, and admin receive candidate loopback publications

Run these as Raw Docker Compose resources without Coolify domains or Traefik
router labels. Caddy remains the only public ingress. Database, Redis, search,
integrations, worker, and control-plane ports remain private to their Compose
networks.

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
2. Produce Coolify-specific Compose manifests with mandatory `182xx` loopback
   ports, no development defaults, no `build` entries, and only immutable image
   references.
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
are not present in the current Platform Compose stack. Port `18204` and the apex
route stay reserved until the portal is implemented and validated. The existing
TF topology dashboard does not replace the Platform registration, invitation,
account, and entitlement administration UI.

## Approval and rollout order

Remote mutation remains split into explicit checkpoints:

1. Owner approves creation of the two Coolify resources and secret files.
2. Deploy Platform data services, migration, and API without Caddy cutover.
3. Validate Platform health, readiness, registration modes, invitation flow,
   policy decisions, audit, backup, and rollback.
4. Owner approves the `api.apollot.ru` Caddy cutover.
5. Deploy the TF stack without Caddy cutover.
6. Validate entitlement denial/grant, search, provider degradation, queued
   download, cancellation, signed heartbeats, admin auth, and stale states.
7. Owner approves `api.tf.apollot.ru`, `tf.apollot.ru`, and
   `admin.apollot.ru` Caddy cutovers one hostname at a time.
8. Verify all pre-existing services after each cutover.

No Caddy reload, Coolify resource change, migration, UFW change, Docker cleanup,
DNS change, service restart, or volume mutation occurred during this preflight.
