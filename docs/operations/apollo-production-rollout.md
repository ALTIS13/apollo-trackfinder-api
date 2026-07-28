# Apollo Production Rollout

Status: `LOCAL_RELEASE_VALIDATED`

This is an owner-reviewable rollout plan, not a deployment record. Task 5
validated the exact package locally from source commit
`ffdb1f5ce8df85fe487fc65697f95377d76c52bc`. HomeNode, Coolify, the host
Caddy configuration, UFW, DNS, GitHub settings, GHCR, remote databases, and
remote volumes were not contacted or mutated.

## Release Boundary

- Caddy remains the only future owner of host ports `80` and `443`.
- Coolify must create Raw Docker Compose resources without domains, Traefik
  labels, or another public proxy.
- Apollo publications are loopback-only:
  `18200` Platform API, `18201` TF API, `18202` TF web, and `18203` TF admin.
- The four public routes are:
  `api.apollot.ru`, `api.tf.apollot.ru`, `tf.apollot.ru`, and
  `admin.apollot.ru`.
- The apex, `www`, Quasar, GA, Android, and any unrelated hostname are outside
  this release.
- The retained legacy volume is only `DETACHED_UNKNOWN`. It remains unnamed,
  unmounted, unstarted, and unmodified.

## Exact Coolify Resources

Create exactly two independently versioned resources:

