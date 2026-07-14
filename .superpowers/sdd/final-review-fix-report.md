# Final Review Fix Report

## Status

DONE_WITH_CONCERNS

## Scope

- Branch: `codex/feat/admin-topology-dashboard`
- Pre-fix HEAD: `0240fef`
- Required commit: `fix(admin-dashboard): harden production data path`
- HomeNode/private files and `main` were not changed.

## TDD Evidence

### RED

- `pnpm --filter @workspace/admin-dashboard test -- src/App.test.tsx` -- exit `1`; 4 failed / 17 passed. Missing behaviors: mounted HTTP initial GET, first-failure offline state, post-success stale state, and remote read-only acknowledgement capability.
- `pnpm --filter @workspace/admin-dashboard test -- src/data/http-snapshot-adapter.test.ts -t "rejects HTTP 200 JSON"` -- exit `1`; 6 failed / 4 skipped because invalid enum/timestamp, duplicate service IDs, invalid edge/incident references, and an oversized collection resolved instead of rejecting.
- `pnpm --filter @workspace/admin-dashboard test -- src/data/http-snapshot-adapter.test.ts -t "aborts a hung request"` -- exit `1`; request signal was undefined.
- `pnpm --filter @workspace/admin-dashboard test -- src/data/http-snapshot-adapter.test.ts -t "shares one in-flight request"` -- exit `1`; concurrent calls invoked fetch twice.
- `pnpm --filter @workspace/admin-dashboard test -- src/config-contract.test.ts` -- exit `1`; 6 failed / 2 passed for contrast, runtime proxy/token, same-origin selector, Compose runtime config, and patched dependency contracts. White/accent contrast was `4.1115:1`; subtle/surface was `4.4938:1`.
- `pnpm audit --prod --json` baseline -- workspace exit `1`; parsed admin findings contained 2 paths, both `artifacts__admin-dashboard>dagre>lodash`.
- Standalone runtime probe after removing the image-layer token default -- container exit `1`; nginx reported `unknown "admin_dashboard_token" variable`. Root cause: filtered envsubst ignores unset variables. A pre-envsubst runtime defaults fragment was added, then the image was rebuilt and re-probed.

### GREEN

- `pnpm --filter @workspace/admin-dashboard test -- src/App.test.tsx` -- exit `0`; 21 passed.
- `pnpm --filter @workspace/admin-dashboard test -- src/data/dashboard-adapter.test.ts src/data/http-snapshot-adapter.test.ts` -- exit `0`; 12 passed.
- `pnpm --filter @workspace/admin-dashboard test -- src/config-contract.test.ts` -- exit `0`; 8 passed, including deterministic WCAG AA contrast and production proxy contracts.

## Implementation Result

- Demo and HTTP adapters expose mode/capabilities. HTTP bootstrap remains unverified until validated remote data; first failure is offline and only a later failure is stale.
- Remote incidents are read-only; demo acknowledgements remain local and persist through demo refresh.
- Zod validates all snapshot fields/enums/timestamps, collection bounds, unique service/incident IDs, and service references before state mutation.
- HTTP requests use a 10-second abort timeout and single-flight refresh.
- Browser traffic is fixed to same-origin `/api/admin/dashboard`. nginx injects `X-Admin-Dashboard-Token` from runtime `ADMIN_DASHBOARD_TOKEN` and proxies through runtime `APOLLO_API_UPSTREAM`; `/healthz` remains independent.
- `lodash@4.18.1` is the sole Lodash resolution for the admin topology paths.

## Final Verification

- `pnpm --filter @workspace/admin-dashboard test -- src/App.test.tsx src/data/dashboard-adapter.test.ts src/data/http-snapshot-adapter.test.ts src/config-contract.test.ts` -- exit `0`; 4 files / 41 focused tests passed.
- `pnpm --filter @workspace/admin-dashboard test` -- exit `0`; 8 files / 54 tests passed.
- `pnpm --filter @workspace/admin-dashboard typecheck` -- exit `0`.
- `pnpm --filter @workspace/admin-dashboard build` -- exit `0`; Vite transformed 2553 modules and produced the production bundle.
- `pnpm run typecheck` -- exit `0`; libraries plus all six typechecked artifact/script projects passed.
- `docker build --pull=false -f artifacts/admin-dashboard/Dockerfile -t apollo-tf-admin:final-review .` -- exit `0`; frozen admin install and Vite build passed, final nginx image exported without a secret-in-ENV warning.
- Disposable runtime command: `docker run -d --name apollo-admin-final-review-health -e APOLLO_API_UPSTREAM=http://127.0.0.1:65535 -p 127.0.0.1:18081:80 apollo-tf-admin:final-review` followed by `Invoke-WebRequest http://127.0.0.1:18081/healthz` -- exit `0`; unavailable upstream by design, HTTP `200`, body `ok`. `docker rm -f` ran in `finally`; `docker ps -a` returned no remaining named container.
- `docker compose config --quiet` with placeholder Spotify values -- exit `0`; Compose emitted the pre-existing warning that top-level `version` is obsolete.
- `pnpm audit --prod --json` plus JSON path parsing -- workspace audit exit `1` with 37 unrelated baseline advisories; parsed `artifacts__admin-dashboard` path count `0`.
- `pnpm --filter @workspace/admin-dashboard why lodash --prod` -- one resolved version, `lodash@4.18.1`, under both `dagre@0.8.5` and `graphlib@2.1.8`.
- `git diff --check` -- exit `0` before and after the final report append/self-review.

## Residual Concerns

- The backend telemetry endpoint does not yet exist and must validate `X-Admin-Dashboard-Token` before production deployment.
- Owner approval remains required before merge to `main`.
- No Coolify or HomeNode deployment was performed.
