# Apollo Production Rollout

Status: `LOCAL_RELEASE_VALIDATED`

This is an owner-reviewable rollout plan, not a deployment record. The final
fix wave validated the exact package locally from source commit
`fae7f7ae4760d1f8d09e5a4236d6e8af4d60a817`. HomeNode, Coolify, the host
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
| Shared `admin_dashboard_token` source                                 | UID `10001`, GID `10001`, mode `0400` |
| Manual TF admin database URL                                          | UID `0`, GID `10002`, mode `0440`     |
| Admin username/password generation sources                            | UID `0`, GID `0`, mode `0600`         |
| Generated nginx htpasswd                                              | UID `0`, GID `0`, mode `0400`         |
| Generated Caddy environment                                           | UID `0`, Caddy group, mode `0640`     |

The exact file names and owning services are load-bearing in both production
manifests and `scripts/src/coolify-release.ts`. Compose bind-backed secret
`uid`, `gid`, and `mode` remapping is not effective; host source metadata is
authoritative. Before production container creation, run the disposable
native-Linux proof and then verify the target source itself: UID `10001`
`tf-api` and root `tf-admin` must both read the same
`admin_dashboard_token`, and no retained volume may be mounted. The admin
username, password, and dashboard token must each contain exactly one safe
line; malformed multiline content must stop the consumer without output
disclosure.

## Image Evidence

The local proof built all custom targets for Linux/amd64 from
`fae7f7ae4760d1f8d09e5a4236d6e8af4d60a817`, pushed them to a disposable
loopback registry, and resolved these registry digests:

| Release variable                         | Target                     | Local proof digest                                                        |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `PLATFORM_API_IMAGE`                     | `platform-api`             | `sha256:482f864a9cab9928a724f481c640fd1a98e2a0bf3680ef3b5f20788e49c0c4d2` |
| `PLATFORM_POSTGRES_IMAGE`                | `platform-postgres`        | `sha256:aa285ccf8236190b03a67663f3bc9c55741578bba44ed3854aa06113e12f2285` |
| `PLATFORM_REDIS_IMAGE`, `TF_REDIS_IMAGE` | pinned Redis mirror        | `sha256:fe24fa2bcb59930f8863cf36a472df24efaccd8be4ee98ffe528f06d57d68dc2` |
| `TF_ADMIN_IMAGE`                         | `tf-admin`                 | `sha256:b278bea5ab422829bb7434eb30114a90ef170fdcfae9e1843ff21ad3dec8660c` |
| `TF_API_IMAGE`                           | `tf-api`                   | `sha256:beb4fdb5cddef9dc10eaffc1a931f38a54b57329fde954d6af920ed301ad5d4b` |
| `TF_DOWNLOAD_REDIS_IMAGE`                | `tf-download-redis`        | `sha256:ae0ddfce6402579584a386cc4da8d98e3e35d2d6fe5090e788ec80da7f13ddcf` |
| `TF_DOWNLOAD_WORKER_IMAGE`               | `tf-download-worker`       | `sha256:7bf8d183295b32de888e5a6f92ba32bc396468fefde1db63ee419c5284789deb` |
| `TF_INTEGRATIONS_IMAGE`                  | `tf-integrations`          | `sha256:5d0f9731cd70fae89b57bd7d63ab4c33cd578745fcadbfea2b7554be6395afb1` |
| `TF_INTEGRATIONS_POSTGRES_IMAGE`         | `tf-integrations-postgres` | `sha256:4d2c788f722fd21b64899e471cb3ee37b173727fba7a3bd84b158b98f7c6265d` |
| `TF_POSTGRES_IMAGE`                      | `tf-postgres`              | `sha256:909c29e38e0807903a79d6e3c2e89ce93aa36504d725b4d7d3bb35e9bf71e894` |
| `TF_SEARCH_IMAGE`                        | `tf-search`                | `sha256:8aff273bc2a70f9e8f602e45e4fae6785573f0531b3d104c242a40d9104d16b6` |
| `TF_WEB_IMAGE`                           | `tf-web`                   | `sha256:7ee4c3d01022a1c0895c6d1b18dbc6b4c7551aecf5e75d93b511f9a77f15c5f9` |

The disposable registry and all references were removed. These digests are
local evidence, not deployable GHCR references. An approved release workflow
must build the same source commit and produce `apollo-release-manifest.json`
with `formatVersion`, `sourceCommit`, and every exact logical name,
repository, digest, and full immutable reference. Set
`RELEASE_SOURCE_COMMIT` in the release env to that same commit, then validate
the downloaded artifact and env together:

