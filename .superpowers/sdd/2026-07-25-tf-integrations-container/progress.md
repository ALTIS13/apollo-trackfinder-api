# SDD ledger — plan: docs/superpowers/plans/2026-07-25-tf-integrations-container.md

Baseline: af90cb92a2cb1159148303aa5a99effda6e9e2e5
Baseline validation: API 365 passed / 2 skipped after one non-reproducing Vitest worker exit; tf-search 140 passed / 1 skipped; full workspace typecheck passed.
Task 1: minor (deferred): browser/server reachability for `yandex.token.upsert` spans Task 5; final review must verify live policy and CSRF before gateway dispatch.
Task 1: fix round 1/5 (2 addressed, 0 open — response account correlation; returned URL credential/token exclusion; commits ff891c9..6bf4161)
Task 1: complete (commits af90cb9..6bf4161, review clean)
Task 2: minor (deferred): readiness verifies the latest migration and count, not every historical checksum; final review must triage future multi-migration behavior.
Task 2: minor (deferred): repository unit-test plaintext canary assertion is vacuous; real PostgreSQL test carries meaningful at-rest coverage.
Task 2: fix round 1/5 (3 addressed, 1 open — canonical SQL envelope constraint, migration failure-path tests, non-emitting typecheck addressed; immutable 0001 upgrade break open; commits 971d213..b75f31e)
Task 2: fix round 2/5 (1 addressed, 0 open — immutable 0001 restored; canonical constraint moved to 0002; complete-manifest readiness added; commits b75f31e..2e9b2da)
Task 2: minor (resolved in fix round 2): readiness now validates every historical migration name/checksum.
Task 2: complete (commits 6bf4161..2e9b2da, review clean; 1 PostgreSQL integration test gated)
Task 3: fix round 1/5 (3 addressed, 0 open — trusted callback binding, dot-segment playlist path hardening, mutation-resistant provider validation; commits ed85f3e..ce4c388)
Task 3: complete (commits 2e9b2da..ce4c388, review clean)
Task 4: minor (deferred): heartbeat stop does not recheck `stopped` after an awaited readiness probe, so shutdown can race one late send before a fetch controller exists.
Task 4: fix round 1/5 (4 addressed, 0 open — exact method surface, canonical callback URI, strict runtime variables, fixed heartbeat cadence; commits da31d33..bc577c3)
Task 4: complete (commits ce4c388..bc577c3, review clean; 1 deferred minor)
Task 5: minor (deferred): API startup wiring test injects the integrations gateway through `app.ts` and does not mutation-test production `index.ts` config parsing/injection.
Task 5: minor (deferred): moving two production-app imports to `beforeAll` shifts cold-import duration from the 5-second test budget to the 10-second hook budget.
Task 5: fix round 1/5 (5 addressed, 1 open — legacy token-table runtime ownership, distinct command secrets, Spotify redirect correlation, outage semantics, non-200 body cancellation addressed; exact Yandex login compatibility open; commits 10b3055..b601201)
Task 5: fix round 2/5 (1 addressed, 0 open — exact Yandex provider login preserved independently from display name; commits b601201..bcb3b3c)
Task 5: complete (commits bc577c3..bcb3b3c, review clean; 2 deferred minors)
Task 6: minor (deferred): role initialization does not bound password-file size or PostgreSQL connection/statement/lock wait time.
Task 6: fix round 1/5 (5 addressed, 0 open — runtime migration-history privileges, Node 24 LTS, deterministic secret ownership, partial setup cleanup, complete live inspect; commits e8cc82c..daf663e)
Task 6: complete (commits bcb3b3c..daf663e, review clean; 1 deferred minor)
Task 7: fix round 1/5 (3 addressed, 0 open — stale documentation contract, root/nested Compose no-env default; blocked release record replaced by green validation; commits 1ef211b..7f2cdf2)
Task 7: fix round 2/5 (1 addressed, 0 open — immutable validated tip and exact Task 7 ranges; commits 7f2cdf2..2300775)
Task 7: complete (commits daf663e..2300775, review clean)
Final review: changes required (4 Important, 6 Minor at 2300775).
Final fix wave: commits 16f6fc8..09761e4; validation 732 passed / 15 gated or skipped / 0 failed; PostgreSQL 2/2; Docker smoke 17/17; DNS 16/16; zero project residue.
Final scoped re-review: 7 addressed, 3 open — Important: account-partitioned replay quota still consumes nonce capacity before readiness/concurrency rejection and truncates fast liked-all after 32 pages; Important: command abort/deadline does not prevent later repository mutations/commits; Minor: two current next-stage lines still name tf-integrations.
Final review: BLOCKED — two residual load-bearing findings require an explicitly continued hardening wave before merge/push.
Final whole-branch fix wave: 10 findings addressed, 0 open in implementation — generation CAS, account-partitioned replay, bounded/cancelable provider I/O, two-key heartbeat enrollment, exact command target, gateway body disposal, shutdown heartbeat ordering, bounded role bootstrap, meaningful at-rest assertion, and current next-stage records (commit 16f6fc8).
Final whole-branch validation: exact implementation tip 16f6fc88e85fe919ddcb86a85333a38f3218e715; required matrix 732 passed / 15 skipped or gated / 0 failed; disposable PostgreSQL 2/2; authoritative Docker smoke 17/17; DNS 16/16; exact zero residue; no remote infrastructure mutation.
