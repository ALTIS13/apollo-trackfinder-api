import type { Pool, PoolClient } from "pg";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { argon2id, hash as argonHash } from "argon2";

import { PlatformDomainError } from "./errors.js";
import {
  APOLLO_ADMIN_AUDIENCE,
  OPERATOR_CAPABILITIES,
  OperatorSessionService,
} from "./operator-sessions.js";
import type {
  Account,
  AuditEvent,
  AuthSession,
  Credential,
  PlatformRepository,
  RegistrationSettings,
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
const SETTINGS_ID = "00000000-0000-4000-8000-000000000004";
const CORRELATION_ID = "00000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-07-16T10:00:00.000Z");
const BOOTSTRAP_TOKEN = "task-6-bootstrap-secret";
const PASSWORD = "correct horse battery staple";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type StoredSession = Mutable<AuthSession> & { digest: string };
type PasswordVerifier = (
  hash: string,
  password: string,
) => Promise<PasswordVerificationResult>;

interface SessionState {
  settings: RegistrationSettings;
  accounts: Account[];
  credentials: Credential[];
  capabilities: Array<{ accountId: string; capability: string }>;
  sessions: StoredSession[];
  audits: AuditEvent[];
  entitlements: unknown[];
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: ACCOUNT_ID,
    email: "operator@example.com",
    displayName: "Apollo Operator",
    status: "active",
    emailVerifiedAt: NOW,
    activatedAt: NOW,
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
    audience: APOLLO_ADMIN_AUDIENCE,
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
  expect(Object.isFrozen(error)).toBe(true);
  expect(JSON.stringify(error)).not.toContain("operator@example.com");
  expect(JSON.stringify(error)).not.toContain(PASSWORD);
  expect(JSON.stringify(error)).not.toContain(BOOTSTRAP_TOKEN);
}

