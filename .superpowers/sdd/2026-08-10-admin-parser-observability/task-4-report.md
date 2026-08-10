# Task 4 Report: Read-Only Account And Connection Overview

## Implementation summary

- Added a bounded platform repository projection for the 100 most recently active accounts. It calculates 15-minute active-session counts, lifecycle counters, latest activity, and current module grants without selecting credentials, digests, or secrets.
- Added signed read-only internal admin routes to platform-api and tf-integrations. Platform reuses the existing confidential tf-api client secret: Basic credentials are verified against the configured client digest before the same secret verifies the canonical request HMAC. Integrations reuses its existing internal HMAC secret and keeps replay protection in the existing authenticator.
- Added a bounded integrations database projection containing only canonical account ID, provider, display name, and update time.
- Added tf-api aggregation that preserves platform account rows and marks Spotify/Yandex cells `unavailable` when integrations fails. The dashboard contract now strictly bounds the account summary and 100 account rows.
- Added the `Пользователи` sidebar target and a dense read-only table with account status, recent activity, active sessions, granted modules, and Spotify/Yandex connection state.
- No Docker, topology geometry/interaction, consumer player, HomeNode, Caddy, DNS, UFW, GitHub Actions, or Android files were changed.

## Exact files changed

- `artifacts/admin-dashboard/src/App.test.tsx`
- `artifacts/admin-dashboard/src/App.tsx`
- `artifacts/admin-dashboard/src/components/AccountsTable.tsx`
- `artifacts/admin-dashboard/src/components/AdminSidebar.tsx`
- `artifacts/admin-dashboard/src/data/demo-snapshot.ts`
- `artifacts/admin-dashboard/src/types/dashboard.ts`
- `artifacts/api-server/src/lib/admin-account-overview-client.test.ts`
- `artifacts/api-server/src/lib/admin-account-overview-client.ts`
- `artifacts/api-server/src/lib/admin-telemetry.ts`
- `artifacts/api-server/src/routes/admin.test.ts`
- `artifacts/api-server/src/routes/admin.ts`
- `artifacts/platform-api/package.json`
- `artifacts/platform-api/src/app.ts`
- `artifacts/platform-api/src/domain/admin-overview.ts`
- `artifacts/platform-api/src/domain/postgres-repository.test.ts`
- `artifacts/platform-api/src/domain/postgres-repository.ts`
- `artifacts/platform-api/src/domain/repository.ts`
- `artifacts/platform-api/src/index.ts`
- `artifacts/platform-api/src/routes/internal-admin.ts`
- `artifacts/tf-integrations/src/admin-overview.ts`
- `artifacts/tf-integrations/src/app.ts`
- `artifacts/tf-integrations/src/index.ts`
- `lib/admin-dashboard-contract/src/index.test.ts`
- `lib/admin-dashboard-contract/src/index.ts`
- `lib/tf-integrations-db/src/index.ts`
- `lib/tf-integrations-db/src/repository.test.ts`
- `lib/tf-integrations-db/src/repository.ts`
- `pnpm-lock.yaml`

## TDD RED evidence

1. Command: `pnpm --filter @workspace/platform-api test -- src/domain/postgres-repository.test.ts`

   Output: `TypeError: repository.getAdminAccountOverview is not a function` at `src/domain/postgres-repository.test.ts:1236`.

   Expected because the new platform aggregation method did not exist.

2. Command: `pnpm --filter @workspace/tf-integrations-db test -- src/repository.test.ts`

   Output: `TypeError: repository(...).listAdminConnectionSummaries is not a function` at `src/repository.test.ts:357`.

   Expected because the bounded integrations lookup did not exist.

3. Command: `pnpm --filter @workspace/api-server test -- src/lib/admin-account-overview-client.test.ts`

   Output: `Cannot find module './admin-account-overview-client.js'` from the new aggregation test.

   Expected because tf-api had no account overview aggregation client.

## GREEN evidence

- `pnpm exec vitest run src/domain/postgres-repository.test.ts` in `artifacts/platform-api`: 19 passed.
- `pnpm exec vitest run src/repository.test.ts` in `lib/tf-integrations-db`: 14 passed.
- `pnpm exec vitest run src/app.test.ts` in `artifacts/tf-integrations`: 17 passed.
- `pnpm exec vitest run --maxWorkers=2 src/lib/admin-account-overview-client.test.ts src/routes/admin.test.ts` in `artifacts/api-server`: 10 passed.
- `pnpm exec vitest run src/index.test.ts` in `lib/admin-dashboard-contract`: 6 passed.
- `pnpm exec vitest run src/App.test.tsx` in `artifacts/admin-dashboard`: 30 passed.
- `pnpm exec tsc --build lib/platform-db/tsconfig.json lib/admin-dashboard-contract/tsconfig.json`: passed.
- Package typechecks passed for `@workspace/platform-api`, `@workspace/tf-integrations-db`, `@workspace/tf-integrations`, `@workspace/admin-dashboard-contract`, `@workspace/api-server`, and `@workspace/admin-dashboard`.
- Builds passed for `@workspace/platform-api`, `@workspace/tf-integrations`, `@workspace/api-server`, and `@workspace/admin-dashboard`.
- `git diff --check`: passed.

## Self-review and concerns

- The platform HMAC reuses the already deployed confidential tf-api client secret only after Basic credentials have been verified against the platform OAuth client registry. Browser responses never include that secret or any provider token, provider user ID, session digest, password, HMAC secret, or database credential.
- The account projection is bounded at 100 rows; integrations input is bounded to 100 unique canonical UUIDs and output to 200 provider rows.
- Integrations failure is intentionally isolated to connection cells. Platform failure yields an empty unavailable account overview rather than exposing partial internal failure detail.
- No unresolved implementation concerns. Direct endpoint authentication behavior follows the existing canonical HMAC and Basic credential primitives; focused tests cover the required repository and tf-api aggregation behaviors.