```sh
pnpm release:validate -- --env-file '<RELEASE_ENV>' --mode production --release-manifest '<APOLLO_RELEASE_MANIFEST>'
```

Production mode requires the artifact and exact approved repositories. The
separate `loopback-local-smoke` mode accepts only loopback repositories and no
artifact. Compose rendering uses an isolated allowlist rather than ambient
release variables. Record the validated env and artifact as the forward and
rollback image map before deployment.

## Backup Gate

Local backup/restore gate evidence is separate:
`pg16-disposable-proof-001` proves PostgreSQL 16 Platform/TF compatibility and
`pg17-integrations-disposable-proof-001` proves PostgreSQL 17 integrations
compatibility. Both destroy a disposable source, decrypt into a fresh target,
and verify schema and marker data. Neither is a production backup.

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
   blocks. Supply `APOLLO_ADMIN_CADDY_USER` and
   `APOLLO_ADMIN_CADDY_PASSWORD_HASH` through the protected file-backed
   procedure below, never in the include.
3. Run `deploy/caddy/validate-caddy.ps1` locally. On the host, validate the
   complete staged Caddy configuration with the installed Caddy binary.
4. Obtain explicit reload approval. Reload Caddy; do not stop it and do not
   bind another proxy to `80` or `443`.
5. Check each approved hostname and then all unaffected existing hostnames.

### Protected credential source

One protected source directory is authoritative for both Caddy and nginx. It
contains `admin_access_user` and `admin_access_password`, each `root:root`
mode `0600` and exactly one LF-terminated line. The username must match
`[A-Za-z0-9_.@-]{1,128}` and the password must be 16..4096 bytes before its LF.
Do not independently create a second Caddy or nginx credential.

The redacted placeholders below identify private operator-owned paths:

- `<CADDY_ADMIN_USER_FILE>` and `<CADDY_ADMIN_PASSWORD_FILE>` are the two
  files under `<ADMIN_CREDENTIAL_SOURCE_DIRECTORY>`.
- `<CADDY_ADMIN_HASH_FILE>` is the generator's temporary internal hash file;
  operators do not create or retain it.
- `<CADDY_APOLLO_ENV_STAGED>` is the generated `caddy.env` under
  `<ADMIN_CREDENTIAL_GENERATION_PARENT>/<ADMIN_CREDENTIAL_GENERATION>`.
- `<CADDY_APOLLO_ENV_FILE>` is the installed Caddy handoff, owned
  `root:caddy` mode `0640`.
- `<CADDY_COMPLETE_CONFIG>`, `<CADDY_COMPLETE_CONFIG_BACKUP>`, and
  `<CADDY_APOLLO_ENV_BACKUP>` retain their rollback meanings.

The former manual `hash-password < "$1" > "$2"` path is not an approved
second source. Run the tracked generator once for a new immutable generation:

```sh
sudo env \
  APOLLO_ADMIN_SOURCE_DIRECTORY='<ADMIN_CREDENTIAL_SOURCE_DIRECTORY>' \
  APOLLO_ADMIN_GENERATION_PARENT='<ADMIN_CREDENTIAL_GENERATION_PARENT>' \
  APOLLO_ADMIN_CREDENTIAL_GENERATION='<ADMIN_CREDENTIAL_GENERATION>' \
  deploy/caddy/prepare-admin-credentials.sh
```

The generator sends the password to `caddy hash-password` over stdin, validates
the Caddy-supported bcrypt form, and derives both
`admin_access_htpasswd` (`root:root` mode `0400`) and `caddy.env`
(`root:caddy` mode `0640`) from the same username and hash. Username, password,
and hash never enter command arguments, shell history, terminal output, logs,
or tracked content. Verify equality without printing either value:

```sh
sudo deploy/caddy/verify-admin-credentials.sh \
  '<ADMIN_CREDENTIAL_GENERATION_PARENT>/<ADMIN_CREDENTIAL_GENERATION>/admin_access_htpasswd' \
  '<ADMIN_CREDENTIAL_GENERATION_PARENT>/<ADMIN_CREDENTIAL_GENERATION>/caddy.env'
```

Set `TF_ADMIN_CREDENTIAL_DIRECTORY` to that exact generation directory. Before
installing the paired Caddy handoff, preserve the complete configuration and
any prior environment. Absence of `<CADDY_APOLLO_ENV_BACKUP>` records that no
prior environment existed:

