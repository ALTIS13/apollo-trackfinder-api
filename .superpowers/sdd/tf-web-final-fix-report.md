# Apollo TF web-session consolidated final-fix report

## Result

- Status: `DONE_WITH_CONCERNS`
- Branch: `codex/feat/tf-web-session`
- Starting HEAD: `0fb61e0b3d545559382ff2478066a11a33a86c25`
- Implementation commit: `f3fee70abee5b14b31321be70831927b665c380d`
- Merge/push/remote infrastructure: not performed
- Compose: not rerun because no tracked Compose file changed

The requested final-review findings are resolved as one coherent implementation wave. Task 5 Step 5 remains unchecked and controller review/merge remains pending.

## RED evidence

1. Browser-managed Yandex token flow
   - Focused migration RED: `2 failed / 5 passed`.
   - Rendered Favorites still exposed the OAuth token form, and the runtime scan found `useYandexSaveToken` plus `/yandex/token`.
   - GREEN removes the hook, input, OAuth fragment link, and transport while preserving server-backed status, catalog reads, and POST logout for existing connections.

2. Runtime auth invalidation and policy revalidation
   - Baseline player run exposed a relevant auth-test race: `1 failed / 40 passed` (`logoutAction` had not reached its effect).
   - Auth-channel RED after stabilizing the test harness: `5 failed / 7 passed`.
   - A confirmed runtime `tfFetch` 401 left cached queries and protected UI mounted; policy event tests had no channel export or provider subscription.
   - GREEN adds immediate 401 invalidation, QueryClient clearing, single-flight `/auth/me` policy refresh, protected unmount during refresh, generation guards, and cleanup-safe late completion handling.

3. Mutation-time generated search request
   - Focused migration/search RED: `5 failed / 7 passed`.
   - Clearing CSRF after Home rendered caused the next rerender to throw `csrf_unavailable`; generated 401/403/503 failures emitted no auth event; source still used `useSearchTracks` with render-time request options.
   - GREEN uses a local TanStack mutation that calls generated `searchTracks(data, tfRequestInit({ method: "POST" }))` for every mutation and forwards exact generated auth/policy payloads.

4. WebSocket close policy and stale callback ownership
   - Lifecycle RED: `6 failed / 15 passed`.
   - Exact terminal closes and pre-open abnormal close did not notify terminal; `onopen`, `onmessage`, and `onerror` remained attached; captured stale handlers could deliver messages or mutate state.
   - WebSocket-to-auth integration RED: `2 failed / 23 passed`.
   - `policy_revoked` was not a revalidation code and `PlayerProvider` ignored the terminal error value.
   - GREEN classifies `4403/policy_revoked` as forbidden, `1013/policy_unavailable` as unavailable, keeps `1013/buffer_unavailable` transient, terminates other pre-open closes once, detaches all handlers on ownership loss, and forwards terminal policy errors to auth.

5. Fail-closed `/auth/me` validation
   - Session/auth RED: `6 failed / 26 passed`.
   - Non-canonical UUIDs, short/non-canonical CSRF values, invalid dates, and expired sessions were accepted. The existing string-entitlement check already rejected the non-string fixture.
   - GREEN requires canonical UUID structure, canonical unpadded 43-character base64url CSRF, string entitlements, and a finite future expiry before storing CSRF. Invalid payloads clear prior CSRF and cannot mount protected content.

6. Tracked evidence and lockfile
   - The plan contradicted final Yandex handling and described render-time search plus incomplete WebSocket cleanup.
   - `IMPLEMENTATION_STATUS.md` incorrectly named `docker compose config --quiet` instead of the exact validated `docker compose config`.
   - Pinned `pnpm 10.33.2` ran `pnpm install --lockfile-only`; `pnpm-lock.yaml` remained byte-for-byte unchanged.

## GREEN validation

- Focused session/auth/migration-search/WebSocket tests: `66/66` across 4 files.
  - Session client: `19/19`
  - Auth boundary/channel: `13/13`
  - Migration/search/provider boundary: `13/13`
  - WebSocket lifecycle: `21/21`
- Full `pnpm --filter @workspace/music-player test`: `66/66`.
- `pnpm --filter @workspace/music-player typecheck`: exit `0`.
- `pnpm --filter @workspace/music-player build`: exit `0`.
- Selected API auth/boundary/ticket/policy/WebSocket suite: `100/100`.
- Root `pnpm run typecheck`: exit `0`.
- Runtime legacy identity scan: no matches.
- Runtime provider-secret/Yandex token UI-storage-transport scan: no matches.
- `pnpm install --frozen-lockfile`: exit `0`, lockfile up to date.
- `git diff --check`: exit `0`.
- Generated shared API client source/defaults: unchanged.
- Tracked Compose/Docker files: unchanged.

## Files changed

- `artifacts/music-player/src/lib/tf-session-client.ts`
- `artifacts/music-player/src/lib/tf-session-client.test.ts`
- `artifacts/music-player/src/auth/tf-auth.tsx`
- `artifacts/music-player/src/auth/tf-auth.test.tsx`
- `artifacts/music-player/src/lib/tf-websocket.ts`
- `artifacts/music-player/src/lib/tf-websocket.test.ts`
- `artifacts/music-player/src/lib/tf-api-migration.test.ts`
- `artifacts/music-player/src/pages/Home.tsx`
- `artifacts/music-player/src/pages/Favorites.tsx`
- `artifacts/music-player/src/hooks/use-player.tsx`
- `artifacts/music-player/src/hooks/use-yandex.ts`
- `docs/superpowers/plans/2026-07-24-tf-web-session-integration.md`
- `IMPLEMENTATION_STATUS.md`

## Lockfile decision

Keep the current `pnpm-lock.yaml`. The music-player Vitest/Testing Library importer entries are required. Regeneration with the repository-pinned pnpm produced no diff, confirming that the shared Vitest peer snapshot normalization and `path-scurry` deduplication to the already locked `lru-cache@11.5.2` are current pnpm output rather than removable unrelated churn. Frozen install passes. The lockfile was not hand-edited.

## Self-review

- Confirmed the auth event path is synchronous for immediate protected unmount, while `/auth/me` refresh is single-flight and generation-guarded.
- Confirmed logout, invalidation, provider cleanup, and late refresh completion cannot restore stale authenticated state.
- Confirmed every WebSocket callback checks running state, generation, and socket ownership.
- Confirmed stop, close, replacement, and terminal transitions detach all four handlers before releasing ownership.
- Confirmed stale handler replay causes no message callback, socket action, timer, ticket request, backoff reset, or terminal notification.
- Confirmed generated search request options are created only inside the mutation function.
- Confirmed no browser runtime Yandex provider-token input, storage, or transport remains.
- Confirmed existing Yandex connected-account status/read/logout behavior remains.
- Confirmed no server implementation, generated client default, Compose file, or remote infrastructure was changed.

## Warnings and concerns

- Vite build succeeds but retains existing warnings for the tooltip sourcemap location and a `516.77 kB` minified chunk exceeding the default `500 kB` advisory threshold.
- Frozen install succeeds but pnpm reports the existing policy warning that the `msgpackr-extract@3.0.3` build script is ignored.
- New Yandex onboarding remains intentionally unavailable until server-side OAuth onboarding is implemented outside this branch.
- Independent controller re-review and Task 5 Step 5 merge preparation are still pending. No merge or push was performed.
