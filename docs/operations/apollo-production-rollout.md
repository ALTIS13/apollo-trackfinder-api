# Apollo Production Rollout

Status: `LOCAL_RELEASE_VALIDATED`

This is an owner-reviewable rollout plan, not a deployment record. Task 5
validated the exact package locally from source commit
`044c80adeffa7999063498472410bd57707265d5`. HomeNode, Coolify, the host
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
`044c80adeffa7999063498472410bd57707265d5`, pushed them to a disposable
loopback registry, and resolved these registry digests:

| Release variable                         | Target                     | Local proof digest                                                        |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `PLATFORM_API_IMAGE`                     | `platform-api`             | `sha256:11f242916fee5cd495daf674dbc3d6ae8ac03b92383dbacb49076e338eaa6535` |
| `PLATFORM_POSTGRES_IMAGE`                | `platform-postgres`        | `sha256:016be377d9396ae0bb0d69a58a029d48da970cd4e7f4270a51a73199dbb86de0` |
| `PLATFORM_REDIS_IMAGE`, `TF_REDIS_IMAGE` | pinned Redis mirror        | `sha256:fe24fa2bcb59930f8863cf36a472df24efaccd8be4ee98ffe528f06d57d68dc2` |
| `TF_ADMIN_IMAGE`                         | `tf-admin`                 | `sha256:3ea01bf6f50b27be11a7bf009a84cca13b656ac7d015dddfc5ca5fa2304050c1` |
| `TF_API_IMAGE`                           | `tf-api`                   | `sha256:ca143866eb8bf9a171d12dcddaac64c51faf049513c4259ce6be17d76c1b8157` |
| `TF_DOWNLOAD_REDIS_IMAGE`                | `tf-download-redis`        | `sha256:88d978c31c812623c4265603b07f72e0e2d9a99815e113f7cdf0d339244dafa3` |
| `TF_DOWNLOAD_WORKER_IMAGE`               | `tf-download-worker`       | `sha256:e1a35e1eea1cd2227dccfc5a8e2e88b02f6768f90e708010cac4811a0f85dd49` |
| `TF_INTEGRATIONS_IMAGE`                  | `tf-integrations`          | `sha256:dc32949c2a1c641b912a28a0141cef3f96358196a525be383b9d8dcf24fa1d05` |
| `TF_INTEGRATIONS_POSTGRES_IMAGE`         | `tf-integrations-postgres` | `sha256:3654224fca4fb6ecf8037ea183f34ac1d6a5f4288edb819b32e521b50110a75a` |
| `TF_POSTGRES_IMAGE`                      | `tf-postgres`              | `sha256:79bc94be55955036a28aa9c71df54916255620f45caedeb2d24bbc9f47d6e7a4` |
| `TF_SEARCH_IMAGE`                        | `tf-search`                | `sha256:8643a8065fda8ad55f3720502ce43641df1417f6e086c55a25d892280b42601d` |
| `TF_WEB_IMAGE`                           | `tf-web`                   | `sha256:9b770d1622ca9bbb867bfc6b2bdf375322a6df225e7be316bf6d49c8b1a13d5c` |

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
   blocks. Supply `APOLLO_ADMIN_CADDY_USER` and
   `APOLLO_ADMIN_CADDY_PASSWORD_HASH` through the protected file-backed
   procedure below, never in the include.
3. Run `deploy/caddy/validate-caddy.ps1` locally. On the host, validate the
   complete staged Caddy configuration with the installed Caddy binary.
4. Obtain explicit reload approval. Reload Caddy; do not stop it and do not
   bind another proxy to `80` or `443`.
5. Check each approved hostname and then all unaffected existing hostnames.

### Protected credential source

The redacted placeholders below identify operator-owned absolute paths. Do not
replace them in tracked files, tickets, logs, or evidence. The username source
`<CADDY_ADMIN_USER_FILE>` must be `root:caddy` mode `0640` and contain exactly one LF-terminated line
matching `[A-Za-z0-9._-]{1,64}`. The transient password
source `<CADDY_ADMIN_PASSWORD_FILE>` must be `root:root` mode `0600`. The
generated hash source `<CADDY_ADMIN_HASH_FILE>`, assembled
`<CADDY_APOLLO_ENV_STAGED>`, and installed `<CADDY_APOLLO_ENV_FILE>` must be
`root:caddy` mode `0640`. The hash must use the Caddy-supported bcrypt form
`$2a$`, `$2b$`, or `$2y$`, a two-digit cost, and 53 bcrypt payload characters.

Generate the hash through stdin. The password and hash never appear in command
arguments, shell history, terminal output, or tracked content:

