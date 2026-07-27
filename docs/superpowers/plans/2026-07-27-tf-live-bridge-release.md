# TF Live Bridge Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the disposable Platform/TF bridge start from built images and
pass its complete PKCE, entitlement, revocation, and WebSocket flow without
leaking secrets or leaving Docker resources.

**Architecture:** Preserve the reviewed bridge topology and supply the current
TF image startup contract through three independent internal command secrets
plus a separate authenticated download queue: a private queue Redis receives
only its generated password, while `tf-api` receives only the derived
file-backed Redis URL. The existing live smoke remains the release oracle: it
creates file-backed canaries, builds the images, starts the isolated Compose
project, runs the user/auth flow, scans outputs, and removes only its exact
resources.

**Tech Stack:** TypeScript, Node.js 20, Vitest, Docker Compose, PostgreSQL 16,
Redis 7, pnpm 10.33.2.

## Global Constraints

- Work from `codex/feat/tf-immutable-migrations` after reviewed commit
  `15d4b5a2dbea20ecad2544434a9baaf50e88d109`.
- Follow strict RED -> expected failure -> GREEN for every tracked behavior.
- No HomeNode, Coolify, Caddy, UFW, DNS, remote Docker, GitHub push, or Android
  mutation is part of this plan.
- Keep `tf-postgres -> tf-migrate -> tf-api` and
  `platform-postgres -> platform-migrate -> platform-api` ordering unchanged.
- `tf-role-bootstrap` and `tf-baseline` remain disabled under profile
  `baseline`; normal live startup never invokes them.
- Platform services receive no TF database, password, heartbeat, OAuth,
  gateway-command, or queue secret.
- `tf-api` receives only its runtime DB URL, OAuth bridge files, module
  heartbeat file, three internal gateway-command files, and the authenticated
  download-queue Redis URL file. It receives no admin, migrator, PostgreSQL
  password, or download-queue password file.
- The private `tf-download-redis` service receives only its generated queue
  password file, joins only the internal `tf-download-queue` network, stores
  data only in `tf-download-redis-data`, and publishes no host port.
- All secrets are unique, file-backed, bounded, owner-scoped, included in raw
  canary scans, excluded from logs/rendered config/tracked files, and removed
  after the run.
- No new host publication. Existing Platform and TF API publications remain
  loopback-only; database, Redis, migrator, and manual services remain private.
- Live resources use a unique Compose project. Cleanup removes only that exact
  project's containers, networks, and volumes. Never run broad prune.
- Final controller cleanup may remove only exact disposable image tags
  `apollo-platform-api:bridge`, `apollo-platform-postgres:bridge`,
  `apollo-tf-api:bridge`, `apollo-tf-postgres:bridge`, and
  `apollo-tf-download-redis:bridge` after verifying no container references
  them.

---

### Task 1: Restore TF runtime secret parity

**Files:**

- Modify: `artifacts/platform-api/docker-compose.bridge.yml`
- Modify: `artifacts/platform-api/scripts/bridge-smoke.mjs`
- Modify: `artifacts/platform-api/src/bridge-e2e.test.ts`

**Interfaces:**

- Secret name: `tf_module_heartbeat_keys`.
- Environment:
  `APOLLO_MODULE_HEARTBEAT_KEYS_FILE=/run/secrets/tf_module_heartbeat_keys`.
- Task 2 factual-RED amendment: the running TF image also requires
  `download-worker`; the exact JSON object keys are `account-integrations`,
  `search-media`, and `download-worker`.
- Each value is a separately generated random string in the existing accepted
  `32..512` byte range.
- Mount target: `tf_module_heartbeat_keys`, UID/GID `10001:10001`, mode `0400`.

- [ ] **Step 1: Write RED bridge contracts**

Require the rendered `tf-api` service to contain:

```ts
expect(tfApi.environment.APOLLO_MODULE_HEARTBEAT_KEYS_FILE).toBe(
  "/run/secrets/tf_module_heartbeat_keys",
);
expect(secretSources(tfApi)).toEqual([
  "tf_client_secret",
  "tf_module_heartbeat_keys",
  "tf_pkce_verifier",
  "tf_runtime_database_url",
]);
expect(secretMount(tfApi, "tf_module_heartbeat_keys")).toMatchObject({
  target: "tf_module_heartbeat_keys",
  uid: "10001",
  gid: "10001",
  mode: "0400",
});
```

Also require `tf_module_heartbeat_keys` in the exact top-level secret list,
mount-readability probe, generated fixture map, path containment checks,
fake-Docker fixture, and raw-secret canary set. Parse the generated JSON and
require exactly the three allowed module IDs (`account-integrations`,
`search-media`, and `download-worker`), distinct values, and bounded
lengths.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --filter @workspace/platform-api test -- src/bridge-e2e.test.ts
```

Expected: focused failures because bridge Compose/fixture do not provide the
entrypoint-required heartbeat file. Record the existing factual live RED
separately: `APOLLO_BRIDGE_LIVE=true` fails at `compose-up` with unhealthy
`tf-api`.

- [ ] **Step 3: Implement the minimal secret parity**

Generate three independent heartbeat values:

```js
const tfModuleHeartbeatKeys = {
  "account-integrations": generatedSecret(),
  "search-media": generatedSecret(),
  "download-worker": generatedSecret(),
};
```

Write `JSON.stringify(tfModuleHeartbeatKeys)` as
`tf_module_heartbeat_keys`, owned by `10001:10001` and mode `0400`. Add all
three values (`account-integrations`, `search-media`, and `download-worker`) to
`rawSecrets`; never add the serialized object or values to output.

Add the exact Compose environment and long-syntax mount:

```yaml
environment:
  APOLLO_MODULE_HEARTBEAT_KEYS_FILE: /run/secrets/tf_module_heartbeat_keys
