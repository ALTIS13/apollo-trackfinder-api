# Operator Release Publisher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GitHub Actions release dependency with an operator-run,
fail-closed local Docker Buildx publisher that produces the existing immutable
Apollo release manifest and digest environment fragment for Coolify.

**Architecture:** A shared release-image catalog defines every build target,
approved repository, environment binding, and the exact digest-pinned Redis
image. A new TypeScript CLI archives one explicitly approved Git commit into an
owned temporary directory, validates that archive before any registry write,
creates an owned Buildx `docker-container` builder, publishes the eleven custom
Linux/amd64 images to the fixed `ghcr.io/altis13` repositories, resolves all
custom digests, and atomically writes ignored release evidence. Docker obtains
GHCR credentials only from its existing credential store; the CLI has no
token, password, registry, or GitHub Actions input. The existing production
validator remains the authority for manifest schema, repositories, digest
references, Compose rendering, and runtime contracts.

**Tech Stack:** TypeScript on Node.js 24, Vitest, Docker Buildx, OCI/GHCR,
PowerShell operator environment, existing Coolify release validator.

## Global Constraints

- GitHub Actions must not be required, invoked, or retained as a release path.
- No paid GitHub Actions or billing-dependent feature may be required.
- GHCR is used only as an OCI registry; publication is operator-run with a
  classic PAT carrying `write:packages`, passed to `docker login` over stdin
  outside the publisher.
- The publisher must never accept or inspect registry tokens, passwords, or
  secret file values.
- Production repositories remain the exact existing
  `ghcr.io/altis13/apollo-*` allowlist plus
  `docker.io/library/redis`.
- The first production target is exactly `linux/amd64`.
- The approved source is an explicit 40-character Git commit. Build context
  must come from `git archive` for that commit, never from the ambient working
  tree.
- Production output is fixed under
  `.ops-private/releases/<release-id>/` and remains ignored by Git.
- The publisher must create and remove only resources carrying its exact
  ownership identity. It must never prune ambient builders, images, cache,
  containers, networks, or volumes.
- A partial registry push is not a release. Manifest and env output become
  visible only after every digest is resolved and validated.
- HomeNode, Coolify, Caddy, UFW, DNS, remote databases, and retained volumes
  remain unchanged during this local implementation.
- Existing Caddy ownership of host ports `80/443` and the staged rollout gates
  remain unchanged.

---

### Task 1: Publisher contract and secure CLI

**Files:**

- Create: `scripts/src/operator-release.ts`
- Create: `scripts/src/operator-release.test.ts`
- Create: `scripts/src/release-images.ts`
- Modify: `scripts/src/coolify-release.ts`
- Modify: `scripts/src/coolify-release.test.ts`

**Interfaces:**

- Consumes: the existing `ReleaseArtifact`, `ReleaseArtifactImage`, exact
  digest-pinned Redis reference from production smoke, and production artifact
  validation rules.
- Produces:

```ts
export type OperatorReleaseMode = "production" | "loopback-local-smoke";

export type OperatorReleaseOptions = {
  mode: OperatorReleaseMode;
  releaseId: string;
  sourceCommit: string;
  repositoryRoot: string;
};

export type OperatorReleaseImageTarget = {
  dockerfile: string;
  environmentNames: readonly string[];
  name: string;
  repository: string;
  target: string;
};

export type ReleaseImageCatalogEntry =
  | (OperatorReleaseImageTarget & { kind: "custom" })
  | {
      environmentNames: readonly ["PLATFORM_REDIS_IMAGE", "TF_REDIS_IMAGE"];
      kind: "external";
      name: "redis";
      reference: string;
      repository: "docker.io/library/redis";
    };

export type OperatorReleaseOutput = {
  envFragmentPath: string;
  manifestPath: string;
  releaseArtifact: ReleaseArtifact;
};

export function parseOperatorReleaseArguments(argv: readonly string[]): {
  mode: OperatorReleaseMode;
  releaseId: string;
  sourceCommit: string;
};

export function operatorReleaseOutputDirectory(
  repositoryRoot: string,
  releaseId: string,
): string;
```

- The production CLI is:

```text
pnpm release:publish -- --mode production --release-id v0.1.0-rc.1 --source-commit <40-hex>
```