```sh
sudo chown root:caddy '<CADDY_ADMIN_USER_FILE>'
sudo chmod 0640 '<CADDY_ADMIN_USER_FILE>'
sudo chown root:root '<CADDY_ADMIN_PASSWORD_FILE>'
sudo chmod 0600 '<CADDY_ADMIN_PASSWORD_FILE>'
sudo sh -ceu 'umask 077; /usr/bin/caddy hash-password < "$1" > "$2"; chown root:caddy "$2"; chmod 0640 "$2"' sh '<CADDY_ADMIN_PASSWORD_FILE>' '<CADDY_ADMIN_HASH_FILE>'
```

Validate both single-line sources and assemble the protected environment file
without printing either value:

```sh
sudo sh -ceu '
  [ "$(wc -l < "$1" | tr -d " ")" = 1 ]
  [ "$(tail -c 1 "$1" | od -An -t u1 | tr -d " ")" = 10 ]
  ! grep -q "$(printf "\r")" "$1"
  grep -Eq "^[A-Za-z0-9._-]{1,64}$" "$1"
  grep -Eq "^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$" "$2"
  IFS= read -r user < "$1"
  IFS= read -r hash < "$2"
  umask 027
  printf "APOLLO_ADMIN_CADDY_USER='\''%s'\''\nAPOLLO_ADMIN_CADDY_PASSWORD_HASH='\''%s'\''\n" "$user" "$hash" > "$3"
  chown root:caddy "$3"
  chmod 0640 "$3"
' sh '<CADDY_ADMIN_USER_FILE>' '<CADDY_ADMIN_HASH_FILE>' '<CADDY_APOLLO_ENV_STAGED>'
sudo rm -f '<CADDY_ADMIN_PASSWORD_FILE>'
```

Before installation, preserve the complete configuration and any prior
protected environment with their ownership and modes. Absence of
`<CADDY_APOLLO_ENV_BACKUP>` records that no prior environment existed. Then
install the staged source and remove only the staging/hash files:

```sh
sudo cp --preserve=mode,ownership,timestamps '<CADDY_COMPLETE_CONFIG>' '<CADDY_COMPLETE_CONFIG_BACKUP>'
sudo rm -f '<CADDY_APOLLO_ENV_BACKUP>'
sudo sh -ceu 'if [ -e "$1" ]; then cp --preserve=mode,ownership,timestamps "$1" "$2"; fi' sh '<CADDY_APOLLO_ENV_FILE>' '<CADDY_APOLLO_ENV_BACKUP>'
sudo install -o root -g caddy -m 0640 '<CADDY_APOLLO_ENV_STAGED>' '<CADDY_APOLLO_ENV_FILE>'
sudo rm -f '<CADDY_APOLLO_ENV_STAGED>' '<CADDY_ADMIN_HASH_FILE>'
```

Validate the complete configuration and reload it only after explicit owner
approval. Both commands consume the same protected source in a non-xtrace
shell through the tracked helper; do not pipe their environment or expanded
configuration to a logger. Install or execute the helper from an
owner-reviewed checkout as `root:root` mode `0755`:

```sh
sudo deploy/caddy/caddy-protected-command.sh validate '<CADDY_APOLLO_ENV_FILE>' '<CADDY_COMPLETE_CONFIG>'
sudo deploy/caddy/caddy-protected-command.sh reload '<CADDY_APOLLO_ENV_FILE>' '<CADDY_COMPLETE_CONFIG>'
```

For rollback, restore both protected sources, validate the restored complete
configuration, obtain rollback approval, and reload. The helper clears the two
Apollo credential variables first and sources the restored protected
environment only when the file exists. When no prior environment existed, both
complete-configuration commands run with those variables unset:

```sh
sudo cp --preserve=mode,ownership,timestamps '<CADDY_COMPLETE_CONFIG_BACKUP>' '<CADDY_COMPLETE_CONFIG>'
sudo sh -ceu 'if [ -e "$1" ]; then cp --preserve=mode,ownership,timestamps "$1" "$2"; else rm -f "$2"; fi' sh '<CADDY_APOLLO_ENV_BACKUP>' '<CADDY_APOLLO_ENV_FILE>'
sudo deploy/caddy/caddy-protected-command.sh validate '<CADDY_APOLLO_ENV_FILE>' '<CADDY_COMPLETE_CONFIG>'
sudo deploy/caddy/caddy-protected-command.sh reload '<CADDY_APOLLO_ENV_FILE>' '<CADDY_COMPLETE_CONFIG>'
```

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
including both profiled one-shot services against separate disposable state,
restored granted search, and signed heartbeat stale/recovery after a producer
stop longer than 90 seconds. It restarted long-running services, proved
persistence, ran the exact Caddy include against all four routes, scanned logs
for disposable values, and reported exact cleanup zero.

The checked-in `deploy/coolify/release.env.example` intentionally contains zero
digests and fails with only `placeholder_image_digest`. It must never be used
for deployment. No release workflow was dispatched.
