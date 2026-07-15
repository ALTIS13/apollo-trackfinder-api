# Authenticated Module Heartbeat Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-module HMAC-authenticated push heartbeat boundary whose in-memory 90-second freshness state drives truthful module versions/statuses in the existing admin dashboard.

**Architecture:** A focused `ModuleHeartbeatService` owns strict configuration, raw-body HMAC verification, replay protection, bounded in-memory observations, and fake-clock freshness. A raw-body Express router runs before the general JSON parser and writes only through that service. The admin snapshot overlays observations for configured module IDs before metrics and topology edges are derived, while the shared contract/UI expose optional `lastHeartbeatAt`.

**Tech Stack:** TypeScript 5.9, Node.js crypto, Express 5, Zod, React 19, Vitest 4, Docker Compose, pnpm 10.33.2.

## Global Constraints

- Heartbeat state is process-local only; after API restart a managed module is `unknown` until its next accepted heartbeat.
- Freshness uses server receipt time, remains valid through age `90_000 ms`, and expires when age is greater than `90_000 ms`; the signed client timestamp never extends freshness.
- Authentication uses a per-module 32-512 character secret and HMAC-SHA256 over the exact raw request body.
- The auth timestamp window is 60 seconds; the nonce replay window is five minutes and at most 128 nonces per module.
- The request body is strict JSON, schema version `1`, and no larger than 8 KiB.
- Heartbeat ingestion is disabled without a valid non-empty `APOLLO_MODULE_HEARTBEAT_KEYS` JSON map, but API liveness remains available.
- No Docker socket, SSH, Coolify API, Caddy, UFW, HomeNode inventory, provider probes, incident/log payloads, Redis persistence, or PostgreSQL persistence.
- Heartbeat secrets/signatures must never reach browser code, response bodies, or logs.
- Do not access or modify HomeNode, Coolify, Caddy, Remnawave, or UFW in this stage.

---

## File Map

- `lib/admin-dashboard-contract/src/index.ts`: optional `lastHeartbeatAt` in the strict shared module DTO.
- `artifacts/admin-dashboard/src/components/DeploymentsTable.tsx`: existing table gains the observation-time column.
- `artifacts/admin-dashboard/src/data/demo-snapshot.ts`: realistic demo heartbeat timestamps.
- `artifacts/api-server/src/lib/module-heartbeat.ts`: configuration, strict payload schema, canonical HMAC, replay/order checks, in-memory registry, and freshness snapshots.
- `artifacts/api-server/src/routes/module-heartbeats.ts`: raw-body HTTP adapter and stable status/error mapping.
- `artifacts/api-server/src/app.ts`: mount heartbeat router before general JSON parsing.
- `artifacts/api-server/src/lib/admin-telemetry.ts`: overlay managed heartbeat observations before derived metrics/edges.
- `artifacts/api-server/src/routes/admin.ts`: inject the singleton heartbeat snapshot into runtime dashboard collection.
- `artifacts/api-server/src/lib/logger.ts`: redact heartbeat signature/auth headers.
- `docker-compose.yml`, `artifacts/api-server/docker-compose.yml`: API-only runtime key-map wiring.
- `.gitignore`, `.dockerignore`: exclude runtime env/private operations data from source and build contexts.
- `MODULES.md`, `IMPLEMENTATION_STATUS.md`: exact contract, validation evidence, commits, and next stage.

---

### Task 1: Shared heartbeat freshness contract and existing dashboard table

**Files:**
- Modify: `lib/admin-dashboard-contract/src/index.ts`
- Modify: `lib/admin-dashboard-contract/src/index.test.ts`
- Modify: `artifacts/admin-dashboard/src/components/DeploymentsTable.tsx`
- Modify: `artifacts/admin-dashboard/src/data/demo-snapshot.ts`
- Modify: `artifacts/admin-dashboard/src/App.test.tsx`
- Test: `artifacts/admin-dashboard/src/data/http-snapshot-adapter.test.ts`

**Interfaces:**
- Consumes: existing `timestampSchema`, `ServiceModule`, shared `parseDashboardSnapshot`, and deployment table styling.
- Produces: `ServiceModule.lastHeartbeatAt?: string` accepted identically by API and UI; a `Последний сигнал` table column with `Нет данных` fallback.

- [ ] **Step 1: Write failing shared-contract and UI tests**

Add a contract assertion that a valid offset timestamp survives parsing and malformed time is rejected:

