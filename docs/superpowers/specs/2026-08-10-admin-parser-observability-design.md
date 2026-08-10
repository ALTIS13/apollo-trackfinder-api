# Apollo TF Admin And Parser Observability Design

**Date:** 2026-08-10
**Status:** Approved by the user's corrected implementation order

## Goal

Complete the operator-facing Apollo TF control plane before redesigning the consumer player. The admin panel must show live modules and versions, parser state and quality filtering, account activity, and connected Spotify/Yandex services without giving the browser direct access to service credentials or databases.

## Existing Baseline

The current admin snapshot already contains module heartbeat status, deployed versions, topology, incidents, four summary metrics, and a provider table. Live provider rows are currently `unknown`, and the contract has no parser-quality counters, account activity, or connected-service projection.

## Aggregation Boundary

`tf-api` remains the single browser-facing admin snapshot endpoint. It collects bounded read-only summaries from containerized services over signed internal requests:

- `tf-search` publishes parser telemetry in its signed heartbeat.
- `platform-api` provides a bounded account/session/entitlement overview.
- `tf-integrations` provides connection summaries only for requested account IDs.
- `tf-api` joins those summaries into the strict admin dashboard contract.
- `admin-dashboard` renders the snapshot and never receives service HMAC secrets, provider tokens, or database credentials.

An unavailable dependency degrades only its section to stale/unavailable; it does not erase the last usable module topology.

The Platform overview executes as one fixed, maximum-100-row PostgreSQL projection. FORCE RLS remains enabled, the runtime and migrator roles remain `NOBYPASSRLS`, and cross-account reads are enabled only for the projection's transaction-local `platform.accounts.manage` context. Ordinary runtime queries remain account-isolated and the projection has no mutation path.

## Demo And Preview Detection

Every parser result passes through a default media-completeness gate before ranking and caching. A result is rejected when any of these bounded rules match:

- a provider explicitly returns a preview URL, including Deezer preview CDN URLs;
- the title contains an explicit marker such as `demo`, `preview`, `snippet`, `teaser`, `sample`, `30 sec`, or the Russian equivalents;
- its positive duration is at most 90 seconds, a comparable original-track median is at least 120 seconds, and the result is no more than 55 percent of that median.

The gate records a categorical reason and source, but public search results never expose internal source URLs or rejection diagnostics. If all candidates are rejected, search returns an honest empty result instead of a known truncated stream. Future opt-in preview search is out of scope.

Parser telemetry is a rolling 60-second bounded window per source: requests, failures, rejected previews, status, and last check time. Rejections produce `warning` only when they occur; repeated provider failures determine `degraded` status using the existing service policy.

## Account Activity And Connections

An active user is an `active` account with at least one non-revoked, unexpired session whose `last_seen_at` is within the previous 15 minutes. The operator overview returns at most 100 accounts ordered by latest activity with:

- account ID, email, display name, lifecycle status, and latest activity;
- active session count and granted module keys;
- Spotify/Yandex connection state and provider display name only.

Provider access/refresh tokens, session digests, password data, and provider user IDs are never returned. Lifecycle counters include global total, active now, pending, and suspended values. Spotify and Yandex counters are explicitly scoped to the at-most-100 accounts in the displayed list. Platform failure marks the account section unavailable instead of synthesizing zero totals; integrations-only failure preserves account rows and marks connection cells and list-scoped connection counters unavailable.

## Admin Layout

The existing accepted topology remains intact. New navigation sections are `Парсеры` and `Пользователи`:

- parser table: source, status, module version, requests/min, failures/min, demo rejected/min, last check;
- user table: account, status, last activity, active sessions, module access, Spotify/Yandex state;
- the top summary uses four compact metrics: active modules, active users, parser warnings, and open incidents.

The UI remains a dense operator dashboard. Consumer playback controls, Spotify-like navigation, collections, recommendations, and queue design do not enter the admin panel.

## Validation Policy

- One focused test per new behavior or cross-service contract; no duplicate visual/source-string tests.
- Run only touched package tests, typechecks, and builds.
- Existing topology geometry tests run only if topology files or snapshot geometry change.
- HomeNode, Coolify, Caddy, UFW, DNS, Docker resources, and existing services are not mutated during local implementation.

## Deferred Player Direction

After this control-plane stage, Apollo TF receives a separate consumer design based on Spotify and pre-redesign Yandex Music: library-first navigation, dense track lists, persistent player, restrained album imagery, and no admin deployment or infrastructure controls.
