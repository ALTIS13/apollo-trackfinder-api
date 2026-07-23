import type { Pool, PoolClient } from "pg";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { argon2id, hash as argonHash } from "argon2";

import { PlatformDomainError } from "./errors.js";
import {
  APOLLO_PORTAL_AUDIENCE,
  PORTAL_SESSION_TTL_MS,
  UserSessionService,
} from "./user-sessions.js";
import type {
  Account,
  AuditEvent,
  AuthSession,
  Credential,
  PlatformRepository,
} from "./repository.js";
import {
  digestOpaqueToken,
  hashPassword,
  type PasswordVerificationResult,
} from "./security.js";
import type { PlatformTransaction } from "./registration.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID = "00000000-0000-4000-8000-000000000002";
const PRODUCT_SESSION_ID = "00000000-0000-4000-8000-000000000003";
const ADMIN_SESSION_ID = "00000000-0000-4000-8000-000000000004";
const CORRELATION_ID = "00000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-07-24T10:00:00.000Z");
const PASSWORD = "correct horse battery staple";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type StoredSession = Mutable<AuthSession> & { digest: string };
type PasswordVerifier = (
  hash: string,
  password: string,
) => Promise<PasswordVerificationResult>;

interface SessionState {
  accounts: Account[];
  credentials: Credential[];
  sessions: StoredSession[];
  audits: AuditEvent[];
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: ACCOUNT_ID,
    email: "pending@example.test",
    displayName: "Pending User",
    status: "pending",
    emailVerifiedAt: NOW,
    activatedAt: null,
    suspendedAt: null,
    deletedAt: null,
    createdAt: new Date(NOW.getTime() - 1_000),
    updatedAt: NOW,
    ...overrides,
  };
}

function session(
  rawToken: string,
  overrides: Partial<StoredSession> = {},
): StoredSession {
  return {
    id: SESSION_ID,
    accountId: ACCOUNT_ID,
    installationId: null,
    audience: APOLLO_PORTAL_AUDIENCE,
    expiresAt: new Date(NOW.getTime() + 60_000),
    revokedAt: null,
    createdAt: NOW,
    lastSeenAt: NOW,
    digest: digestOpaqueToken(rawToken),
    ...overrides,
  };
}

function expectDomainError(error: unknown, code: PlatformDomainError["code"]) {
  expect(error).toBeInstanceOf(PlatformDomainError);
  expect((error as PlatformDomainError).code).toBe(code);
  expect(JSON.stringify(error)).not.toContain(PASSWORD);
  expect(JSON.stringify(error)).not.toContain("pending@example.test");
}

function createHarness(
  passwordHash: string,
  passwordVerification?: {
    readonly verify: PasswordVerifier;
    readonly dummyHash: string;
  },
) {
  const timeline: string[] = [];
  const client = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as PoolClient;
  const state: SessionState = {
    accounts: [],
    credentials: [],
    sessions: [],
    audits: [],
  };
  const repository = {
    findAccountByNormalizedEmail: vi.fn(async (_client, email: string) =>
      state.accounts.find((candidate) => candidate.email === email) ?? null,
    ),
    lockAccountById: vi.fn(async (_client, accountId: string) =>
      state.accounts.find((candidate) => candidate.id === accountId) ?? null,
    ),
    findCredentialByAccountId: vi.fn(async (_client, accountId: string) =>
      state.credentials.find((candidate) => candidate.accountId === accountId) ??
      null,
    ),
    updateCredential: vi.fn(async (_client, input) => {
      const credential = state.credentials.find(
        (candidate) => candidate.accountId === input.accountId,
      );
      if (credential === undefined) throw new Error("missing credential");
      Object.assign(credential, {
        ...input,
        updatedAt: input.passwordChangedAt,
      });
      return credential;
    }),
    revokeSessionsForAccountByAudience: vi.fn(async (_client, input) => {
      let count = 0;
      for (const candidate of state.sessions) {
        if (
          candidate.accountId === input.accountId &&
          candidate.audience === input.audience &&
          candidate.revokedAt === null
        ) {
          candidate.revokedAt = input.revokedAt;
          count += 1;
        }
      }
      return count;
    }),
    createSession: vi.fn(async (_client, input) => {
      const created = session("created", {
        id: `00000000-0000-4000-8000-${String(state.sessions.length + 10).padStart(12, "0")}`,
        accountId: input.accountId,
        installationId: input.installationId,
        audience: input.audience,
        expiresAt: input.expiresAt,
        digest: input.sessionDigest,
      });
      state.sessions.push(created);
      return created;
    }),
    findSessionByDigest: vi.fn(async (_client, digest: string) =>
      state.sessions.find((candidate) => candidate.digest === digest) ?? null,
    ),
    lockSessionByDigest: vi.fn(async (_client, digest: string) =>
      state.sessions.find((candidate) => candidate.digest === digest) ?? null,
    ),
    revokeSession: vi.fn(async (_client, input) => {
      const current = state.sessions.find(
        (candidate) =>
          candidate.id === input.sessionId && candidate.revokedAt === null,
      );
      if (current === undefined) return null;
      current.revokedAt = input.revokedAt;
      return current;
    }),
    insertAuditEvent: vi.fn(async (_client, input) => {
      const event: AuditEvent = {
        id: `00000000-0000-4000-8000-${String(state.audits.length + 20).padStart(12, "0")}`,
        occurredAt: NOW,
        ...input,
      };
      state.audits.push(event);
      return event;
    }),
  };
  const transaction: PlatformTransaction = async (_pool, callback) => {
    const snapshot = structuredClone(state);
    try {
      return await callback(client);
    } catch (error) {
      Object.assign(state, snapshot);
      throw error;
    }
  };
  const clock = vi.fn(() => new Date(NOW));
  const service = new UserSessionService(
    {} as Pool,
    repository as unknown as PlatformRepository,
    clock,
    transaction,
    passwordVerification,
  );
  return { service, state, repository, timeline, clock };
}