```ts
it("accepts an optional module heartbeat receipt time", () => {
  const snapshot = {
    ...validSnapshot,
    modules: validSnapshot.modules.map((module, index) =>
      index === 0
        ? { ...module, lastHeartbeatAt: "2026-07-15T04:31:02.123Z" }
        : module,
    ),
  };
  expect(parseDashboardSnapshot(snapshot)).toEqual(snapshot);
  expect(() =>
    parseDashboardSnapshot({
      ...snapshot,
      modules: [{ ...snapshot.modules[0], lastHeartbeatAt: "not-a-time" }],
    }),
  ).toThrow("Invalid admin dashboard snapshot");
});
```

In `App.test.tsx`, assert one real heartbeat renders in the deployment table and a module without it renders `Нет данных`. In `http-snapshot-adapter.test.ts`, include `lastHeartbeatAt` in a valid 200 response and assert it survives validation.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
pnpm --filter @workspace/admin-dashboard-contract test
pnpm --filter @workspace/admin-dashboard test -- --run src/App.test.tsx src/data/http-snapshot-adapter.test.ts
```

Expected: the contract rejects `lastHeartbeatAt` as an unknown strict field and the UI has no `Последний сигнал` header/value.

- [ ] **Step 3: Add the minimal contract and table implementation**

Extend only the module schema:

```ts
const moduleSchema = z
  .object({
    id: idSchema,
    name: labelSchema,
    status: healthStatusSchema,
    version: z.string().trim().min(1).max(128),
    availableVersion: z.string().trim().min(1).max(128).optional(),
    lastDeploymentAt: timestampSchema.optional(),
    lastHeartbeatAt: timestampSchema.optional(),
    requestsPerMinute: nonNegativeNumberSchema,
  })
  .strict();
```

Add a `Последний сигнал` header/cell beside `Последний деплой`, reusing the existing formatter:

```tsx
<td>
  {module.lastHeartbeatAt === undefined ? (
    <span className="table-empty-value">Нет данных</span>
  ) : (
    <time dateTime={module.lastHeartbeatAt}>
      {deploymentFormatter.format(new Date(module.lastHeartbeatAt))}
    </time>
  )}
</td>
```

Give the heartbeat-managed demo modules fixed ISO timestamps close to `demoSnapshot.generatedAt`; leave at least one unobserved module without the field.

- [ ] **Step 4: Run GREEN verification**

Run:

```powershell
pnpm --filter @workspace/admin-dashboard-contract test
pnpm --filter @workspace/admin-dashboard test -- --run src/App.test.tsx src/data/http-snapshot-adapter.test.ts
pnpm --filter @workspace/admin-dashboard typecheck
```

Expected: all selected tests and typecheck pass.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- lib/admin-dashboard-contract/src/index.ts lib/admin-dashboard-contract/src/index.test.ts artifacts/admin-dashboard/src/components/DeploymentsTable.tsx artifacts/admin-dashboard/src/data/demo-snapshot.ts artifacts/admin-dashboard/src/App.test.tsx artifacts/admin-dashboard/src/data/http-snapshot-adapter.test.ts
git commit -m "feat(admin): expose module heartbeat freshness"
```

---

### Task 2: HMAC service, replay protection, and bounded in-memory registry

**Files:**
- Create: `artifacts/api-server/src/lib/module-heartbeat.ts`
- Create: `artifacts/api-server/src/lib/module-heartbeat.test.ts`

**Interfaces:**
- Consumes: `node:crypto`, Zod, the shared `HealthStatus` type, `APOLLO_MODULE_HEARTBEAT_KEYS` raw JSON.
- Produces: `parseModuleHeartbeatKeys(raw)`, `createModuleHeartbeatSignature(input)`, `ModuleHeartbeatService.ingest(input)`, `ModuleHeartbeatService.snapshot(at?)`, `moduleHeartbeatService`, `ModuleHeartbeatObservation`, and stable ingest-result unions.

- [ ] **Step 1: Write failing pure-service tests**

Create tests with a mutable fake clock and two module keys. Cover:

```ts
const keys = new Map([
  ["search-media", "s".repeat(32)],
  ["account-integrations", "a".repeat(32)],
]);
let now = Date.parse("2026-07-15T04:31:02.000Z");
const service = new ModuleHeartbeatService({ keys, now: () => now });
const body = Buffer.from(JSON.stringify({
  schemaVersion: 1,
  status: "healthy",
  version: "2.15.0",
  deployedAt: "2026-07-15T04:30:00.000Z",
  requestsPerMinute: 42,
}));
```