function createHarness(
  passwordHash: string,
  configuredToken = BOOTSTRAP_TOKEN,
  passwordVerification?: {
    readonly verify: PasswordVerifier;
    readonly dummyHash: string;
  },
) {
  const timeline: string[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      timeline.push(`query:${text}:${JSON.stringify(values ?? [])}`);
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as PoolClient;
  const state: SessionState = {
    settings: {
      id: SETTINGS_ID,
      mode: "closed",
      revision: 1,
      updatedByAccountId: null,
      updatedAt: NOW,
      operatorBootstrapAccountId: null,
      operatorBootstrapCompletedAt: null,
    },
    accounts: [],
    credentials: [],
    capabilities: [],
    sessions: [],
    audits: [],
    entitlements: [],
  };

  const repository = {
    lockRegistrationSettings: vi.fn<
      PlatformRepository["lockRegistrationSettings"]
    >(async () => {
      timeline.push("lockRegistrationSettings");
      return state.settings;
    }),
    findAccountByNormalizedEmail: vi.fn(async (_client, email: string) => {
      timeline.push("findAccountByNormalizedEmail");
      return (
        state.accounts.find((candidate) => candidate.email === email) ?? null
      );
    }),
    createAccount: vi.fn(async (_client, input) => {
      timeline.push("createAccount");
      if (
        state.accounts.some(
          (candidate) => candidate.email === input.normalizedEmail,
        )
      ) {
        throw Object.freeze({ code: "conflict", message: "redacted" });
      }
      const created = account({
        email: input.normalizedEmail,
        displayName: input.displayName,
        status: "pending",
        emailVerifiedAt: null,
        activatedAt: null,
      });
      state.accounts.push(created);
      return created;
    }),
    lockAccountById: vi.fn(async (_client, accountId: string) => {
      timeline.push("lockAccountById");
      return (
        state.accounts.find((candidate) => candidate.id === accountId) ?? null
      );
    }),
    createCredential: vi.fn(async (_client, input) => {
      timeline.push("createCredential");
      const created: Credential = {
        accountId: input.accountId,
        passwordHash: input.passwordHash,
        passwordChangedAt: input.passwordChangedAt,
        createdAt: input.passwordChangedAt,
        updatedAt: input.passwordChangedAt,
      };
      state.credentials.push(created);
      return created;
    }),
    findCredentialByAccountId: vi.fn(async (_client, accountId: string) => {
      timeline.push("findCredentialByAccountId");
      return (
        state.credentials.find(
          (candidate) => candidate.accountId === accountId,
        ) ?? null
      );
    }),
    updateCredential: vi.fn(async (_client, input) => {
      timeline.push("updateCredential");
      const current = state.credentials.find(
        (candidate) => candidate.accountId === input.accountId,
      );
      if (!current) throw new Error("missing credential");
      const updated = {
        ...current,
        ...input,
        updatedAt: input.passwordChangedAt,
      };
      Object.assign(current, updated);
      return updated;
    }),
    markAccountEmailVerified: vi.fn(async (_client, input) => {
      timeline.push("markAccountEmailVerified");
      const current = state.accounts.find(
        (candidate) => candidate.id === input.accountId,
      )!;
      Object.assign(current, {
        emailVerifiedAt: input.verifiedAt,
        updatedAt: input.verifiedAt,
      });
      return current;
    }),
    updateAccountStatus: vi.fn(async (_client, input) => {
      timeline.push("updateAccountStatus");
      const current = state.accounts.find(
        (candidate) => candidate.id === input.accountId,
      )!;
      Object.assign(current, {
        status: input.status,
        activatedAt:
          input.status === "active" ? input.changedAt : current.activatedAt,
        updatedAt: input.changedAt,
      });
      return current;
    }),
    insertOperatorCapabilities: vi.fn(async (_client, input) => {
      timeline.push("insertOperatorCapabilities");
      for (const capability of input.capabilities) {
        state.capabilities.push({ accountId: input.accountId, capability });
      }
      state.settings = {
        ...state.settings,
        operatorBootstrapAccountId: input.accountId,
        operatorBootstrapCompletedAt: NOW,
      };
    }),
    listOperatorCapabilities: vi.fn(async (_client, accountId: string) => {
      timeline.push("listOperatorCapabilities");
      return state.capabilities
        .filter((candidate) => candidate.accountId === accountId)
        .map((candidate) => candidate.capability)
        .sort();
    }),
    revokeSessionsForAccountByAudience: vi.fn(async (_client, input) => {
      timeline.push("revokeSessionsForAccountByAudience");
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
      timeline.push("createSession");
      const created: StoredSession = {
        id: SESSION_ID,
        accountId: input.accountId,
        installationId: input.installationId,
        audience: input.audience,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: NOW,
        lastSeenAt: NOW,
        digest: input.sessionDigest,
      };
      state.sessions.push(created);
      return created;
    }),
    findSessionByDigest: vi.fn(async (_client, digest: string) => {
      timeline.push("findSessionByDigest");
      return (
        state.sessions.find((candidate) => candidate.digest === digest) ?? null
      );
    }),
    lockSessionByDigest: vi.fn(async (_client, digest: string) => {
      timeline.push("lockSessionByDigest");
      return (
        state.sessions.find((candidate) => candidate.digest === digest) ?? null
      );
    }),
    revokeSession: vi.fn(async (_client, input) => {
      timeline.push("revokeSession");
      const current = state.sessions.find(
        (candidate) =>
          candidate.id === input.sessionId && candidate.revokedAt === null,
      );
      if (!current) return null;
      current.revokedAt = input.revokedAt;
      return current;
    }),
    insertAuditEvent: vi.fn(async (_client, input) => {
      timeline.push("insertAuditEvent");
      const event: AuditEvent = {
        id: `00000000-0000-4000-8000-${String(state.audits.length + 10).padStart(12, "0")}`,
        occurredAt: NOW,
        ...input,
      };
      state.audits.push(event);
      return event;
    }),
  };

  const transaction: PlatformTransaction = async (_pool, callback) => {
    timeline.push("transaction:start");
    const snapshot = structuredClone(state);
    try {
      const result = await callback(client);
      timeline.push("transaction:commit");
      return result;
    } catch (error) {
      Object.assign(state, snapshot);
      timeline.push("transaction:rollback");
      throw error;
    }
  };
  const clock = vi.fn(() => {
    timeline.push("clock");
    return new Date(NOW);
  });
  const service = new OperatorSessionService(
    {} as Pool,
    repository as unknown as PlatformRepository,
    configuredToken,
    clock,
    transaction,
    passwordVerification,
  );
  return { service, state, repository, timeline, clock };
}

describe("OperatorSessionService", () => {
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

  test("bootstraps exactly once with all operator capabilities and redacted audit evidence", async () => {
    const harness = createHarness(currentPasswordHash);

    const created = await harness.service.bootstrap(
      {
        bootstrapToken: BOOTSTRAP_TOKEN,
        email: " Operator@Example.COM ",
        displayName: " Apollo Operator ",
        password: PASSWORD,
        reason: "Initial operator bootstrap",
      },
      { correlationId: CORRELATION_ID },
    );

    expect(created).toMatchObject({
      id: ACCOUNT_ID,
      email: "operator@example.com",
      displayName: "Apollo Operator",
      status: "active",
      emailVerifiedAt: NOW,
      activatedAt: NOW,
    });
    expect(harness.state.credentials[0]?.passwordHash).not.toBe(PASSWORD);
    expect(
      harness.state.capabilities.map(({ capability }) => capability).sort(),
    ).toEqual([...OPERATOR_CAPABILITIES].sort());
    expect(harness.state.settings.operatorBootstrapAccountId).toBe(ACCOUNT_ID);
    expect(harness.state.entitlements).toEqual([]);
    expect(harness.state.audits).toHaveLength(1);
    expect(harness.state.audits[0]).toMatchObject({
      actorAccountId: null,
      targetType: "account",
      targetId: ACCOUNT_ID,
      action: "operator.bootstrap_completed",
      correlationId: CORRELATION_ID,
      reason: "Initial operator bootstrap",
      previousValue: null,
      newValue: {
        status: "active",
        emailVerified: true,
        capabilities: [...OPERATOR_CAPABILITIES].sort(),
      },
    });
    const auditJson = JSON.stringify(harness.state.audits);
    for (const secret of [
      PASSWORD,
      currentPasswordHash,
      BOOTSTRAP_TOKEN,
      digestOpaqueToken(BOOTSTRAP_TOKEN),
      "operator@example.com",
    ]) {
      expect(auditJson).not.toContain(secret);
    }
    expect(harness.timeline.indexOf("clock")).toBeGreaterThan(
      harness.timeline.indexOf("lockRegistrationSettings"),
    );
  });

  test("stores only the fixed-length bootstrap digest and rejects wrong token lengths generically", async () => {
    const harness = createHarness(currentPasswordHash);
    expect(JSON.stringify(harness.service)).not.toContain(BOOTSTRAP_TOKEN);

    for (const bootstrapToken of ["x", `${BOOTSTRAP_TOKEN}x`]) {
      await expect(
        harness.service.bootstrap(
          {
            bootstrapToken,
            email: "operator@example.com",
            displayName: "Operator",
            password: PASSWORD,
            reason: "bootstrap",
          },
          { correlationId: CORRELATION_ID },
        ),
      ).rejects.toMatchObject({ code: "invalid_credentials" });
    }
    expect(harness.repository.lockRegistrationSettings).not.toHaveBeenCalled();
  });

  test("fails closed when the configured bootstrap secret is empty", async () => {
    const harness = createHarness(currentPasswordHash, "");
    const error = await harness.service
      .bootstrap(
        {
          bootstrapToken: BOOTSTRAP_TOKEN,
          email: "operator@example.com",
          displayName: "Operator",
          password: PASSWORD,
          reason: "bootstrap",
        },
        { correlationId: CORRELATION_ID },
      )
      .catch((candidate) => candidate);
    expectDomainError(error, "policy_unavailable");
    expect(harness.timeline).toEqual([]);
  });

  test.each(["terminal marker", "duplicate email"])(
    "redacts %s bootstrap failure as invalid credentials and rolls back",
    async (scenario) => {
      const harness = createHarness(currentPasswordHash);
      if (scenario === "terminal marker") {
        harness.state.settings = {
          ...harness.state.settings,
          operatorBootstrapAccountId: ACCOUNT_ID,
          operatorBootstrapCompletedAt: NOW,
        };
      } else {
        harness.state.accounts.push(account());
      }
      const before = structuredClone(harness.state);

      const error = await harness.service
        .bootstrap(
          {
            bootstrapToken: BOOTSTRAP_TOKEN,
            email: "operator@example.com",
            displayName: "Operator",
            password: PASSWORD,
            reason: "bootstrap",
          },
          { correlationId: CORRELATION_ID },
        )
        .catch((candidate) => candidate);

      expectDomainError(error, "invalid_credentials");
      expect(harness.state).toEqual(before);
      expect(harness.state.audits).toEqual([]);
    },
  );

  test("fails closed when registration settings are missing", async () => {
    const harness = createHarness(currentPasswordHash);
    harness.repository.lockRegistrationSettings.mockResolvedValueOnce(null);

    const error = await harness.service
      .bootstrap(
        {
          bootstrapToken: BOOTSTRAP_TOKEN,
          email: "operator@example.com",
          displayName: "Operator",
          password: PASSWORD,
          reason: "initial bootstrap",
        },
        { correlationId: CORRELATION_ID },
      )
      .catch((candidate) => candidate);

    expectDomainError(error, "policy_unavailable");
    expect(harness.state.accounts).toEqual([]);
    expect(harness.state.audits).toEqual([]);
  });

  test.each([
    ["token equal", BOOTSTRAP_TOKEN],
    ["token embedded", `approved ${BOOTSTRAP_TOKEN} bootstrap`],
    ["password equal", PASSWORD],
    ["password embedded", `approved ${PASSWORD} bootstrap`],
    ["email equal", "OPERATOR@EXAMPLE.COM"],
    ["email embedded", "approved Operator@Example.Com bootstrap"],
  ])(
    "rejects a bootstrap reason containing the full raw %s before mutation",
    async (_scenario, reason) => {
      const harness = createHarness(currentPasswordHash);
      const before = structuredClone(harness.state);

      const error = await harness.service
        .bootstrap(
          {
            bootstrapToken: BOOTSTRAP_TOKEN,
            email: " Operator@Example.COM ",
            displayName: "Operator",
            password: PASSWORD,
            reason,
          },
          { correlationId: CORRELATION_ID },
        )
        .catch((candidate) => candidate);

      expectDomainError(error, "invalid_credentials");
      expect(harness.timeline).toEqual([]);
      expect(harness.state).toEqual(before);
      expect(harness.repository.createAccount).not.toHaveBeenCalled();
      expect(
        harness.repository.insertOperatorCapabilities,
      ).not.toHaveBeenCalled();
      expect(harness.repository.insertAuditEvent).not.toHaveBeenCalled();
    },
    30_000,
  );

  test("logs in an active capable operator, rotates only admin sessions, and stores a token digest", async () => {
    const harness = createHarness(currentPasswordHash);
    harness.state.accounts.push(account());
    harness.state.credentials.push({
      accountId: ACCOUNT_ID,
      passwordHash: currentPasswordHash,
      passwordChangedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    harness.state.capabilities.push({
      accountId: ACCOUNT_ID,
      capability: OPERATOR_CAPABILITIES[0],
    });
    harness.state.sessions.push(
      session("old-admin"),
      session("product", {
        id: PRODUCT_SESSION_ID,
        audience: "trackfinder-api",
      }),
    );

    const result = await harness.service.login(
      { email: " Operator@Example.COM ", password: PASSWORD },
      { correlationId: CORRELATION_ID },
    );

    expect(result.account.id).toBe(ACCOUNT_ID);
    expect(result.session.audience).toBe(APOLLO_ADMIN_AUDIENCE);
    expect(result.session.expiresAt).toEqual(
      new Date(NOW.getTime() + 8 * 60 * 60 * 1_000),
    );
    expect(result.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(harness.state.sessions.at(-1)?.digest).toBe(
      digestOpaqueToken(result.rawToken),
    );
    expect(JSON.stringify(harness.state.sessions)).not.toContain(
      result.rawToken,
    );
    expect(
      harness.state.sessions.find(({ id }) => id === SESSION_ID)?.revokedAt,
    ).toEqual(NOW);
    expect(
      harness.state.sessions.find(({ id }) => id === PRODUCT_SESSION_ID)
        ?.revokedAt,
    ).toBeNull();
    expect(harness.state.audits[0]).toMatchObject({
      actorAccountId: ACCOUNT_ID,
      targetType: "auth_session",
      action: "operator.session_created",
      correlationId: CORRELATION_ID,
      reason: "operator_login",
      previousValue: null,
      newValue: {
        audience: APOLLO_ADMIN_AUDIENCE,
        rotatedSessionCount: 1,
      },
    });
    const auditJson = JSON.stringify(harness.state.audits);
    expect(auditJson).not.toContain(result.rawToken);
    expect(auditJson).not.toContain(digestOpaqueToken(result.rawToken));
    expect(auditJson).not.toContain("operator@example.com");
  });

  test("opportunistically rehashes a valid legacy Argon2 credential after locking the account", async () => {
    const harness = createHarness(currentPasswordHash);
    harness.state.accounts.push(account());
    harness.state.credentials.push({
      accountId: ACCOUNT_ID,
      passwordHash: legacyPasswordHash,
      passwordChangedAt: new Date(NOW.getTime() - 60_000),
      createdAt: new Date(NOW.getTime() - 60_000),
      updatedAt: new Date(NOW.getTime() - 60_000),
    });
    harness.state.capabilities.push({
      accountId: ACCOUNT_ID,
      capability: OPERATOR_CAPABILITIES[0],
    });

    await harness.service.login(
      { email: "operator@example.com", password: PASSWORD },
      { correlationId: CORRELATION_ID },
    );

    expect(harness.repository.updateCredential).toHaveBeenCalledOnce();
    expect(harness.state.credentials[0]?.passwordHash).not.toBe(
      legacyPasswordHash,
    );
    expect(harness.timeline.indexOf("updateCredential")).toBeGreaterThan(
      harness.timeline.indexOf("lockAccountById"),
    );
  });

  test.each([
    ["missing account", null, false, PASSWORD, true],
    ["pending account", "pending", true, PASSWORD, true],
    ["suspended account", "suspended", true, PASSWORD, true],
    ["deleted account", "deleted", true, PASSWORD, true],
    ["credentialless account", "active", false, PASSWORD, true],
    ["wrong password", "active", true, "wrong password", true],
    ["no live capability", "active", true, PASSWORD, false],
  ] as const)(
    "performs one verification and returns the same invalid credentials for %s",
    async (
      _scenario,
      status,
      withCredential,
      suppliedPassword,
      withCapability,
    ) => {
      const passwordVerifier = vi.fn<PasswordVerifier>(
        async (hash, password) => ({
          valid: hash === currentPasswordHash && password === PASSWORD,
          needsRehash: false,
        }),
      );
      const harness = createHarness(currentPasswordHash, BOOTSTRAP_TOKEN, {
        verify: passwordVerifier,
        dummyHash: legacyPasswordHash,
      });
      if (status !== null) {
        harness.state.accounts.push(account({ status }));
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
      if (withCapability) {
        harness.state.capabilities.push({
          accountId: ACCOUNT_ID,
          capability: OPERATOR_CAPABILITIES[0],
        });
      }

      const error = await harness.service
        .login(
          { email: "operator@example.com", password: suppliedPassword },
          { correlationId: CORRELATION_ID },
        )
        .catch((candidate) => candidate);

      expectDomainError(error, "invalid_credentials");
      expect(passwordVerifier).toHaveBeenCalledOnce();
      expect(passwordVerifier).toHaveBeenCalledWith(
        withCredential ? currentPasswordHash : legacyPasswordHash,
        suppliedPassword,
      );
      expect(harness.state.sessions).toEqual([]);
      expect(harness.state.audits).toEqual([]);
    },
    30_000,
  );

  test("authenticates only the exact live admin token for an active capable account", async () => {
    const harness = createHarness(currentPasswordHash);
    const rawToken = "exact-session-token";
    harness.state.accounts.push(account());
    harness.state.capabilities.push({
      accountId: ACCOUNT_ID,
      capability: OPERATOR_CAPABILITIES[0],
    });
    harness.state.sessions.push(session(rawToken));

    await expect(harness.service.authenticate(rawToken)).resolves.toEqual({
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      capabilities: [OPERATOR_CAPABILITIES[0]],
    });
    await expect(
      harness.service.authenticate(` ${rawToken} `),
    ).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  test.each([
    ["expired", { expiresAt: NOW }],
    ["revoked", { revokedAt: NOW }],
    ["wrong audience", { audience: "trackfinder-api" }],
  ] as const)(
    "rejects %s sessions generically",
    async (_scenario, override) => {
      const harness = createHarness(currentPasswordHash);
      const rawToken = "candidate-session";
      harness.state.accounts.push(account());
      harness.state.capabilities.push({
        accountId: ACCOUNT_ID,
        capability: OPERATOR_CAPABILITIES[0],
      });
      harness.state.sessions.push(session(rawToken, override));

      const error = await harness.service
        .authenticate(rawToken)
        .catch((candidate) => candidate);
      expectDomainError(error, "invalid_credentials");
    },
  );

  test.each(["suspended", "deleted"] as const)(
    "rejects authenticate and revoke for a %s account",
    async (status) => {
      for (const operation of ["authenticate", "revoke"] as const) {
        const harness = createHarness(currentPasswordHash);
        const rawToken = `${operation}-${status}-session`;
        harness.state.accounts.push(account({ status }));
        harness.state.capabilities.push({
          accountId: ACCOUNT_ID,
          capability: OPERATOR_CAPABILITIES[0],
        });
        harness.state.sessions.push(session(rawToken));

        const error = await (
          operation === "authenticate"
            ? harness.service.authenticate(rawToken)
            : harness.service.revoke(rawToken, {
                correlationId: CORRELATION_ID,
              })
        ).catch((candidate) => candidate);

        expectDomainError(error, "invalid_credentials");
        expect(harness.state.audits).toEqual([]);
      }
    },
  );

  test.each(["authenticate", "revoke"] as const)(
    "%s fails closed for a non-finite clock",
    async (operation) => {
      const harness = createHarness(currentPasswordHash);
      const rawToken = `${operation}-invalid-clock`;
      harness.state.accounts.push(account());
      harness.state.capabilities.push({
        accountId: ACCOUNT_ID,
        capability: OPERATOR_CAPABILITIES[0],
      });
      harness.state.sessions.push(session(rawToken));
      harness.clock.mockReturnValueOnce(new Date("invalid"));

      const error = await (
        operation === "authenticate"
          ? harness.service.authenticate(rawToken)
          : harness.service.revoke(rawToken, { correlationId: CORRELATION_ID })
      ).catch((candidate) => candidate);

      expectDomainError(error, "policy_unavailable");
      expect(harness.state.audits).toEqual([]);
    },
  );

  test("revoke fails closed when storage returns a session without a revocation date", async () => {
    const harness = createHarness(currentPasswordHash);
    const rawToken = "missing-revocation-date";
    harness.state.accounts.push(account());
    harness.state.capabilities.push({
      accountId: ACCOUNT_ID,
      capability: OPERATOR_CAPABILITIES[0],
    });
    harness.state.sessions.push(session(rawToken));
    harness.repository.revokeSession.mockResolvedValueOnce(
      session(rawToken, { revokedAt: null }),
    );

    const error = await harness.service
      .revoke(rawToken, { correlationId: CORRELATION_ID })
      .catch((candidate) => candidate);

    expectDomainError(error, "policy_unavailable");
    expect(harness.state.audits).toEqual([]);
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
      const rawToken = `${operation}-invalid-${dateField}`;
      harness.state.accounts.push(account());
      harness.state.capabilities.push({
        accountId: ACCOUNT_ID,
        capability: OPERATOR_CAPABILITIES[0],
      });
      harness.state.sessions.push(
        session(rawToken, { [dateField]: new Date("invalid") }),
      );

      const error = await (
        operation === "authenticate"
          ? harness.service.authenticate(rawToken)
          : harness.service.revoke(rawToken, { correlationId: CORRELATION_ID })
      ).catch((candidate) => candidate);

      expectDomainError(error, "policy_unavailable");
      expect(harness.state.audits).toEqual([]);
    },
  );

  test.each([
    [
      "locked account identity",
      (harness: ReturnType<typeof createHarness>) => {
        harness.repository.lockAccountById.mockResolvedValueOnce(
          account({ id: "00000000-0000-4000-8000-000000000099" }),
        );
      },
    ],
    [
      "fresh session id",
      (harness: ReturnType<typeof createHarness>) => {
        harness.repository.lockSessionByDigest.mockResolvedValueOnce(
          session("ignored", {
            id: "00000000-0000-4000-8000-000000000098",
          }),
        );
      },
    ],
    [
      "fresh session account identity",
      (harness: ReturnType<typeof createHarness>) => {
        harness.repository.lockSessionByDigest.mockResolvedValueOnce(
          session("ignored", {
            accountId: "00000000-0000-4000-8000-000000000097",
          }),
        );
      },
    ],
  ] as const)("fails closed for mismatched %s", async (_scenario, arrange) => {
    const harness = createHarness(currentPasswordHash);
    const rawToken = "identity-mismatch-session";
    harness.state.accounts.push(account());
    harness.state.capabilities.push({
      accountId: ACCOUNT_ID,
      capability: OPERATOR_CAPABILITIES[0],
    });
    harness.state.sessions.push(session(rawToken));
    arrange(harness);

    const error = await harness.service
      .authenticate(rawToken)
      .catch((candidate) => candidate);

    expectDomainError(error, "policy_unavailable");
  });

  test.each(["revoke", "login rotation"])(
    "authentication cannot succeed after %s commits after the initial digest read",
    async (_mutation) => {
      const harness = createHarness(currentPasswordHash);
      const rawToken = `stale-${_mutation}-session`;
      harness.state.accounts.push(account());
      harness.state.capabilities.push({
        accountId: ACCOUNT_ID,
        capability: OPERATOR_CAPABILITIES[0],
      });
      harness.state.sessions.push(session(rawToken));
      let releaseInitialRead!: () => void;
      const mutationCommitted = new Promise<void>((resolve) => {
        releaseInitialRead = resolve;
      });
      let notifyInitialRead!: () => void;
      const initialReadCompleted = new Promise<void>((resolve) => {
        notifyInitialRead = resolve;
      });
      harness.repository.findSessionByDigest.mockImplementationOnce(
        async (_client, digest) => {
          const stale = structuredClone(
            harness.state.sessions.find(
              (candidate) => candidate.digest === digest,
            ) ?? null,
          );
          notifyInitialRead();
          await mutationCommitted;
          return stale;
        },
      );

      const authentication = harness.service.authenticate(rawToken);
      await initialReadCompleted;
      harness.state.sessions[0]!.revokedAt = new Date(NOW);
      releaseInitialRead();

      await expect(authentication).rejects.toMatchObject({
        code: "invalid_credentials",
      });
      expect(harness.repository.lockSessionByDigest).toHaveBeenCalledWith(
        expect.anything(),
        digestOpaqueToken(rawToken),
      );
    },
  );

  test("conditionally revokes and audits the current admin session in one transaction", async () => {
    const harness = createHarness(currentPasswordHash);
    const rawToken = "session-to-revoke";
    harness.state.accounts.push(account());
    harness.state.capabilities.push({
      accountId: ACCOUNT_ID,
      capability: OPERATOR_CAPABILITIES[0],
    });
    harness.state.sessions.push(session(rawToken));

    await harness.service.revoke(rawToken, { correlationId: CORRELATION_ID });

    expect(harness.state.sessions[0]?.revokedAt).toEqual(NOW);
    expect(harness.state.audits[0]).toMatchObject({
      actorAccountId: ACCOUNT_ID,
      targetType: "auth_session",
      targetId: SESSION_ID,
      action: "operator.session_revoked",
      correlationId: CORRELATION_ID,
      reason: "operator_logout",
      previousValue: { audience: APOLLO_ADMIN_AUDIENCE, revokedAt: null },
      newValue: {
        audience: APOLLO_ADMIN_AUDIENCE,
        revokedAt: NOW.toISOString(),
      },
    });
  });

  test("maps unexpected session storage failures to policy unavailable", async () => {
    const harness = createHarness(currentPasswordHash);
    harness.repository.findSessionByDigest.mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const error = await harness.service
      .authenticate("session-token")
      .catch((candidate) => candidate);
    expectDomainError(error, "policy_unavailable");
  });

  test("rolls back bootstrap rows when bootstrap audit insertion fails", async () => {
    const harness = createHarness(currentPasswordHash);
    harness.repository.insertAuditEvent.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    const before = structuredClone(harness.state);

    const error = await harness.service
      .bootstrap(
        {
          bootstrapToken: BOOTSTRAP_TOKEN,
          email: "operator@example.com",
          displayName: "Operator",
          password: PASSWORD,
          reason: "bootstrap",
        },
        { correlationId: CORRELATION_ID },
      )
      .catch((candidate) => candidate);

    expectDomainError(error, "policy_unavailable");
    expect(harness.state).toEqual(before);
  });

  test("rolls back session rotation and creation when login audit insertion fails", async () => {
    const harness = createHarness(currentPasswordHash);
    harness.state.accounts.push(account());
    harness.state.credentials.push({
      accountId: ACCOUNT_ID,
      passwordHash: currentPasswordHash,
      passwordChangedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    harness.state.capabilities.push({
      accountId: ACCOUNT_ID,
      capability: OPERATOR_CAPABILITIES[0],
    });
    harness.state.sessions.push(session("existing-admin"));
    harness.repository.insertAuditEvent.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    const before = structuredClone(harness.state);

    const error = await harness.service
      .login(
        { email: "operator@example.com", password: PASSWORD },
        { correlationId: CORRELATION_ID },
      )
      .catch((candidate) => candidate);

    expectDomainError(error, "policy_unavailable");
    expect(harness.state).toEqual(before);
  });

  test("rolls back current-session revocation when logout audit insertion fails", async () => {
    const harness = createHarness(currentPasswordHash);
    const rawToken = "rollback-session";
    harness.state.accounts.push(account());
    harness.state.capabilities.push({
      accountId: ACCOUNT_ID,
      capability: OPERATOR_CAPABILITIES[0],
    });
    harness.state.sessions.push(session(rawToken));
    harness.repository.insertAuditEvent.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    const before = structuredClone(harness.state);

    const error = await harness.service
      .revoke(rawToken, { correlationId: CORRELATION_ID })
      .catch((candidate) => candidate);

    expectDomainError(error, "policy_unavailable");
    expect(harness.state).toEqual(before);
  });
});