- `--registry`, `--token`, `--password`, duplicate flags, unknown flags,
  malformed release IDs, zero/all-identical source commits, and non-production
  modes without an explicit loopback test dependency must fail with sanitized
  stable error codes.

- [ ] **Step 1: Write failing CLI and inventory tests**

Add tests that require:

```ts
expect(
  parseOperatorReleaseArguments([
    "--mode",
    "production",
    "--release-id",
    "v0.1.0-rc.1",
    "--source-commit",
    "a".repeat(40),
  ]),
).toEqual({
  mode: "production",
  releaseId: "v0.1.0-rc.1",
  sourceCommit: "a".repeat(40),
});
```

Assert rejection of secret-bearing/registry flags, path separators in
`releaseId`, zero commit, duplicate flags, unknown mode, and missing values.
Assert that the shared catalog contains the eleven custom target definitions
matching the current Dockerfiles, targets, GHCR repositories, and release
environment names, plus one Redis entry whose full digest-qualified reference
exactly matches the pinned Redis constant already used by production smoke.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
pnpm --filter @workspace/scripts exec vitest run src/operator-release.test.ts
```

Expected: FAIL because `operator-release.ts` and its exports do not exist.

- [ ] **Step 3: Export the shared release artifact allowlist**

Create `release-images.ts` as the only catalog owner. Derive and export the
image-name tuple, repository map, image environment map, custom build targets,
and pinned Redis reference from it. Consume/re-export those values from
`coolify-release.ts` without changing validation behavior. Rename test prose
from “workflow artifact” to “operator release manifest”.

- [ ] **Step 4: Implement the minimal parser and target inventory**

Implement strict pairwise argument parsing, release ID pattern
`^v[0-9]+[.][0-9]+[.][0-9]+(?:-[a-z0-9][a-z0-9.-]{0,63})?$`, non-zero
40-character lowercase source commits, fixed production repositories, and
fixed ignored output directory resolution. Do not add a credential parameter
or read credential-related environment variables. Do not expose
`release:publish` in root `package.json` until Task 2 supplies a complete CLI
entry point and non-zero failure behavior.

- [ ] **Step 5: Verify GREEN and regressions**

Run:

```powershell
pnpm --filter @workspace/scripts exec vitest run src/operator-release.test.ts src/coolify-release.test.ts
pnpm --filter @workspace/scripts run typecheck
```

Expected: all tests pass and TypeScript exits `0`.

- [ ] **Step 6: Commit Task 1**

```powershell
git add scripts/src/operator-release.ts scripts/src/operator-release.test.ts scripts/src/release-images.ts scripts/src/coolify-release.ts scripts/src/coolify-release.test.ts
git commit -m "feat(release): define operator publisher contract"
```

### Task 2: Owned Buildx publication and atomic evidence

**Files:**

- Modify: `scripts/src/operator-release.ts`
- Modify: `scripts/src/operator-release.test.ts`
- Modify: `scripts/src/coolify-production-smoke.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: Task 1 options and exact target inventory.
- Produces:

```ts
export type OperatorReleaseCommandResult = {
  status: number;
  stderr: string;
  stdout: string;
};

export type OperatorReleaseDependencies = {
  command(
    executable: string,
    args: readonly string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ): Promise<OperatorReleaseCommandResult>;
  randomId(): string;
  temporaryRoot(): string;
};

export async function publishOperatorRelease(
  options: OperatorReleaseOptions,
  dependencies?: OperatorReleaseDependencies,
): Promise<OperatorReleaseOutput>;
```

- Exact lifecycle:
  1. Require a clean tracked/untracked worktree.
  2. Verify the source commit object exists.
  3. Fail if `.ops-private/releases/<release-id>` already exists.
  4. Create an owned temporary root and archive the exact source commit.
  5. Install with the frozen lockfile and run the same complete release
     test/typecheck gate inside the extracted archive.
  6. Prove every custom repository tag for the release ID is absent. A partial
     prior publication makes that release ID permanently unusable.
  7. Create a unique owned Buildx `docker-container` builder.
  8. Build and push each custom target for `linux/amd64` with SBOM,
     max provenance, and exact OCI source/revision/version labels.
  9. Resolve each pushed digest with bounded retries and use the catalog's
     exact pinned Redis digest without resolving a mutable tag.
  10. Build the exact `ReleaseArtifact`, validate its shape/repositories, and
      render a deterministic env fragment.
  11. Atomically rename a staging directory into the final ignored output.
  12. Always remove the owned builder and temporary root; never prune.

