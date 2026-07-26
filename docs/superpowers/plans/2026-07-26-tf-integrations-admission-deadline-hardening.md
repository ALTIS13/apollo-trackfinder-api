# TF Integrations Admission and Deadline Hardening Plan

> **Execution:** Use `superpowers:subagent-driven-development` with a fresh
> implementer and reviewer for every task. Every behavior change follows
> RED -> verify RED -> GREEN -> verify GREEN.

**Goal:** Close the two load-bearing findings that block merging the
`tf-integrations` container: replay admission must not become a request quota,
and command cancellation/deadlines must prevent later database commits.

**Baseline:** `5a75b806447f7dcd0a296ad1d854dbcccb0abff0`

**Scope:** This is a focused hardening wave. It does not redesign provider
features, deploy to HomeNode/Coolify, change Caddy/UFW/DNS, start Android work,
or implement `tf-download-worker`.

## Binding Requirements

- Signature and timestamp verification continue to cover the exact raw request
  bytes before JSON parsing.
- Commands continue to use the strict shared schema and canonical account ID.
- Readiness and concurrency rejection happen before replay nonce consumption.
- Duplicate admitted commands cannot execute concurrently.
- Replay records remain live for the complete signed 60-second validity window.
- Replay state is bounded and partitioned so one account cannot evict another
  account's live nonces.
- Legitimate sequential pagination beyond the configured live-nonce capacity
  is retried with a fresh signed request or fails explicitly; it is never
  returned as a silently truncated successful `liked-all` response.
- Every command has one absolute deadline propagated through service and
  repository layers.
- Provider calls, encryption/decryption, reads, and mutations check
  cancellation at the relevant boundaries.
- A database mutation that has not committed before cancellation/deadline must
  roll back and must never commit later.
- Client disconnect and runtime shutdown use the same cancellation boundary.
- Public response shapes, entitlement checks, CSRF, OAuth state, redirects,
  logging redaction, and container isolation remain compatible.

## Task 1: Admission and Replay State

**Primary files:**

- `artifacts/tf-integrations/src/internal-auth.ts`
- `artifacts/tf-integrations/src/internal-auth.test.ts`
- `artifacts/tf-integrations/src/app.ts`
- `artifacts/tf-integrations/src/app.test.ts`
- `artifacts/api-server/src/routes/spotify.ts`
- `artifacts/api-server/src/routes/spotify.test.ts`

- [ ] Add failing tests proving readiness/concurrency rejection does not claim
  a nonce, while two admitted requests with the same nonce cannot both execute.
- [ ] Add a failing test that exceeds the actual configured live-nonce capacity
  and proves `liked-all` cannot report a silently truncated success.
- [ ] Add failing tests for full 60-second replay lifetime, per-account
  isolation, and deterministic bounded-memory/backpressure behavior.
- [ ] Implement the smallest explicit two-phase admission/replay design that
  satisfies the tests without weakening raw-byte authentication.
- [ ] Run focused tests, package typechecks, API compatibility tests, and
  `git diff --check`.
- [ ] Commit the task.

## Task 2: Enforced Deadline and Abort-Aware Mutations

**Primary files:**

- `artifacts/tf-integrations/src/app.ts`
- `artifacts/tf-integrations/src/app.test.ts`
- `artifacts/tf-integrations/src/service.ts`
- `artifacts/tf-integrations/src/service.test.ts`
- `lib/tf-integrations-db/src/repository.ts`
- `lib/tf-integrations-db/src/repository.test.ts`
- `lib/tf-integrations-db/src/repository.integration.test.ts`

- [ ] Add failing service tests proving cancellation before each mutation keeps
  the repository untouched.
- [ ] Add a failing repository test proving an in-flight PostgreSQL mutation
  rolls back when its command signal/deadline aborts.
- [ ] Introduce a command context with `signal` and an absolute deadline, and
  propagate it through every mutable service/repository path.
- [ ] Execute mutations in cancellation-aware transactions with bounded
  PostgreSQL waits and no post-deadline commit.
- [ ] Preserve shutdown draining and ensure provider/database resources close
  only after active commands settle or cancel.
- [ ] Run focused unit and disposable PostgreSQL tests, package typechecks, and
  `git diff --check`.
- [ ] Commit the task.

## Task 3: Current Status and Integrated Validation

**Primary files:**

- `IMPLEMENTATION_STATUS.md`
- `.superpowers/sdd/2026-07-26-tf-integrations-admission-deadline-hardening/*`

- [ ] Correct current next-stage text so it names `tf-download-worker`; do not
  rewrite historical validation records.
- [ ] Run an independent task review after Tasks 1 and 2 and a whole-wave review
  after Task 3.
- [ ] Run the full repository validation matrix, real PostgreSQL integration
  tests, Docker Compose validation/smoke, DNS checks, and residue checks.
- [ ] Record exact commit IDs and exact pass/skip/fail counts.
- [ ] Push the feature branch.
- [ ] Only if review and validation are clean, fast-forward merge to `main`,
  validate the merged tip, and push `main`.

## Completion Gate

The wave is complete only when both load-bearing findings are independently
reviewed as addressed, the full validation matrix is green, no secret or
container residue exists, and `main` contains the verified immutable tip.
