# Apollo Identity, Registration, and Policy Design

**Date:** 2026-07-15
**Status:** Approved

## Goal

Provide closed-beta accounts whose server-enforced module access cannot be bypassed by downloading a client or calling a known API endpoint. Support three operator-controlled registration modes, invitations, account approval, session management, and auditable entitlement changes.

## Registration Modes

The singleton Platform setting `registration_mode` accepts exactly:

- `closed`: no new account can be created; existing users may sign in.
- `invite_only`: registration requires a valid invitation. The invitation can be email-bound or unbound, has an expiry, a usage limit, and normalized initial module grants.
- `open_approval`: anyone may submit registration, but the account remains `pending` until email verification, operator approval, and at least one explicit entitlement grant.

Changing the mode affects only new registration. It does not revoke active accounts. Every mode change is audited with operator, previous value, new value, reason, and timestamp.

## Account Lifecycle

Account status is one of `pending`, `active`, `suspended`, or `deleted`.

- `pending` may complete verification but cannot create product sessions.
- `active` may access only currently granted modules.
- `suspended` cannot sign in, refresh, exchange authorization codes, or perform protected actions.
- `deleted` is a terminal soft-delete state; credentials and sessions are revoked and personal-data erasure is handled by an audited background job.

Operator privileges are separate from product entitlements. An admin session uses a distinct audience and host-only cookie and cannot be obtained from an end-user entitlement.

## Database Model

Platform uses versioned, transactional migrations and separate runtime/migration roles.

| Table | Purpose |
| --- | --- |
| `accounts` | Stable UUID, normalized email, display name, status, verification and lifecycle timestamps |
| `credentials` | Account password hash and password-change metadata |
| `email_verification_tokens` | Hashed one-time verification secrets with expiry and consumption time |
| `password_reset_tokens` | Hashed one-time reset secrets with expiry and consumption time |
| `client_installations` | Account-bound installation UUID, label, first/last seen, revoked time |
| `auth_sessions` | Hashed session/refresh secret, account, installation, audience, expiry, revocation |
| `authorization_codes` | Hashed one-time code, client, exact redirect URI, PKCE challenge, nonce, expiry |
| `registration_settings` | Singleton registration mode and revision |
| `invitations` | Hashed invite secret, optional email binding, expiry, usage limit/count, revocation |
| `invitation_module_grants` | Normalized module keys attached to an invitation |
| `modules` | Stable module key, product, display name, state, and description |
| `account_module_entitlements` | Account/module grant, expiry, revocation, grant source, operator |
| `operator_roles` | Separate administrative role assignments |
| `projects` | Apollo project catalog entries |
| `project_releases` | Immutable product version/release records |
| `changelog_entries` | Release-linked, ordered customer-facing changes |
| `audit_events` | Append-only security and operator action evidence |

All timestamps are UTC. Emails and module keys are unique after normalization. Invite redemption, usage increment, account creation, and initial grants occur in one transaction with row locking so concurrent redemption cannot exceed the limit.

Passwords use Argon2id with versioned parameters and opportunistic rehashing, following [RFC 9106](https://www.rfc-editor.org/rfc/rfc9106). Raw passwords, verification tokens, reset tokens, invite tokens, authorization codes, and session tokens are never stored.

## Authorization Model

Initial module keys are:

- `tf.search`: search and playback metadata.
- `tf.integrations`: Spotify/Yandex connection and parsing.
- `tf.downloads`: download/transcode requests and download retrieval.
- `tf.collections`: likes, playlists, history, and migration of legacy collections.

Each protected HTTP route declares one or more required module keys. WebSocket ticket issuance requires `tf.search`; the ticket is short-lived, single audience, and account-bound. A running connection closes when its server session is revoked or the entitlement refresh fails.

The API checks account status, session state, audience, and entitlement expiry/revocation. UI lock states are explanatory only. A missing policy mapping for a protected route is a startup/test failure, not an implicit allow.

PostgreSQL row-level security provides defense in depth on account-owned Platform and TF tables. Request transactions set a validated `app.account_id`; runtime roles do not own tables and do not have `BYPASSRLS`. Migration and audited operator roles are separate. Policies default deny when account context is absent, consistent with PostgreSQL row security behavior documented by [PostgreSQL](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

## User Flows

### Invite-only registration

1. User opens an invite link; the browser sends the raw token once over TLS.
2. Platform stores only a short-lived server-side redemption handle and displays expiry/email binding/module summary.
3. User supplies email, display name, and password.
4. Platform atomically consumes one invite use, creates the account as `pending`, and records the invitation grants.
5. Email verification activates the account and its recorded grants; an unverified account cannot create a product session.
6. User signs in through Authorization Code + PKCE.

### Open registration

1. User sees that registration is open with approval.
2. Registration creates `pending`; email verification does not activate product access.
3. Admin reviews the account, grants modules, and activates it.
4. Rejection/suspension records a reason in audit but exposes only a safe public status to the user.

### Entitlement change

1. Admin grants, expires, or revokes a module with a required reason.
2. Platform commits the entitlement and audit event together.
3. Active product sessions are marked for refresh; critical endpoints introspect immediately.
4. Denied requests return a stable `module_access_denied` response with the missing public capability key.

## Security and Error Handling

- Authorization Code uses PKCE `S256`, exact redirect matching, transaction-bound `state`, single use, and short expiry.
- Cookies are Secure, HttpOnly, host-only, SameSite=Lax, rotated on authentication, and protected against fixation.
- Login, registration, invite redemption, verification, reset, and authorization endpoints have Redis-backed per-IP and per-identity rate limits.
- Public responses do not reveal whether an email, invite, account, or module exists beyond the state necessary for the current authenticated flow.
- SMTP is configured through runtime secrets. `apollot.ru` mail DNS must include provider-issued SPF/DKIM and an owner-approved DMARC policy before public email delivery.
- Unexpected policy-store failure fails closed for protected actions and emits a sanitized incident.

## Migration from Session IDs

Existing TF rows gain nullable `account_id` and retain `session_id` during a bounded transition. New authenticated writes use `account_id`. A signed-in user can request a preview of locally discoverable legacy data, then explicitly confirm an idempotent migration. The API records source installation, row counts, result, and audit ID. No cross-device or ambiguous session IDs are merged automatically. After the rollback window, migrated rows no longer authorize through `session_id`.

## Testing

- Migration tests cover clean install, upgrade, rollback boundary, uniqueness, constraints, RLS default deny, and least-privilege runtime roles.
- Registration tests cover every mode, mode changes, invite expiry/revocation/email binding/usage races, verification, approval, suspension, and deletion.
- Authentication tests cover PKCE mismatch/downgrade, code replay, redirect mismatch, state swapping, session rotation, expiration, revocation, and audience isolation.
- Policy tests enumerate every protected HTTP route and WebSocket ticket, verify missing/expired/revoked grants, and prove a downloaded client cannot bypass the server.
- Audit tests assert sensitive values are absent and every operator mutation has actor, target, reason, and correlation ID.
- Local end-to-end tests use disposable PostgreSQL, Redis, and SMTP-capture containers.

## Out of Scope

- Billing tiers, payments, social login, passkeys, organization accounts, and user-defined roles.
- Automatic access based on installed client modules.
- Sharing Platform database credentials with TF workers or GA.