- [ ] **Step 1: Write failing source/archive and command-plan tests**

Test that the build context is the extracted archive rather than
`repositoryRoot`, every custom command contains:

```text
docker buildx build
--builder <owned-name>
--platform linux/amd64
--provenance mode=max
--sbom true
--label org.opencontainers.image.source=https://github.com/ALTIS13/Apollo.TF
--label org.opencontainers.image.revision=<sourceCommit>
--label org.opencontainers.image.version=<releaseId>
--push
```

Assert eleven builds, eleven pushed-digest inspections, fixed repositories, no
credential text, no ambient builder reuse, and no prune command. Assert that
the pinned Redis reference is copied directly into the manifest and is never
passed to a mutable-tag inspection command.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm --filter @workspace/scripts exec vitest run src/operator-release.test.ts
```

Expected: FAIL because publication orchestration is missing.

- [ ] **Step 3: Implement owned command execution and digest resolution**

Before any registry inspection or push, run `corepack enable`,
`pnpm install --frozen-lockfile`, the scripts, Platform, API, admin, music,
search, integrations, and download-worker suites, and root typecheck with
`cwd` set to the extracted archive. Use `spawn`/`spawnSync` argument arrays
only. Sanitize all public failures to stable codes such as `dirty_worktree`,
`invalid_source_commit`, `release_output_exists`,
`source_validation_failed`, `release_tag_exists`, `builder_create_failed`,
`image_build_failed`, `digest_resolution_failed`,
`artifact_validation_failed`, and `cleanup_failed`. Never include paths,
stderr, image credentials, or command arguments in the returned JSON error.

- [ ] **Step 4: Write failing atomicity and cleanup tests**

Inject failures during build 6, digest 12, output rename, and builder removal.
Assert that:

- no final manifest/env fragment exists after an incomplete release;
- the temporary output is removed;
- owned builder removal is attempted exactly once;
- the primary failure wins over cleanup failure;
- cleanup-only failure is returned;
- unrelated resource names are never passed to a removal command.
- any pre-existing custom image tag fails before the builder is created or any
  image is pushed;
- a partial registry push is retained as non-release evidence and the same
  release ID cannot be retried or overwritten.

- [ ] **Step 5: Implement atomic evidence and cleanup**

Write `apollo-release-manifest.json` and `release-images.env` under a staging
directory. Sort manifest images by logical name. Render env lines in the
existing release environment order, with Redis assigned to both
`PLATFORM_REDIS_IMAGE` and `TF_REDIS_IMAGE`. Rename staging to final only after
all content is fsynced/closed and validated.

Refactor `coolify-production-smoke.test.ts` to consume the same shared custom
target catalog and pinned Redis reference. Add the complete CLI entry point and
only now expose:

```json
"release:publish": "node --experimental-strip-types -- scripts/src/operator-release.ts"
```

- [ ] **Step 6: Verify GREEN and the full scripts suite**

Run:

```powershell
pnpm --filter @workspace/scripts exec vitest run src/operator-release.test.ts
pnpm --filter @workspace/scripts test
pnpm --filter @workspace/scripts run typecheck
```

Expected: all tests pass, opt-in Docker tests remain skipped unless enabled,
and typecheck exits `0`.

- [ ] **Step 7: Commit Task 2**

```powershell
git add package.json scripts/src/operator-release.ts scripts/src/operator-release.test.ts scripts/src/coolify-production-smoke.test.ts
git commit -m "feat(release): publish immutable images locally"
```

### Task 3: Stabilize the operator source-validation gate

**Files:**

- Modify: `scripts/src/backup-contract.test.ts`

**Interfaces:**

- Consumes: Task 2's complete `pnpm --filter @workspace/scripts test` source
  gate.
- Produces: deterministic backup-contract coverage that remains fail-closed but
  does not fail solely because a Git Bash/Docker subprocess exceeds Vitest's
  five-second default.

- [ ] **Step 1: Record the existing RED evidence**

Run:

```powershell
pnpm --filter @workspace/scripts test
```

Expected on the current checkpoint: the suite is non-green with varying
five-second timeouts in unchanged parameterized backup/restore contract cases,
while the remaining scripts tests pass.

- [ ] **Step 2: Pin the Docker fixture and bound subprocess test timeouts**

Use one exact PostgreSQL 16 fixture reference:

```ts
const postgres16Fixture =
  "docker.io/library/postgres:16-bookworm@sha256:92620daddcd947f8d5ab5ba66e848702fe443d87fed30c4cea8e389fd78dfc55";
