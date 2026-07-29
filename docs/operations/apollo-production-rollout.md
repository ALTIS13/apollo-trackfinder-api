# Apollo Production Rollout

Status: `OPERATOR_PUBLISHER_LOCAL_VALIDATED`

This is an owner-reviewable rollout plan, not a deployment record. The final
publisher proof validated the exact future publication source commit
`e48af528eae166c69db5485b2afa415bc31fa7a1` locally. No production image has
been pushed. HomeNode, Coolify, the host Caddy configuration, UFW, DNS,
GitHub settings, GHCR, remote databases, and remote volumes were not contacted
or mutated.

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
`d0f74122d9e415d7cb9571be678188657f1ce7eb`, pushed them to a disposable
loopback registry, and resolved these registry digests:

| Release variable                         | Target                     | Local proof digest                                                        |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `PLATFORM_API_IMAGE`                     | `platform-api`             | `sha256:60560f7030b5f172cd668f889dc54d7cdb0ab750a7fff6b1787d278e6e80b82e` |
| `PLATFORM_POSTGRES_IMAGE`                | `platform-postgres`        | `sha256:b615aac17ef8704b9f059dc705ac1c7717ce752d350ab09636b08613777d8403` |
| `PLATFORM_REDIS_IMAGE`, `TF_REDIS_IMAGE` | pinned Redis mirror        | `sha256:fe24fa2bcb59930f8863cf36a472df24efaccd8be4ee98ffe528f06d57d68dc2` |
| `TF_ADMIN_IMAGE`                         | `tf-admin`                 | `sha256:9414474af8533e4b70460126e5ea644f800113591c48c074742f553a1e3b9a09` |
| `TF_API_IMAGE`                           | `tf-api`                   | `sha256:3330741dc8413704aea069a1070858d0075759c68a0d75444be7fb6e501959f1` |
| `TF_DOWNLOAD_REDIS_IMAGE`                | `tf-download-redis`        | `sha256:199c9f5f2c8085a2fcf4c115bacb1ecd7eb454d64c84921302b172e9dfad1de6` |
| `TF_DOWNLOAD_WORKER_IMAGE`               | `tf-download-worker`       | `sha256:873b6a95e3508fb232632c265e6007985aa8b0d067e6475bebef40ca05a0eae7` |
| `TF_INTEGRATIONS_IMAGE`                  | `tf-integrations`          | `sha256:f2d4ac1f58afdb9e9bc776e9d8463bd49059d77b36ab62abfc9854e8234a1386` |
| `TF_INTEGRATIONS_POSTGRES_IMAGE`         | `tf-integrations-postgres` | `sha256:04793e9c96c9aaacdf7840b21c421f4e0ea72405081cc4c6dc6e2b654ac5cadc` |
| `TF_POSTGRES_IMAGE`                      | `tf-postgres`              | `sha256:e8e380cb07ccfe1d946bb72fcd752ccd31557986d5d360148cbc7a8223df719f` |
| `TF_SEARCH_IMAGE`                        | `tf-search`                | `sha256:fc6234dfc9dd0c6ea5c34352e6710710e5e4113c25e61c9cdad4648740a844fe` |
| `TF_WEB_IMAGE`                           | `tf-web`                   | `sha256:b279663a21e27158b0077e42b2cbacd2453282f5632f4c5c430b48b01d54a327` |

The disposable registry and all references were removed. These digests are
local evidence, not deployable GHCR references. The operator-run publisher is
the only active publication procedure. It validates the source archive before
building the approved source commit and writes `apollo-release-manifest.json`,
`release-images.env`, and its completion marker under the ignored private
release directory.

The following is a future owner-operated procedure, not a command executed by
this local proof. It requires a separate explicit owner approval for that
specific publication action. Before running it, the owner must create a
classic PAT with `write:packages` and place it only in the current PowerShell
environment. It is never persisted in project files and must be revoked or
rotated independently. The publisher accepts no credentials or registry
options, so authenticate outside it:

```powershell
$env:CR_PAT | docker login ghcr.io -u ALTIS13 --password-stdin
Remove-Item Env:\CR_PAT
$approvedSourceCommit = 'e48af528eae166c69db5485b2afa415bc31fa7a1'
pnpm release:publish -- --mode production --release-id v0.1.0-rc.1 --source-commit $approvedSourceCommit
pnpm release:validate -- --env-file '<PRIVATE_RELEASE_ENV>' --mode production --release-manifest '.ops-private/releases/v0.1.0-rc.1/apollo-release-manifest.json'
```

Set `RELEASE_SOURCE_COMMIT` in the completed private release env to the same
commit and validate it with the generated manifest. After the first package is
published, the owner must explicitly change its visibility to public before an
anonymous Coolify pull proof. That visibility action and every later HomeNode
rollout action remain separate approval gates; no production publish, tag,
release, package setting, or Coolify pull proof is implied by this record.

The local fake-command publisher proof passed `47/47` in `2.24s`. It covers
`11` custom Linux/amd64 targets plus pinned Redis, `51` successful-path
commands, task-owned builder/staging/temporary-root cleanup, and a manifest
with exact `formatVersion`/`images`/`sourceCommit` keys. Each of the `12`
image entries has only `imageDigest`/`imageReference`/`name`/`repository`; the
environment has `RELEASE_SOURCE_COMMIT`, `13` ordered image variables, and a
final LF. No credential value is present in the artifact or environment.

The final non-publishing matrix recorded scripts `243 passed / 4 skipped` in
`261.96s`, API `603 passed / 8 skipped` in `56.07s`, admin `218 passed` in
`20.25s`, music player `118 passed` in `10.04s`, search `142 passed / 1
skipped` in `6.67s`, download worker `186 passed / 2 skipped` in `8.70s`, and
root typecheck in `19.8s`. The complete nine-command non-publishing matrix is
green after clean-source exact reruns: Platform API passed `422 passed / 21
skipped` across `18` files with `6` skipped in `28.22s`, and TF integrations
passed `107 passed / 10 skipped` across `14` files in `5.60s`. The two
Git-ignored, untracked generated-output directories were moved intact to
ignored `.ops-private` quarantine after the local deletion policy rejected
recursive removal; they were not deleted. This local evidence does not
authorize publication or rollout.

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
`d0f74122d9e415d7cb9571be678188657f1ce7eb` created and explicitly selected a
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
files, and temporary secrets. The fresh smoke passed `43/43` in `987.59s`;
the independent post-smoke inventory also returned zero for every task-owned
container, network, volume, image reference, builder, cache, registry file,
temporary path, and repository `.tmp` item. One unrelated concurrently created
ambient image and one anonymous ambient volume matched no task ownership
contract and were preserved; no broad prune was used.

The checked-in `deploy/coolify/release.env.example` intentionally contains zero
digests and a zero source commit. It was validated in explicit `production` mode
against the local ignored Task 3 zero-placeholder manifest at
`.superpowers/sdd/2026-07-29-release-contract-closure/placeholder-release-manifest.json`.
That manifest is a local ignored proof input, not a deployable or tracked
release artifact. The invocation fails closed with exactly `19 image_provenance`,
`18 placeholder_image_digest`, `1 release_artifact`, and
`1 release_environment_value`, with `0 environment_contract` and no other
category. It must never be used for deployment. Fresh supporting validation
passed pinned Caddy `10/10` in `16.30s`, PostgreSQL 16 and 17 restore proofs
at `1 passed / 71 skipped` in `19.08s` and `18.54s`, full scripts
`194 passed / 4 opt-in skipped` in `129.49s`, API
`607 passed / 8 skipped` in `23.63s`, Platform API
`422 passed / 21 skipped` in `14.32s`, search
`142 passed / 1 skipped` in `8.26s`, integrations
`107 passed / 10 skipped` in `5.48s`, download worker
`186 passed / 2 skipped` in `8.45s`, admin `218 passed` in `11.07s`, music
player `118 passed` in `6.28s`, and root typecheck in `18.4s`. The scripts gate
included both the hostile rendered-environment matrix and the binary-safe
newline-free credential verifier with silent embedded-NUL rejection. No
operator publication was run.
