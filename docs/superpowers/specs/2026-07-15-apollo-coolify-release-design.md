# Apollo Closed-Beta Coolify Release Design

**Date:** 2026-07-15
**Status:** Approved for planning; remote mutation requires final owner approval

## Goal

Package Apollo Platform and Apollo TF as independently observable containers for a safe closed-beta web release on the existing HomeNode/Coolify/Caddy environment. Preserve the working Remnawave, Apollo GA, Nextcloud, RustDesk, Caddy, Coolify, and UFW infrastructure.

## Safety Boundary

- Discovery, config rendering, image builds, tests, and local disposable-stack validation are allowed.
- Remote inspection remains read-only until a complete rollout/rollback checklist is ready.
- Restart, migration, Caddy replacement/reload, DNS cutover, firewall change, volume mutation, or Coolify deployment requires explicit owner approval immediately before execution.
- No application receives Docker socket, SSH keys, Coolify credentials, Caddy admin access, UFW access, or broad host mounts.

## Container Topology

Release 1 deploys:

- `platform-web`, `platform-api`, `platform-postgres`, `platform-redis`, `admin-web`
- `tf-web`, `tf-api`, `tf-search`, `tf-integrations`, `tf-download-worker`, `tf-postgres`, `tf-redis`

Platform and TF use separate private networks, databases, Redis instances, credentials, volumes, and migration jobs. Only deliberate API-to-Platform policy traffic crosses the boundary. Module heartbeats use the authenticated public/internal API contract rather than infrastructure discovery.

## Ingress and Ports

- Public traffic enters only through existing Caddy HTTP/HTTPS ingress.
- Web/API/admin host bindings use `127.0.0.1` ports selected during preflight; no service binds `0.0.0.0`.
- PostgreSQL, Redis, worker, and internal adapter ports are not published to the host.
- Existing UFW rules remain unchanged because no new public port is required.
- Caddy routes exact approved hosts to loopback upstreams and keeps unrelated site blocks unchanged.

## Build and Runtime Contracts

- pnpm and application dependencies are pinned by the repository lockfile.
- `VITE_*` public API origins are explicit Docker build arguments, not runtime-only variables.
- Runtime secrets have no development fallback and are mounted/provided only to owning services.
- Containers use non-root runtime users where supported, read-only filesystems where practical, bounded temporary storage, init handling, and graceful shutdown.
- `/healthz` checks process liveness; `/readyz` checks only required local dependencies. External provider degradation does not restart the process.
- Each independently deployed module emits signed heartbeat version/status/freshness.

## Database and Migrations

- Numbered migrations are immutable after release and recorded in a migration history table.
- A single one-shot migration job runs before new replicas become ready.
- Destructive changes use expand/migrate/contract across releases.
- Pre-migration `pg_dump` backups are encrypted, timestamped, and retained outside the database volume.
- A disposable restore test validates that backup before production migration.
- Application roles cannot create/alter schema and RLS remains enabled for account-owned tables.

## Secrets

Required secrets include Platform signing/encryption keys, session secrets, database credentials, Redis credentials, SMTP credentials, OAuth client credentials, provider-token encryption key, admin authentication, and per-module heartbeat keys. `.env`, `.env.*`, `.ops-private`, dumps, and generated key material are excluded from Git and Docker contexts. Rotation procedures support overlapping signing keys and explicit session/provider-token revocation.

## Rollout

1. Build and test all images locally with disposable PostgreSQL, Redis, and SMTP capture.
2. Render production Compose/Coolify configuration with runtime-secret references and validate no unsafe host publication.
3. Perform read-only HomeNode capacity, listener, network, volume, Caddy, Coolify, and backup-path preflight.
4. Create owner-reviewed DNS records and wait for propagation.
5. After explicit approval, deploy Platform data services and migrations, then Platform API/web/admin.
6. Validate registration modes, invite flow, operator access, audit, and rollback.
7. Deploy TF data services/migrations, API, search, integrations, download worker, and web.
8. Validate entitlement denial/grant, search, WebSocket, download authorization, provider callback, heartbeats, and stale states.
9. Cut over Caddy host routes one at a time after explicit approval; retain prior upstream until smoke checks pass.
10. Record versions, deployed time, backup ID, validation evidence, and rollback decision in implementation status.

## Rollback

- Caddy returns a failed host to the previous upstream without changing unrelated routes.
- Application images roll back by immutable digest.
- Database rollback prefers forward-compatible old application code; restore is used only when migration compatibility cannot be preserved and requires separate approval.
- DNS TTL is lowered before cutover and restored after stability.
- GA/Remnawave paths are never part of the Apollo TF rollback unit.

## Validation

- Unit/integration/browser tests and workspace typecheck/build pass from a clean install.
- Docker image scan and production dependency audit have no unresolved high/critical findings in reachable paths.
- Compose/Coolify config inspection proves secret scope, private DB/Redis, loopback publication, health checks, dependency ordering, and resource limits.
- Local end-to-end smoke covers portal, auth, policy, TF search, download queue, heartbeat, admin, restart, stale provider, and migration/restore.
- Remote smoke after approval checks each hostname, TLS, headers, liveness/readiness, logs, resource pressure, and unaffected existing services.

## DNS Documentation

The private operator checklist is maintained in `.ops-private/APOLLO_TF_DNS.md`. It contains host records, OAuth callbacks, mail authentication records, cutover order, and rollback notes without committing public IP addresses or credentials.

## Out of Scope

- Android APK deployment.
- Public status page, public module endpoints, or direct external database/Redis access.
- Automatic Caddy/UFW/Coolify modification from application code.
- Runtime coupling or migration of Apollo GA/Remnawave infrastructure.