const shellContractTimeoutMs = 30_000;
const dockerContractTimeoutMs = 90_000;
```

Replace the mutable `postgres:16` mode-test image. Apply
`shellContractTimeoutMs` only to parameterized restore/object-class cases that
spawn Git Bash and have already exceeded the five-second default. Apply
`dockerContractTimeoutMs` to the non-opt-in Linux mode Docker proof. Do not
weaken assertions, skip tests, or enable the opt-in destructive restore proofs.

- [ ] **Step 3: Prove the focused file is stable**

Run the same file three times:

```powershell
1..3 | ForEach-Object {
  pnpm --filter @workspace/scripts exec vitest run src/backup-contract.test.ts --maxWorkers=1
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected each run: `70 passed`, `2 skipped`, exit `0`.

- [ ] **Step 4: Prove the complete scripts gate**

Run:

```powershell
pnpm --filter @workspace/scripts test
pnpm --filter @workspace/scripts run typecheck
```

Expected: all non-opt-in tests pass and typecheck exits `0`.

- [ ] **Step 5: Commit Task 3**

```powershell
git add scripts/src/backup-contract.test.ts
git commit -m "test(release): stabilize operator source gate"
```

### Task 4: Remove Actions and rebind rollout documentation

**Files:**

- Delete: `.github/workflows/apollo-release-images.yml`
- Modify: `IMPLEMENTATION_STATUS.md`
- Modify: `docs/operations/apollo-production-rollout.md`
- Modify: `docs/operations/homenode-coolify-preflight.md`
- Modify: `docs/operations/apollo-backup-restore.md`
- Modify: `artifacts/api-server/src/coolify-release-contract.test.ts`
- Modify: `artifacts/music-player/Dockerfile`
- Modify: `.ops-private/APOLLO_TF_HOMENODE.md` (ignored operator record)
- Modify: `.ops-private/APOLLO_TF_ROLLOUT.md` (ignored operator record)
- Modify: `scripts/src/operator-release.test.ts`

**Interfaces:**

- Consumes: Task 2 CLI and output files.
- Produces: one operator runbook with no GitHub Actions or billing gate.

- [ ] **Step 1: Write failing no-Actions documentation contract tests**

Add source/document assertions requiring:

- no tracked `.github/workflows/apollo-release-images.yml`;
- root `release:publish` points to `scripts/src/operator-release.ts`;
- production runbook uses the exact `pnpm release:publish` command;
- runbook requires `docker login ghcr.io` with password-stdin outside the
  publisher and never shows a token literal;
- runbook validates generated manifest plus the completed private release env;
- runbook records that public GHCR images allow anonymous HomeNode/Coolify
  pulls, with package visibility checked after first publication;
- no current guidance calls an artifact “workflow-produced”.
- API release contracts validate the publisher/catalog/package script instead
  of reading the deleted workflow;
- the music-player image installs exact workspace pnpm `10.33.2`, not latest.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm --filter @workspace/scripts exec vitest run src/operator-release.test.ts
```

Expected: FAIL while the workflow file and old guidance remain.

- [ ] **Step 3: Delete the workflow and update tracked/private runbooks**

Document this sequence:

```powershell
$env:CR_PAT | docker login ghcr.io -u ALTIS13 --password-stdin
Remove-Item Env:\CR_PAT
$approvedSourceCommit = git rev-parse HEAD
pnpm release:publish -- --mode production --release-id v0.1.0-rc.1 --source-commit $approvedSourceCommit
pnpm release:validate -- --env-file '<PRIVATE_RELEASE_ENV>' --mode production --release-manifest '.ops-private/releases/v0.1.0-rc.1/apollo-release-manifest.json'
```

State that `CR_PAT` is a classic PAT with `write:packages`, is never persisted
in project files, and should be revoked/rotated independently. Record that
current GitHub documentation reports Container Registry storage/bandwidth as
free and public container pulls as anonymous, but the operator must recheck
policy before future releases. Remove the failed Actions run from the active
release gate while retaining it only as historical evidence in the ignored
operator record.

Replace the API suite's workflow-source assertions with direct contracts for
the shared catalog, operator CLI entry point, source-archive validation gate,
OCI labels, SBOM/provenance flags, and fixed repository/digest handling. Pin
the music-player Dockerfile to `pnpm@10.33.2`.

- [ ] **Step 4: Verify no Actions dependency and all release contracts**

Run:

```powershell
pnpm --filter @workspace/scripts exec vitest run src/operator-release.test.ts src/coolify-release.test.ts src/caddy-release-contract.test.ts
pnpm --filter @workspace/api-server exec vitest run src/coolify-release-contract.test.ts
pnpm --filter @workspace/scripts test
pnpm run typecheck
pnpm exec prettier --check package.json scripts/src/operator-release.ts scripts/src/operator-release.test.ts IMPLEMENTATION_STATUS.md docs/operations/apollo-production-rollout.md docs/operations/homenode-coolify-preflight.md docs/operations/apollo-backup-restore.md
git diff --check
```

Expected: all tests/typechecks/format checks pass; no tracked release workflow
or active workflow-produced guidance remains.

- [ ] **Step 5: Commit Task 4**

```powershell
git add .github/workflows/apollo-release-images.yml IMPLEMENTATION_STATUS.md docs/operations/apollo-production-rollout.md docs/operations/homenode-coolify-preflight.md docs/operations/apollo-backup-restore.md artifacts/api-server/src/coolify-release-contract.test.ts artifacts/music-player/Dockerfile scripts/src/operator-release.test.ts
git commit -m "docs(release): switch to operator publication"
```

### Task 5: Exact local proof and release readiness record

**Files:**

- Modify: `IMPLEMENTATION_STATUS.md`
- Modify: `docs/operations/apollo-production-rollout.md`
- Modify: `.ops-private/APOLLO_TF_ROLLOUT.md` (ignored operator record)

**Interfaces:**

- Consumes: the final feature-branch checkpoint after Tasks 1-4.
- Produces: local publisher proof without contacting GHCR or HomeNode.

- [ ] **Step 1: Run deterministic fake-command contract proof**

Run:

```powershell
pnpm --filter @workspace/scripts exec vitest run src/operator-release.test.ts
```

Record command count, target count, cleanup evidence, and exact manifest/env
shape from the test output.

- [ ] **Step 2: Run full non-publishing validation**

Run:

```powershell
pnpm --filter @workspace/scripts test
pnpm --filter @workspace/platform-api exec vitest run --maxWorkers=2
pnpm --filter @workspace/api-server exec vitest run --maxWorkers=1
pnpm --filter @workspace/admin-dashboard exec vitest run --maxWorkers=2
pnpm --filter @workspace/music-player exec vitest run --maxWorkers=2
pnpm --filter @workspace/tf-search exec vitest run --maxWorkers=2
pnpm --filter @workspace/tf-integrations exec vitest run --maxWorkers=2
pnpm --filter @workspace/tf-download-worker exec vitest run --maxWorkers=2
pnpm run typecheck
```

Expected: all non-opt-in tests pass. No GHCR push, HomeNode mutation, Caddy
reload, Coolify resource creation, or Docker prune occurs.

- [ ] **Step 3: Record exact status**

Set status to `OPERATOR_PUBLISHER_LOCAL_VALIDATED`. State explicitly:

- the publisher is ready but no production image has been pushed;
- publication requires an owner-created classic PAT with `write:packages`;
- the exact publication command targets the final locally proven commit;
- first package visibility must be changed to public before anonymous Coolify
  pull proof;
- HomeNode rollout remains behind its existing explicit approval gates.

- [ ] **Step 4: Commit Task 5**

```powershell
git add IMPLEMENTATION_STATUS.md docs/operations/apollo-production-rollout.md
git commit -m "docs(release): record operator publisher proof"
```

## Final Whole-Branch Gate

- Run an independent whole-branch spec and quality review.
- Resolve every Critical/Important finding through the bounded fix loop.
- Verify the branch contains no token, password, generated release manifest,
  `.ops-private` file, or GHCR credential material.
- Verify no HomeNode/Coolify/Caddy/UFW/DNS mutation was performed.
- Push the feature branch and open a PR into `main`; do not create the release
  tag or publish production images until the owner approves that exact
  publication action.