Assert: valid acceptance; exact body changes break signature; one key cannot report the other module; unknown module follows unauthorized result; missing/wrong/malformed signatures; timestamps outside +/-60 seconds; nonce replay; 129 nonces remain bounded; equal timestamp with unique nonce succeeds; lower signed timestamp after a newer acceptance returns `stale`; strict payload rejects unknown fields/non-finite/negative/over-one-million RPM; fresh status through 90 seconds; status `unknown` and RPM `0` after 90 seconds; historical version/deployment/receipt time remain; empty service after restart has managed `unknown` entries with no receipt time; config rejects non-object JSON, unknown IDs, over 128 entries, and secrets outside 32-512 characters.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
pnpm --filter @workspace/api-server test -- --run src/lib/module-heartbeat.test.ts
```

Expected: FAIL because `module-heartbeat.ts` does not exist.

- [ ] **Step 3: Implement strict configuration and signing helpers**

Use a fixed module allowlist matching the existing snapshot IDs and a strict Zod payload:

```ts
const MODULE_IDS = [
  "public-web", "core-api", "account-integrations", "search-media",
  "download-worker", "postgresql", "redis", "queue-redis", "media-storage",
] as const;

const moduleHeartbeatPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["healthy", "warning", "degraded", "unknown"]),
  version: z.string().trim().min(1).max(128),
  deployedAt: z.string().datetime({ offset: true }).optional(),
  requestsPerMinute: z.number().finite().min(0).max(1_000_000).optional(),
}).strict();
```

Canonicalize exactly:

```ts
export function createModuleHeartbeatSignature(input: SignatureInput): string {
  const bodyHash = createHash("sha256").update(input.rawBody).digest("hex");
  const canonical = [
    "POST",
    `/api/internal/modules/${input.moduleId}/heartbeat`,
    input.timestamp,
    input.nonce,
    bodyHash,
  ].join("\n");
  return `v1=${createHmac("sha256", input.secret).update(canonical).digest("hex")}`;
}
```

Return an empty map for missing/invalid config so ingestion is disabled without crashing startup. Do not log the raw config or parse error text.

- [ ] **Step 4: Implement ingest and freshness snapshots**

Use a discriminated union:

```ts
export type ModuleHeartbeatIngestResult =
  | { kind: "accepted"; receivedAt: string }
  | { kind: "disabled" }
  | { kind: "unauthorized" }
  | { kind: "invalid" }
  | { kind: "stale" };
```

Authenticate against the configured secret or a process-local dummy secret, compare equal-length digests with `timingSafeEqual`, validate timestamp/nonce/body, then mutate state only for accepted input. `snapshot()` returns every configured module with `managed: true`; missing or expired entries return `unknown`, while expired entries preserve version/deployment/`lastHeartbeatAt` and reset RPM to `0`.

- [ ] **Step 5: Run GREEN verification**

Run:

```powershell
pnpm --filter @workspace/api-server test -- --run src/lib/module-heartbeat.test.ts
pnpm --filter @workspace/api-server typecheck
```

Expected: pure-service tests and typecheck pass.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- artifacts/api-server/src/lib/module-heartbeat.ts artifacts/api-server/src/lib/module-heartbeat.test.ts
git commit -m "feat(api): add authenticated heartbeat registry"
```

---

### Task 3: Raw-body route and truthful dashboard overlay

**Files:**
- Create: `artifacts/api-server/src/routes/module-heartbeats.ts`
- Create: `artifacts/api-server/src/routes/module-heartbeats.test.ts`
- Modify: `artifacts/api-server/src/app.ts`
- Modify: `artifacts/api-server/src/lib/admin-telemetry.ts`
- Modify: `artifacts/api-server/src/lib/admin-telemetry.test.ts`
- Modify: `artifacts/api-server/src/routes/admin.ts`
- Modify: `artifacts/api-server/src/lib/logger.ts`

**Interfaces:**
- Consumes: Task 2 `ModuleHeartbeatService`, singleton `moduleHeartbeatService`, and `ModuleHeartbeatObservation[]`; Task 1 `ServiceModule.lastHeartbeatAt`.
- Produces: `createModuleHeartbeatRouter({ service })`, `moduleHeartbeatRouter`, route-before-JSON mounting, `getModuleHeartbeats()` snapshot dependency, and overlaid admin module state.