| Resource          | Compose manifest                             | Services                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apollo-platform` | `deploy/coolify/apollo-platform.compose.yml` | `platform-postgres`, `platform-redis`, `platform-migrate`, `platform-api`                                                                                                                                 |
| `apollo-tf`       | `deploy/coolify/apollo-tf.compose.yml`       | `tf-postgres`, `tf-migrate`, `tf-redis`, `tf-integrations-postgres`, `tf-integrations-migrate`, `tf-integrations`, `tf-search`, `tf-download-redis`, `tf-download-worker`, `tf-api`, `tf-web`, `tf-admin` |

The disabled `baseline` profile additionally defines `tf-role-bootstrap` and
`tf-baseline`. It is not part of a fresh rollout and requires separate owner
approval for an already classified and backed-up database.

Exact persistent volumes:

`apollo-platform-postgres-v1`, `apollo-platform-redis-v1`,
`apollo-tf-postgres-v1`, `apollo-tf-redis-v1`,
`apollo-tf-integrations-postgres-v1`, `apollo-tf-download-redis-v1`, and
`apollo-tf-downloads-v1`.

Exact networks:

`apollo-platform-bridge-v1`, `apollo-platform-edge-v1`,
`apollo-platform-data-v1`, `apollo-tf-data-v1`, `apollo-tf-edge-v1`,
`apollo-tf-integrations-control-v1`, `apollo-tf-integrations-data-v1`,
`apollo-tf-integrations-egress-v1`, `apollo-tf-search-control-v1`,
`apollo-tf-search-egress-v1`, `apollo-tf-download-queue-v1`,
`apollo-tf-download-control-v1`, and `apollo-tf-download-egress-v1`.

`apollo-platform` owns the internal `apollo-platform-bridge-v1`;
`apollo-tf` consumes it as an external network. Do not create a second network
with that name.

## Secret Provisioning

Provision each secret as a single file under the operator-owned Platform or TF
secret directory. Values must never be entered in Compose environment fields,
Docker labels, command arguments, logs, tickets, or release evidence.

| Consumer class                                                        | Required ownership and mode           |
| --------------------------------------------------------------------- | ------------------------------------- |
| PostgreSQL admin and role-password files                              | UID `999`, GID `999`, mode `0400`     |
| API, migration, module, queue-URL, OAuth, key, and database-URL files | UID `10001`, GID `10001`, mode `0400` |
| Manual TF admin database URL                                          | UID `0`, GID `10002`, mode `0440`     |
| TF admin username, password, and dashboard token                      | UID `0`, GID `0`, mode `0400`         |

The exact file names and owning services are load-bearing in both production
manifests and `scripts/src/coolify-release.ts`. Before container creation,
prove on the target native-Linux runtime that the declared container UID/GID
can read only its required files. The admin username, password, and dashboard
token must each contain exactly one safe line; malformed multiline content must
stop the admin container without output disclosure.

## Image Evidence

The local proof built all custom targets for Linux/amd64 from
`ffdb1f5ce8df85fe487fc65697f95377d76c52bc`, pushed them to a disposable
loopback registry, and resolved these registry digests:

| Release variable                         | Target                     | Local proof digest                                                        |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `PLATFORM_API_IMAGE`                     | `platform-api`             | `sha256:26ba569c130fb3e99d1ba82d3587d9310edd1c66e0e5d0973626be14bf97decf` |
| `PLATFORM_POSTGRES_IMAGE`                | `platform-postgres`        | `sha256:302dc1d80fe550ab9f57ca5948f89df00eedf6231598b2fd5913239cb08d48bb` |
| `PLATFORM_REDIS_IMAGE`, `TF_REDIS_IMAGE` | pinned Redis mirror        | `sha256:fe24fa2bcb59930f8863cf36a472df24efaccd8be4ee98ffe528f06d57d68dc2` |
| `TF_ADMIN_IMAGE`                         | `tf-admin`                 | `sha256:c8992a22354864873abc96c0638ecfea5c0d6d89e69446b8ea9e6010802cc437` |
| `TF_API_IMAGE`                           | `tf-api`                   | `sha256:78fc8aa4d1090a787d1328c369343129c3a6c5810a1ae3bf0bb85ff5ea0dd8d7` |
| `TF_DOWNLOAD_REDIS_IMAGE`                | `tf-download-redis`        | `sha256:19867ba1b2db87bf612fd1b8ca662cb226d695c3c07e357a6c404fc7040316cb` |
| `TF_DOWNLOAD_WORKER_IMAGE`               | `tf-download-worker`       | `sha256:019fe2df4c1594ff8a3dddc21c954b8803f882752c0e9f54c930b2ff82d54e2a` |
| `TF_INTEGRATIONS_IMAGE`                  | `tf-integrations`          | `sha256:be86713f528aa6748b1ad54a2651722f26f95aae0e454372be60f8b687df230f` |
| `TF_INTEGRATIONS_POSTGRES_IMAGE`         | `tf-integrations-postgres` | `sha256:291ff845718bf99ba34eb129ed5d154d389a5aa00d06cb90dd76e79d8f38a259` |
| `TF_POSTGRES_IMAGE`                      | `tf-postgres`              | `sha256:17ff556af18e4a0cbf6abb1e39906d8fd1a4276149a6581b2c0053510623ef71` |
| `TF_SEARCH_IMAGE`                        | `tf-search`                | `sha256:334adccc1d240561cdc536a32f0b4ab62b83a1151650a9b3e0f23e1516ee8a84` |
| `TF_WEB_IMAGE`                           | `tf-web`                   | `sha256:00d0fe4ea856a1ba295ce12837387f2e47892391eb9e0fc1ed0f1f5bb4de8c51` |

The disposable registry and all references were removed. These digests are
local evidence, not deployable GHCR references. An approved release workflow
must build the same source commit, publish immutable GHCR references, pass the
bounded manifest-inspection gate, and produce a non-placeholder release env.
Record that env as the forward and rollback image map before deployment.

## Backup Gate

Local backup/restore gate evidence is `TASK4-77b2e21-89`. It proves the tooling
against disposable PostgreSQL 16 source and target containers; it is not a
production backup.

Production backup/restore evidence is `NOT_RECORDED`. Before approving any
production migration, record a redacted evidence ID for each database, its
immutable release ID, encrypted artifact/checksum/metadata verification,
disposable restore result, schema and marker comparison, and reviewer.
Follow `docs/operations/apollo-backup-restore.md`.

## Approval Sequence

Every numbered approval is a stop point. No later mutation is implied.

1. **Approve resource and secret creation.** Recheck capacity, listeners,
   existing container health, rollback image availability, and native-Linux
   secret ownership. Record production backup/restore evidence.
2. **Approve Platform creation.** Create `apollo-platform` without a Caddy
   change. Require migration completion plus `/healthz` and `/readyz` through
   `127.0.0.1:18200`.
3. **Approve Platform application validation.** Prove closed registration,
   bootstrap/login, invitation, entitlement grant/revoke, audit, persistence,
   and backup decision.
4. **Approve Platform API ingress.** Back up Caddy, stage the exact include,
   validate the complete configuration, then reload only after approval.
5. **Approve TF creation.** Create `apollo-tf` without changing public routes.
   Require migrations, all health checks, and `127.0.0.1:18201..18203`.
6. **Approve TF application validation.** Prove OAuth bridge,
   entitlement denial/grant, search degradation and recovery, queued
   download/cancel, signed heartbeat freshness/staleness, admin authentication
   and dashboard token, web health, and persistence after service restarts.
7. **Approve each remaining hostname separately.** Cut over
   `api.tf.apollot.ru`, then `tf.apollot.ru`, then `admin.apollot.ru`; validate
   and obtain owner approval between each reload.
8. **Approve completion.** Verify all pre-existing services and record the
   final forward/rollback image map. Do not delete rollback images or retained
   data.

## Caddy Procedure

The standalone include is `deploy/caddy/apollo.caddyfile`. Its official
validation image is
`docker.io/library/caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d`;
the Linux/amd64 manifest is
`sha256:d8c17a862962def15cde69863a3a463f25a2664942eafd7bdbf050e9c3116b83`.

1. Record an owner-approved evidence ID and create a timestamped backup of the
   operator-owned complete Caddy configuration. Keep the exact path private.
2. Stage only the Apollo include. Do not alter unrelated imports or site
   blocks. Supply the admin username and Caddy password hash through the
   operator-owned runtime environment, never in the include.
3. Run `deploy/caddy/validate-caddy.ps1` locally. On the host, validate the
   complete staged Caddy configuration with the installed Caddy binary.
4. Obtain explicit reload approval. Reload Caddy; do not stop it and do not
   bind another proxy to `80` or `443`.
5. Check each approved hostname and then all unaffected existing hostnames.

Per-host checks:

| Host                | Required result                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `api.apollot.ru`    | TLS succeeds; `/healthz` routes to `127.0.0.1:18200`; security headers present                                                  |
| `api.tf.apollot.ru` | TLS succeeds; `/api/healthz` routes to `127.0.0.1:18201`; auth callback origin remains exact                                    |
| `tf.apollot.ru`     | TLS succeeds; `/healthz` routes to `127.0.0.1:18202`                                                                            |
| `admin.apollot.ru`  | unauthenticated request is rejected; approved Basic Auth reaches `127.0.0.1:18203`; dashboard API remains tokenized server-side |

Rollback order:

1. Stop further cutovers and preserve failed-release evidence.
2. Restore the recorded Caddy backup, validate the complete restored
   configuration, obtain rollback approval, and reload.
3. Recheck every restored and unaffected hostname.
4. Roll each Coolify resource back independently to its recorded digest map.
   Do not adopt, mount, rename, or delete `DETACHED_UNKNOWN`.
5. Restore data only through the separately approved backup/restore procedure;
   never write a local proof artifact into production.

## Local Proof

The opt-in production smoke built all custom targets, mirrored pinned Redis,
validated a temporary non-zero digest env, started both exact manifests,
exercised all required flows and file-backed secret/command contracts,
restarted long-running services, proved persistence, ran the exact Caddy
include against all four routes, scanned logs for disposable values, and
reported exact cleanup zero.

The checked-in `deploy/coolify/release.env.example` intentionally contains zero
digests and fails with only `placeholder_image_digest`. It must never be used
for deployment. No release workflow was dispatched.