describe("UserSessionService", () => {
  let currentPasswordHash: string;
  let legacyPasswordHash: string;

  beforeAll(async () => {
    currentPasswordHash = await hashPassword(PASSWORD);
    legacyPasswordHash = await argonHash(PASSWORD, {
      type: argon2id,
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      hashLength: 16,
    });
  }, 30_000);

  test("creates a portal session for a verified pending account without granting product access", async () => {
    const harness = createHarness(currentPasswordHash);
    harness.state.accounts.push(account());
    harness.state.credentials.push({
      accountId: ACCOUNT_ID,
      passwordHash: currentPasswordHash,
      passwordChangedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await harness.service.login(
      { email: "pending@example.test", password: PASSWORD },
      { correlationId: CORRELATION_ID },
    );

    expect(result.account.status).toBe("pending");
    expect(result.session).toMatchObject({
      audience: APOLLO_PORTAL_AUDIENCE,
      installationId: null,
      expiresAt: new Date(NOW.getTime() + PORTAL_SESSION_TTL_MS),
    });
    await expect(harness.service.authenticate(result.rawToken)).resolves.toEqual({
      accountId: ACCOUNT_ID,
      sessionId: result.session.id,
      status: "pending",
      emailVerified: true,
    });
    expect(result.session.audience).not.toBe("trackfinder-api");
  });

  test("rotates only portal sessions and stores only the issued token digest", async () => {
    const harness = createHarness(currentPasswordHash);
    harness.state.accounts.push(account({ status: "active" }));
    harness.state.credentials.push({
      accountId: ACCOUNT_ID,
      passwordHash: currentPasswordHash,
      passwordChangedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    harness.state.sessions.push(
      session("old-portal"),
      session("product", { id: PRODUCT_SESSION_ID, audience: "trackfinder-api" }),
      session("admin", { id: ADMIN_SESSION_ID, audience: "apollo-admin" }),
    );

    const result = await harness.service.login(
      { email: "pending@example.test", password: PASSWORD },
      { correlationId: CORRELATION_ID },
    );

    expect(harness.state.sessions[0]?.revokedAt).toEqual(NOW);
    expect(harness.state.sessions[1]?.revokedAt).toBeNull();
    expect(harness.state.sessions[2]?.revokedAt).toBeNull();
    expect(harness.state.sessions.at(-1)?.digest).toBe(
      digestOpaqueToken(result.rawToken),
    );
    expect(JSON.stringify(harness.state.sessions)).not.toContain(result.rawToken);
  });

  test.each([
    ["missing account", null, false, PASSWORD],
    ["unverified account", "pending", true, PASSWORD, null],
    ["suspended account", "suspended", true, PASSWORD, NOW],
    ["deleted account", "deleted", true, PASSWORD, NOW],
    ["wrong password", "active", true, "wrong password", NOW],
  ] as const)(
    "performs one password verification and denies %s generically",
    async (_scenario, status, withCredential, suppliedPassword, emailVerifiedAt = NOW) => {
      const verify = vi.fn<PasswordVerifier>(async (hash, password) => ({
        valid: hash === currentPasswordHash && password === PASSWORD,
        needsRehash: false,
      }));
      const harness = createHarness(currentPasswordHash, {
        verify,
        dummyHash: legacyPasswordHash,
      });
      if (status !== null) {
        harness.state.accounts.push(account({ status, emailVerifiedAt }));
      }
      if (withCredential) {
        harness.state.credentials.push({
          accountId: ACCOUNT_ID,
          passwordHash: currentPasswordHash,
          passwordChangedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }

      const error = await harness.service
        .login(
          { email: "pending@example.test", password: suppliedPassword },
          { correlationId: CORRELATION_ID },
        )
        .catch((candidate) => candidate);

      expectDomainError(error, "invalid_credentials");
      expect(verify).toHaveBeenCalledOnce();
      expect(verify).toHaveBeenCalledWith(
        withCredential && status !== null ? currentPasswordHash : legacyPasswordHash,
        suppliedPassword,
      );
      expect(harness.state.sessions).toEqual([]);
      expect(harness.state.audits).toEqual([]);
    },
  );

  test("opportunistically rehashes a valid legacy credential after locking the account", async () => {
    const harness = createHarness(currentPasswordHash);
    harness.state.accounts.push(account({ status: "active" }));
    harness.state.credentials.push({
      accountId: ACCOUNT_ID,
      passwordHash: legacyPasswordHash,
      passwordChangedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await harness.service.login(
      { email: "pending@example.test", password: PASSWORD },
      { correlationId: CORRELATION_ID },
    );

    expect(harness.repository.updateCredential).toHaveBeenCalledOnce();
    expect(harness.state.credentials[0]?.passwordHash).not.toBe(legacyPasswordHash);
  });

  test.each([
    ["expired", { expiresAt: NOW }],
    ["revoked", { revokedAt: NOW }],
    ["wrong audience", { audience: "trackfinder-api" }],
    ["unverified", {} as Partial<StoredSession>, account({ emailVerifiedAt: null })],
    ["suspended", {} as Partial<StoredSession>, account({ status: "suspended" })],
  ] as const)(
    "rejects %s portal authentication generically",
    async (_scenario, sessionOverrides, accountOverride = account()) => {
      const harness = createHarness(currentPasswordHash);
      const rawToken = "portal-session";
      harness.state.accounts.push(accountOverride);
      harness.state.sessions.push(session(rawToken, sessionOverrides));

      const error = await harness.service.authenticate(rawToken).catch((candidate) => candidate);
      expectDomainError(error, "invalid_credentials");
    },
  );

  test("revokes only the exact live portal session and emits secret-free audit values", async () => {
    const harness = createHarness(currentPasswordHash);
    const rawToken = "portal-session-to-revoke";
    harness.state.accounts.push(account());
    harness.state.sessions.push(session(rawToken));

    await harness.service.revoke(rawToken, { correlationId: CORRELATION_ID });

    expect(harness.state.sessions[0]?.revokedAt).toEqual(NOW);
    expect(harness.state.audits[0]).toMatchObject({
      actorAccountId: ACCOUNT_ID,
      targetType: "auth_session",
      action: "user.session_revoked",
      reason: "user_logout",
      previousValue: {
        audience: APOLLO_PORTAL_AUDIENCE,
        revokedAt: null,
        status: "pending",
      },
      newValue: {
        audience: APOLLO_PORTAL_AUDIENCE,
        revokedAt: NOW.toISOString(),
        status: "pending",
      },
    });
    const audit = JSON.stringify(harness.state.audits);
    for (const secret of [
      rawToken,
      digestOpaqueToken(rawToken),
      PASSWORD,
      "pending@example.test",
    ]) {
      expect(audit).not.toContain(secret);
    }
  });

  test.each([
    ["authenticate", "expiresAt"],
    ["authenticate", "revokedAt"],
    ["revoke", "expiresAt"],
    ["revoke", "revokedAt"],
  ] as const)(
    "%s fails closed for a non-finite session %s",
    async (operation, dateField) => {
      const harness = createHarness(currentPasswordHash);
      const rawToken = "invalid-date-session";
      harness.state.accounts.push(account());
      harness.state.sessions.push(
        session(rawToken, { [dateField]: new Date("invalid") }),
      );

      const error = await (
        operation === "authenticate"
          ? harness.service.authenticate(rawToken)
          : harness.service.revoke(rawToken, { correlationId: CORRELATION_ID })
      ).catch((candidate) => candidate);
      expectDomainError(error, "policy_unavailable");
    },
  );
});