- [ ] **Step 1: Write failing real-HTTP route tests**

Build an isolated Express app that mounts `createModuleHeartbeatRouter` before `express.json()`. Sign an exact `Buffer` with Task 2's helper. Assert:

- disabled returns `503 {error:"heartbeat_disabled"}`;
- missing/wrong/other-module signatures return identical `401 {error:"unauthorized"}`;
- malformed strict JSON returns `400 {error:"invalid_heartbeat"}`;
- out-of-order signed timestamp returns `409 {error:"stale_heartbeat"}`;
- valid request returns `202`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and server-generated `receivedAt`;
- `GET` on the exact route returns `405 {error:"method_not_allowed"}`;
- a body over 8 KiB returns `413 {error:"heartbeat_too_large"}` without mutation;
- responses and captured logs contain no secret, signature, raw body, version string, or internal thrown message.

- [ ] **Step 2: Add failing snapshot-overlay tests**

Inject heartbeat states into `createAdminDashboardSnapshot`:

```ts
getModuleHeartbeats: () => [
  {
    moduleId: "search-media",
    managed: true,
    status: "warning",
    version: "3.0.0",
    deployedAt: "2026-07-15T04:30:00.000Z",
    lastHeartbeatAt: "2026-07-15T04:31:02.000Z",
    requestsPerMinute: 77,
  },
],
```

Assert managed values overlay, `core-api` retains local health when unmanaged, active-module count and connected edge statuses derive from the overlay, and a managed missing/stale value is `unknown` without fabricated `lastHeartbeatAt`.

- [ ] **Step 3: Run RED verification**

Run:

```powershell
pnpm --filter @workspace/api-server test -- --run src/routes/module-heartbeats.test.ts src/lib/admin-telemetry.test.ts
```

Expected: route module and heartbeat dependency do not exist.

- [ ] **Step 4: Implement the raw-body adapter and mount order**

The router maps only stable result kinds:

```ts
router.post(
  "/internal/modules/:moduleId/heartbeat",
  express.raw({ type: "application/json", limit: "8kb" }),
  (req, res) => {
    const result = service.ingest({
      moduleId: req.params.moduleId ?? "",
      timestamp: req.get("X-Apollo-Heartbeat-Timestamp"),
      nonce: req.get("X-Apollo-Heartbeat-Nonce"),
      signature: req.get("X-Apollo-Heartbeat-Signature"),
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    });
    // Map accepted/disabled/unauthorized/invalid/stale to the specified bodies.
  },
);
```

Mount `app.use("/api", moduleHeartbeatRouter)` after CORS and before `express.json()`. Add an error middleware scoped to `entity.too.large` for the stable `413`; do not leak parser messages. Explicitly redact `x-apollo-heartbeat-signature`, timestamp, and nonce header paths in Pino.

- [ ] **Step 5: Implement snapshot overlay before derivation**

Add to `AdminDashboardSnapshotDependencies`:

```ts
getModuleHeartbeats: () => ReadonlyArray<ModuleHeartbeatObservation>;
```

Build the existing base modules, then overlay only `managed` observations by ID. Apply `lastHeartbeatAt` only when present; remove local `lastDeploymentAt` when a managed module has no reported deployment; use the observation's version/status/RPM exactly. Derive `modulesById`, edges, and active count from the overlaid array. In `loadRuntimeSnapshot`, inject `moduleHeartbeatService.snapshot()`.

Extend `isExcludedPath` to match exact heartbeat paths so operational reports do not inflate user metrics.

- [ ] **Step 6: Run GREEN verification**

Run:

```powershell
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/api-server build
```