```sh
sudo cp --preserve=mode,ownership,timestamps '<CADDY_COMPLETE_CONFIG>' '<CADDY_COMPLETE_CONFIG_BACKUP>'
sudo rm -f '<CADDY_APOLLO_ENV_BACKUP>'
sudo sh -ceu 'if [ -e "$1" ]; then cp --preserve=mode,ownership,timestamps "$1" "$2"; fi' sh '<CADDY_APOLLO_ENV_FILE>' '<CADDY_APOLLO_ENV_BACKUP>'
sudo install -o root -g caddy -m 0640 '<CADDY_APOLLO_ENV_STAGED>' '<CADDY_APOLLO_ENV_FILE>'
```

Validate the complete configuration and reload it only after explicit owner
approval. Both commands source the same protected handoff in a non-xtrace
shell through the tracked helper:

```sh
sudo deploy/caddy/caddy-protected-command.sh validate '<CADDY_APOLLO_ENV_FILE>' '<CADDY_COMPLETE_CONFIG>'
sudo deploy/caddy/caddy-protected-command.sh reload '<CADDY_APOLLO_ENV_FILE>' '<CADDY_COMPLETE_CONFIG>'
```

Rotation is one paired maintenance checkpoint: create a new generation, run
the equality check, stage the new `TF_ADMIN_CREDENTIAL_DIRECTORY`, validate
the new Caddy handoff, then update nginx and reload Caddy under one approval
before reopening the admin route. Prove unauthenticated and wrong-auth
rejection plus authenticated upstream acceptance. Keep the prior generation
and Caddy environment until the rollback window closes.

For rollback, restore the prior TF admin generation and both protected Caddy
sources, validate the restored complete configuration, obtain rollback
approval, and reload. When no prior environment existed, the helper clears the
Apollo variables and runs with them unset:

```sh
sudo cp --preserve=mode,ownership,timestamps '<CADDY_COMPLETE_CONFIG_BACKUP>' '<CADDY_COMPLETE_CONFIG>'
sudo sh -ceu 'if [ -e "$1" ]; then cp --preserve=mode,ownership,timestamps "$1" "$2"; else rm -f "$2"; fi' sh '<CADDY_APOLLO_ENV_BACKUP>' '<CADDY_APOLLO_ENV_FILE>'
sudo deploy/caddy/caddy-protected-command.sh validate '<CADDY_APOLLO_ENV_FILE>' '<CADDY_COMPLETE_CONFIG>'
sudo deploy/caddy/caddy-protected-command.sh reload '<CADDY_APOLLO_ENV_FILE>' '<CADDY_COMPLETE_CONFIG>'
```

Per-host checks:

| Host                | Required result                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `api.apollot.ru`    | none/wrong/approved Authorization states all reach `/healthz` at `127.0.0.1:18200`                                        |
| `api.tf.apollot.ru` | none/wrong/approved Authorization states all reach `/api/healthz` at `127.0.0.1:18201`; callback origin remains exact     |
| `tf.apollot.ru`     | none/wrong/approved Authorization states all reach `/healthz` at `127.0.0.1:18202`                                        |
| `admin.apollot.ru`  | none and wrong credentials return `401`; the paired approved credential reaches nginx and `/healthz` at `127.0.0.1:18203` |

Every one of the 12 responses must contain exact HSTS, nosniff, frame-denial,
and referrer-policy headers and must omit `Server`.

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

The opt-in production smoke at
`fae7f7ae4760d1f8d09e5a4236d6e8af4d60a817` created and explicitly selected a
task-owned Buildx builder from the verified local Docker context, built all
custom targets, mirrored pinned Redis, validated a temporary non-zero digest
env in explicit `loopback-local-smoke` mode, and started both exact manifests.
It also proved on a disposable native-Linux Docker daemon that root `tf-admin`
and UID `10001` `tf-api` read the same UID/GID `10001`, mode `0400` dashboard
token before production containers were created.

The same run exercised all required flows and file-backed secret/command
contracts, including both profiled one-shot services against separate
disposable state, restored granted search, and signed heartbeat stale/recovery
after a producer stop longer than 90 seconds. It restarted long-running
services, proved persistence, ran the 12-case Caddy matrix through real
upstreams, scanned logs for disposable values, and reported exact cleanup zero
for builders, builder cache, containers, images, networks, volumes, registry
files, and temporary secrets.

The checked-in `deploy/coolify/release.env.example` intentionally contains zero
digests and a zero source commit. It fails closed with allowlisted
`image_provenance`, `placeholder_image_digest`, and
`release_environment_value` categories and must never be used for deployment.
No release workflow was dispatched.