secrets:
  - source: tf_module_heartbeat_keys
    target: tf_module_heartbeat_keys
    uid: "10001"
    gid: "10001"
    mode: "0400"
```

Declare its file source under the existing verified
`BRIDGE_SECRET_DIRECTORY`.

- [ ] **Step 4: Verify static GREEN**

Run:

```powershell
pnpm --filter @workspace/platform-api test -- src/bridge-e2e.test.ts
pnpm --filter @workspace/platform-api typecheck
node --check artifacts/platform-api/scripts/bridge-smoke.mjs
docker compose -f artifacts/platform-api/docker-compose.bridge.yml config --quiet
git diff --check
```

Expected: all non-live bridge contracts pass and the top-level/`tf-api` secret
boundaries remain exact.

- [ ] **Step 5: Verify factual startup GREEN**

Run:

```powershell
$env:APOLLO_BRIDGE_LIVE="true"
pnpm --filter @workspace/platform-api test -- src/bridge-e2e.test.ts
```

Expected: Compose reaches readiness instead of failing at `compose-up`. If the
existing end-to-end flow then exposes a later stage, preserve that factual RED
and move it to Task 2; do not broaden Task 1.

- [ ] **Step 6: Commit**

```powershell
git add artifacts/platform-api
git commit -m "fix(platform): provide TF heartbeat bridge secret"
```

---

### Task 2: Complete the live bridge release gate

**Files:**

- Modify only files directly proven by a post-startup live RED.
- Modify: `IMPLEMENTATION_STATUS.md`
- Test: `artifacts/platform-api/src/bridge-e2e.test.ts`
- Test: `artifacts/platform-api/scripts/bridge-smoke.mjs`

**Interfaces:**

- Existing success output remains:
  `Bridge smoke passed: closed, portal, PKCE, replay, grant, revoke, WebSocket`.
- Existing flow remains registration closed -> operator bootstrap/login ->
  invite-only -> member registration/verification -> entitlement grant/revoke
  -> OAuth PKCE/replay -> TF session -> WebSocket ticket/replay -> suspension.
- `APOLLO_BRIDGE_SMOKE_DIAGNOSTICS=true` may expose only sanitized stage/service
  diagnostics and never raw secret values or their digests.
- `tf-api` receives the exact internal gateway-command and authenticated
  download-queue Redis URL files required by the current image startup
  contract.
- A hardened private `tf-download-redis` service receives only its independent
  queue password, joins only `tf-download-queue`, has no host publication, and
  becomes healthy before `tf-api` starts.

- [ ] **Step 1: Record the first post-startup RED**

Run the live test after Task 1. Record exact stage, public status/body shape,
service state, and sanitized logs. Add a failing focused regression before any
production fix. If the flow already passes, no production change is permitted.

- [ ] **Step 2: Apply only the proven minimal fix**

Preserve:

- OAuth redirect, state, PKCE, replay, cookie, CSRF, entitlement, and WebSocket
  security boundaries;
- platform/TF network isolation and exact secret scope;
- migration ordering and readiness;
- response/log/raw-header canary scans;
- generic public errors and bounded lifecycle deadlines.

The implementation report must map every changed line to the factual RED. A
later unrelated drift requires a separate RED/regression cycle.

- [ ] **Step 3: Run the complete live flow**

Run:

```powershell
$env:APOLLO_BRIDGE_LIVE="true"
pnpm --filter @workspace/platform-api test -- src/bridge-e2e.test.ts
```

Expected: `423 passed`, `20 skipped` from `443` collected tests, including the
live flow, with the exact success output and no stderr.

- [ ] **Step 4: Run release validation**

Run:

```powershell
pnpm --filter @workspace/platform-api test
pnpm --filter @workspace/platform-api typecheck
pnpm --filter @workspace/platform-api build
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/api-server build
pnpm --filter @workspace/db test
pnpm run typecheck
docker compose -f docker-compose.yml config --quiet
docker compose -f artifacts/api-server/docker-compose.yml config --quiet
docker compose -f artifacts/platform-api/docker-compose.bridge.yml config --quiet
git diff --check
```

Expected: all pass. Ordinary DB integration skips remain separately backed by
the reviewed PostgreSQL 16 `34/34` proof.

- [ ] **Step 5: Audit and clean exact local resources**

Require zero containers, networks, and volumes with the live Compose project
label. Verify no container references the five exact bridge image tags
(`apollo-platform-api:bridge`, `apollo-platform-postgres:bridge`,
`apollo-tf-api:bridge`, `apollo-tf-postgres:bridge`, and
`apollo-tf-download-redis:bridge`), then remove only those tags and verify they
are absent. Do not remove Redis/Postgres base images or unrelated dangling
images/volumes.

- [ ] **Step 6: Update status and commit**

Record the live flow, exact test counts, cleanup audit, and continued absence of
remote deployment. Status may move from
`LOCAL_VALIDATED_WITH_RESIDUAL` to `LOCAL_RELEASE_VALIDATED`; it must not claim
HomeNode/Coolify deployment.

```powershell
git add IMPLEMENTATION_STATUS.md artifacts/platform-api `
  docs/superpowers/plans/2026-07-27-tf-live-bridge-release.md
git commit -m "test(platform): prove live TF bridge release"
```

- [ ] **Step 7: Independent whole-branch review**

Review `3823a39..HEAD` for privilege escape, secret leakage, migration/role
ordering, live-flow false positives, cleanup uncertainty, stale operator docs,
and remote rollout overclaims. Resolve every P0-P2 finding and repeat focused
review until `CLEAN`.