Expected: all API tests pass (Redis integration may remain explicitly skipped without its opt-in URL), typecheck and production build pass.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- artifacts/api-server/src/routes/module-heartbeats.ts artifacts/api-server/src/routes/module-heartbeats.test.ts artifacts/api-server/src/app.ts artifacts/api-server/src/lib/admin-telemetry.ts artifacts/api-server/src/lib/admin-telemetry.test.ts artifacts/api-server/src/routes/admin.ts artifacts/api-server/src/lib/logger.ts
git commit -m "feat(api): ingest module heartbeats"
```

---

### Task 4: Container secret boundary, documentation, browser QA, and final status

**Files:**
- Modify: `.gitignore`
- Modify: `.dockerignore`
- Modify: `docker-compose.yml`
- Modify: `artifacts/api-server/docker-compose.yml`
- Modify: `artifacts/api-server/src/admin-config-contract.test.ts`
- Modify: `MODULES.md`
- Modify: `IMPLEMENTATION_STATUS.md`
- Create: `.superpowers/sdd/progress.md` (ignored execution ledger; do not commit)

**Interfaces:**
- Consumes: `APOLLO_MODULE_HEARTBEAT_KEYS`, Task 3 endpoint/headers, existing Compose service block tests, existing admin dashboard.
- Produces: API-only secret wiring, safe build contexts, operator documentation, local signed-request evidence, browser evidence for `Последний сигнал`, and exact publication status.

- [ ] **Step 1: Write failing configuration-contract tests**

Assert both Compose API services contain:

```text
APOLLO_MODULE_HEARTBEAT_KEYS: "${APOLLO_MODULE_HEARTBEAT_KEYS:-}"
```

Assert admin/web/db/redis services, Vite sources, Docker build args, and nginx do not contain the variable or heartbeat secrets. Assert `.gitignore` and `.dockerignore` cover `.env`, `.env.*`, and `.ops-private`, while `.env.example` remains trackable.

- [ ] **Step 2: Run configuration tests and verify RED**

Run:

```powershell
pnpm --filter @workspace/api-server test -- --run src/admin-config-contract.test.ts
```

Expected: missing Compose wiring and ignore rules fail.

- [ ] **Step 3: Add minimal configuration and documentation**

Pass the empty-default interpolation only to API services. Add safe ignore patterns with explicit sample-file negation. Document the endpoint, canonical signature, 30-second sender interval, 90-second TTL, API-restart behavior, per-module secrets, and disabled-by-default semantics in `MODULES.md`. Do not add real secret values, domains, HomeNode addresses, or Coolify inventory.

- [ ] **Step 4: Run local signed-request and UI verification**

Use test-only generated secrets. Start an isolated local API/test server, send a correctly signed request, and verify an authenticated admin snapshot contains the fresh module version/status/`lastHeartbeatAt`; advance the fake clock or wait through an accelerated test TTL and verify `unknown`. Run the admin development server on an unused port and use the Codex in-app browser to confirm the existing deployment table shows `Последний сигнал`, preserves table scrolling at desktop and `390x844`, has no overlapping content, and produces no console warnings/errors.

- [ ] **Step 5: Run complete validation**

Run:

```powershell
pnpm --filter @workspace/admin-dashboard-contract test
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/admin-dashboard test
pnpm run typecheck
pnpm --filter @workspace/api-server build
pnpm --filter @workspace/admin-dashboard build
docker compose config
docker compose -f artifacts/api-server/docker-compose.yml config
git diff --check
```

Expected: tests/typechecks/builds/config/diff checks pass. Compose may warn only about unrelated unset local provider credentials; no HomeNode/Coolify changes occur.

- [ ] **Step 6: Update status and commit Task 4**

Record exact test counts, build results, browser viewport evidence, local smoke evidence, branch/commit IDs, and the statement that HomeNode/Coolify were not changed. Set the next logical stage to the first independent module container and native Android APK decision remains tracked separately.

```powershell
git add -- .gitignore .dockerignore docker-compose.yml artifacts/api-server/docker-compose.yml artifacts/api-server/src/admin-config-contract.test.ts MODULES.md IMPLEMENTATION_STATUS.md
git commit -m "docs(ops): define heartbeat module rollout"
```

---

## Final Review and Publication

- [ ] Generate the SDD whole-branch review package from `origin/main` through feature `HEAD`.
- [ ] Dispatch a fresh read-only reviewer for spec compliance, auth/replay safety, secret boundaries, TTL truthfulness, tests, and UI regression risk.
- [ ] Fix every Critical or Important finding with RED/GREEN evidence and re-review until none remain.
- [ ] Push `codex/feat/module-heartbeat-adapter` and verify its remote SHA.
- [ ] Fast-forward `main` only after all review gates pass.
- [ ] Re-run contract/API/admin tests, workspace typecheck, API/admin production builds, Compose config, and `git diff --check` on merged `main`.
- [ ] Push `main`, verify `origin/main`, and append the final publication SHA/status if needed in a final status-only commit.
