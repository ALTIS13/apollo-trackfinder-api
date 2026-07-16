import type { Pool, PoolClient } from "pg";
import { describe, expect, test } from "vitest";

import type {
  AccountStatus,
  RegistrationMode,
} from "@workspace/platform-contract";

import { PlatformDomainError } from "./errors.js";
import {
  RegistrationService,
  type PlatformTransaction,
} from "./registration.js";
import type {
  Account,
  AccountEntitlement,
  AuditEvent,
  AuthSession,
  Credential,
  PlatformRepository,
  RegistrationSettings,
  VerificationToken,
} from "./repository.js";
import { digestOpaqueToken } from "./security.js";

const NOW = new Date("2026-07-16T10:00:00.000Z");
const CREATED_AT = new Date("2026-07-15T10:00:00.000Z");
const SETTINGS_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ACCOUNT_ID = "00000000-0000-4000-8000-000000000002";
const OPERATOR_ACCOUNT_ID = "00000000-0000-4000-8000-000000000099";
const CORRELATION_ID = "00000000-0000-4000-8000-000000000100";
const RAW_VERIFICATION_TOKEN = "verification-token-secret";
const FAKE_POOL = {} as Pool;

const REQUEST_CONTEXT = Object.freeze({ correlationId: CORRELATION_ID });
const OPERATOR_CONTEXT = Object.freeze({
  accountId: OPERATOR_ACCOUNT_ID,
  correlationId: CORRELATION_ID,
});

const ERROR_MESSAGES = Object.freeze({
  registration_not_available: "Registration is not available.",
  invitation_not_available: "Invitation registration is not available.",
  policy_unavailable: "Policy is unavailable.",
});

interface StoredVerificationToken extends VerificationToken {
  readonly digest: string;
}

interface StatefulData {
  registrationSettings: RegistrationSettings;
  accounts: Account[];
  credentials: Credential[];
  verificationTokens: StoredVerificationToken[];
  entitlements: AccountEntitlement[];
  sessions: AuthSession[];
  audits: AuditEvent[];
}

function uuid(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

function makeSettings(
  mode: RegistrationMode = "open_approval",
): RegistrationSettings {
  return {
    id: SETTINGS_ID,
    mode,
    revision: 1,
    updatedByAccountId: null,
    updatedAt: CREATED_AT,
  };
}

function makeAccount(
  status: AccountStatus = "pending",
  overrides: Partial<Account> = {},
): Account {
  return {
    id: TARGET_ACCOUNT_ID,
    email: "person@example.com",
    displayName: "Person",
    status,
    emailVerifiedAt: null,
    activatedAt: status === "active" ? CREATED_AT : null,
    suspendedAt: status === "suspended" ? CREATED_AT : null,
    deletedAt: status === "deleted" ? CREATED_AT : null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function makeEntitlement(
  overrides: Partial<AccountEntitlement> = {},
): AccountEntitlement {
  return {
    id: uuid(200),
    accountId: TARGET_ACCOUNT_ID,
    moduleId: uuid(201),
    moduleKey: "tf.search",
    expiresAt: null,
    revokedAt: null,
    source: "operator",
    grantedByAccountId: OPERATOR_ACCOUNT_ID,
    reason: "Beta access",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function makeSession(
  sequence: number,
  overrides: Partial<AuthSession> = {},
): AuthSession {
  return {
    id: uuid(300 + sequence),
    accountId: TARGET_ACCOUNT_ID,
    installationId: null,
    audience: "trackfinder",
    expiresAt: new Date("2026-08-16T10:00:00.000Z"),
    revokedAt: null,
    createdAt: CREATED_AT,
    lastSeenAt: CREATED_AT,
    ...overrides,
  };
}

function initialState(mode: RegistrationMode = "open_approval"): StatefulData {
  return {
    registrationSettings: makeSettings(mode),
    accounts: [],
    credentials: [],
    verificationTokens: [],
    entitlements: [],
    sessions: [],
    audits: [],
  };
}

class StatefulRegistrationHarness implements PlatformRepository {
  state: StatefulData;
  transactionCount = 0;
  readonly operations: string[] = [];
  readonly accountContexts: string[] = [];
  failAudit = false;
  failOperation: { readonly name: string; readonly error: unknown } | null =
    null;

  private currentAccountId: string | null = null;

  constructor(mode: RegistrationMode = "open_approval") {
    this.state = initialState(mode);
  }

  readonly transaction: PlatformTransaction = async <T>(
    _pool: Pool,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> => {
    this.transactionCount += 1;
    const snapshot = structuredClone(this.state);
    this.currentAccountId = null;
    const client = {
      query: async (sql: string, values?: readonly unknown[]) => {
        if (!sql.includes("set_config('app.account_id'")) {
          throw new Error(`Unexpected fake client query: ${sql}`);
        }
        const accountId = values?.[0];
        if (typeof accountId !== "string") {
          throw new Error("Account RLS context must be a string");
        }
        this.currentAccountId = accountId;
        this.accountContexts.push(accountId);
        this.operations.push(`setAccountContext:${accountId}`);
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;

    try {
      return await callback(client);
    } catch (error) {
      this.state = snapshot;
      throw error;
    } finally {
      this.currentAccountId = null;
    }
  };

  private record(name: string): void {
    this.operations.push(name);
    if (this.failOperation?.name === name) {
      throw this.failOperation.error;
    }
  }

  private requireAccountContext(accountId: string, operation: string): void {
    this.record(operation);
    if (this.currentAccountId !== accountId) {
      throw new Error(
        `RLS denied ${operation}: expected ${accountId}, received ${this.currentAccountId ?? "none"}`,
      );
    }
  }

  private unsupported(name: string): never {
    throw new Error(`Unexpected repository operation: ${name}`);
  }

  getRegistrationSettings: PlatformRepository["getRegistrationSettings"] =
    async () => {
      this.record("getRegistrationSettings");
      return this.state.registrationSettings;
    };

  lockRegistrationSettings: PlatformRepository["lockRegistrationSettings"] =
    async () => {
      this.record("lockRegistrationSettings");
      return this.state.registrationSettings;
    };

  updateRegistrationSettings: PlatformRepository["updateRegistrationSettings"] =
    async (_client, input) => {
      this.record("updateRegistrationSettings");
      this.state.registrationSettings = {
        ...this.state.registrationSettings,
        mode: input.mode,
        revision: this.state.registrationSettings.revision + 1,
        updatedByAccountId: input.updatedByAccountId,
        updatedAt: NOW,
      };
      return this.state.registrationSettings;
    };

  findAccountByNormalizedEmail: PlatformRepository["findAccountByNormalizedEmail"] =
    async (_client, normalizedEmail) => {
      this.record("findAccountByNormalizedEmail");
      return (
        this.state.accounts.find(
          (account) => account.email === normalizedEmail,
        ) ?? null
      );
    };

  createAccount: PlatformRepository["createAccount"] = async (
    _client,
    input,
  ) => {
    this.record("createAccount");
    if (
      this.state.accounts.some(
        (account) => account.email === input.normalizedEmail,
      )
    ) {
      throw {
        code: "conflict",
        message: `duplicate email ${input.normalizedEmail}`,
        detail: "SQLSTATE 23505 on postgres://admin:secret@database/apollo",
      };
    }
    const account: Account = {
      id: uuid(10 + this.state.accounts.length),
      email: input.normalizedEmail,
      displayName: input.displayName,
      status: "pending",
      emailVerifiedAt: null,
      activatedAt: null,
      suspendedAt: null,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.state.accounts.push(account);
    return account;
  };

  lockAccountById: PlatformRepository["lockAccountById"] = async (
    _client,
    accountId,
  ) => {
    this.requireAccountContext(accountId, "lockAccountById");
    return (
      this.state.accounts.find((account) => account.id === accountId) ?? null
    );
  };

  updateAccountStatus: PlatformRepository["updateAccountStatus"] = async (
    _client,
    input,
  ) => {
    this.requireAccountContext(input.accountId, "updateAccountStatus");
    const index = this.state.accounts.findIndex(
      (account) => account.id === input.accountId,
    );
    const account = this.state.accounts[index];
    if (account === undefined) {
      throw new Error("Missing account in stateful fake");
    }
    const updated: Account = {
      ...account,
      status: input.status,
      activatedAt:
        input.status === "active"
          ? (account.activatedAt ?? input.changedAt)
          : account.activatedAt,
      suspendedAt:
        input.status === "suspended" ? input.changedAt : account.suspendedAt,
      deletedAt:
        input.status === "deleted" ? input.changedAt : account.deletedAt,
      updatedAt: input.changedAt,
    };
    this.state.accounts[index] = updated;
    return updated;
  };

  markAccountEmailVerified: PlatformRepository["markAccountEmailVerified"] =
    async (_client, input) => {
      this.requireAccountContext(input.accountId, "markAccountEmailVerified");
      const index = this.state.accounts.findIndex(
        (account) => account.id === input.accountId,
      );
      const account = this.state.accounts[index];
      if (account === undefined) {
        throw new Error("Missing account in stateful fake");
      }
      const updated: Account = {
        ...account,
        emailVerifiedAt: account.emailVerifiedAt ?? input.verifiedAt,
        updatedAt: input.verifiedAt,
      };
      this.state.accounts[index] = updated;
      return updated;
    };

  createCredential: PlatformRepository["createCredential"] = async (
    _client,
    input,
  ) => {
    this.requireAccountContext(input.accountId, "createCredential");
    const credential: Credential = {
      accountId: input.accountId,
      passwordHash: input.passwordHash,
      passwordChangedAt: input.passwordChangedAt,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.state.credentials.push(credential);
    return credential;
  };

  findCredentialByAccountId: PlatformRepository["findCredentialByAccountId"] =
    async () => this.unsupported("findCredentialByAccountId");

  updateCredential: PlatformRepository["updateCredential"] = async () =>
    this.unsupported("updateCredential");

  createVerificationToken: PlatformRepository["createVerificationToken"] =
    async (_client, input) => {
      this.requireAccountContext(input.accountId, "createVerificationToken");
      const token: StoredVerificationToken = {
        id: uuid(100 + this.state.verificationTokens.length),
        accountId: input.accountId,
        digest: input.tokenDigest,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: NOW,
      };
      this.state.verificationTokens.push(token);
      return token;
    };

  lockVerificationTokenByDigest: PlatformRepository["lockVerificationTokenByDigest"] =
    async (_client, tokenDigest) => {
      this.record("lockVerificationTokenByDigest");
      return (
        this.state.verificationTokens.find(
          (token) => token.digest === tokenDigest,
        ) ?? null
      );
    };

  consumeVerificationToken: PlatformRepository["consumeVerificationToken"] =
    async (_client, input) => {
      const index = this.state.verificationTokens.findIndex(
        (token) => token.id === input.verificationTokenId,
      );
      const token = this.state.verificationTokens[index];
      if (token === undefined) {
        this.record("consumeVerificationToken");
        return null;
      }
      this.requireAccountContext(token.accountId, "consumeVerificationToken");
      if (token.consumedAt !== null) {
        return null;
      }
      const consumed = { ...token, consumedAt: input.consumedAt };
      this.state.verificationTokens[index] = consumed;
      return consumed;
    };

  createInvitation: PlatformRepository["createInvitation"] = async () =>
    this.unsupported("createInvitation");

  lockInvitationByDigest: PlatformRepository["lockInvitationByDigest"] =
    async () => this.unsupported("lockInvitationByDigest");

  addInvitationGrants: PlatformRepository["addInvitationGrants"] = async () =>
    this.unsupported("addInvitationGrants");

  listInvitationGrants: PlatformRepository["listInvitationGrants"] = async () =>
    this.unsupported("listInvitationGrants");

  incrementInvitationUse: PlatformRepository["incrementInvitationUse"] =
    async () => this.unsupported("incrementInvitationUse");

  revokeInvitation: PlatformRepository["revokeInvitation"] = async () =>
    this.unsupported("revokeInvitation");

  findModulesByKeys: PlatformRepository["findModulesByKeys"] = async () =>
    this.unsupported("findModulesByKeys");

  listAccountEntitlements: PlatformRepository["listAccountEntitlements"] =
    async (_client, accountId) => {
      this.requireAccountContext(accountId, "listAccountEntitlements");
      return this.state.entitlements.filter(
        (entitlement) => entitlement.accountId === accountId,
      );
    };

  upsertAccountEntitlement: PlatformRepository["upsertAccountEntitlement"] =
    async () => this.unsupported("upsertAccountEntitlement");

  revokeAccountEntitlement: PlatformRepository["revokeAccountEntitlement"] =
    async () => this.unsupported("revokeAccountEntitlement");

  listOperatorCapabilities: PlatformRepository["listOperatorCapabilities"] =
    async () => this.unsupported("listOperatorCapabilities");

  createSession: PlatformRepository["createSession"] = async () =>
    this.unsupported("createSession");

  findSessionByDigest: PlatformRepository["findSessionByDigest"] = async () =>
    this.unsupported("findSessionByDigest");

  listSessionsForAccount: PlatformRepository["listSessionsForAccount"] =
    async () => this.unsupported("listSessionsForAccount");

  revokeSession: PlatformRepository["revokeSession"] = async () =>
    this.unsupported("revokeSession");

  revokeAllSessionsForAccount: PlatformRepository["revokeAllSessionsForAccount"] =
    async (_client, input) => {
      this.requireAccountContext(
        input.accountId,
        "revokeAllSessionsForAccount",
      );
      let revoked = 0;
      this.state.sessions = this.state.sessions.map((session) => {
        if (
          session.accountId !== input.accountId ||
          session.revokedAt !== null
        ) {
          return session;
        }
        revoked += 1;
        return { ...session, revokedAt: input.revokedAt };
      });
      return revoked;
    };

  insertAuditEvent: PlatformRepository["insertAuditEvent"] = async (
    _client,
    input,
  ) => {
    this.record("insertAuditEvent");
    if (this.failAudit) {
      throw {
        code: "storage_unavailable",
        message: "audit INSERT failed for person@example.com",
        detail: `digest ${"d".repeat(64)} at postgres://admin:secret@database/apollo`,
      };
    }
    const event: AuditEvent = {
      id: uuid(500 + this.state.audits.length),
      ...input,
      occurredAt: NOW,
    };
    this.state.audits.push(event);
    return event;
  };
}

function createHarness(mode: RegistrationMode = "open_approval") {
  const harness = new StatefulRegistrationHarness(mode);
  const service = new RegistrationService(
    FAKE_POOL,
    harness,
    () => new Date(NOW),
    harness.transaction,
  );
  return { harness, service };
}

function seedAccount(
  harness: StatefulRegistrationHarness,
  status: AccountStatus = "pending",
  overrides: Partial<Account> = {},
): Account {
  const account = makeAccount(status, overrides);
  harness.state.accounts.push(account);
  return account;
}

function seedVerificationToken(
  harness: StatefulRegistrationHarness,
  rawToken = RAW_VERIFICATION_TOKEN,
  overrides: Partial<StoredVerificationToken> = {},
): StoredVerificationToken {
  const token: StoredVerificationToken = {
    id: uuid(100),
    accountId: TARGET_ACCOUNT_ID,
    digest: digestOpaqueToken(rawToken),
    expiresAt: new Date("2026-07-17T10:00:00.000Z"),
    consumedAt: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
  harness.state.verificationTokens.push(token);
  return token;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject");
}

function expectDomainError(
  error: unknown,
  code: keyof typeof ERROR_MESSAGES,
): void {
  expect(error).toBeInstanceOf(PlatformDomainError);
  if (!(error instanceof PlatformDomainError)) {
    throw new Error("Expected PlatformDomainError");
  }
  expect(error.code).toBe(code);
  expect(error.message).toBe(ERROR_MESSAGES[code]);
  expect(Object.isFrozen(error)).toBe(true);

  const publicText = `${error.message} ${JSON.stringify(error)}`.toLowerCase();
  for (const secret of [
    "person@example.com",
    "sqlstate",
    "postgres://",
    "admin:secret",
    "digest",
    "connection",
  ]) {
    expect(publicText).not.toContain(secret);
  }
  expect("cause" in error).toBe(false);
}

function expectCompleteAudit(
  audit: AuditEvent | undefined,
  expected: Omit<AuditEvent, "id" | "occurredAt">,
): void {
  expect(audit).toBeDefined();
  expect(audit).toMatchObject(expected);
  expect(audit?.occurredAt).toEqual(NOW);
  expect(audit?.actorAccountId).not.toBeUndefined();
  expect(audit?.targetType).not.toBe("");
  expect(audit?.targetId).not.toBe("");
  expect(audit?.action).not.toBe("");
  expect(audit?.reason).not.toBe("");
  expect(audit?.correlationId).toBe(CORRELATION_ID);
  expect(audit?.previousValue).not.toBeUndefined();
  expect(audit?.newValue).not.toBeUndefined();
}

describe("RegistrationService registration modes", () => {
  test.each(["closed", "invite_only", "open_approval"] as const)(
    "reports %s without exposing any other setting",
    async (mode) => {
      const { harness, service } = createHarness(mode);

      await expect(service.getStatus()).resolves.toEqual({ mode });
      expect(harness.transactionCount).toBe(1);
      expect(harness.operations).toEqual(["getRegistrationSettings"]);
    },
  );

  test.each([
    ["closed", "registration_not_available"],
    ["invite_only", "invitation_not_available"],
    ["open_approval", null],
  ] as const)(
    "enforces %s registration with one transaction",
    async (mode, expectedCode) => {
      const { harness, service } = createHarness(mode);
      const operation = service.register(
        {
          email: "  New.Person@Example.COM ",
          displayName: "  New Person  ",
          password: "correct horse battery staple",
        },
        REQUEST_CONTEXT,
      );

      if (expectedCode !== null) {
        expectDomainError(await captureError(operation), expectedCode);
        expect(harness.state.accounts).toEqual([]);
        expect(harness.state.audits).toEqual([]);
        expect(harness.transactionCount).toBe(1);
        return;
      }

      const result = await operation;
      expect(result.account).toMatchObject({
        email: "new.person@example.com",
        displayName: "New Person",
        status: "pending",
        emailVerifiedAt: null,
        activatedAt: null,
      });
      expect(result.verificationToken).toEqual(expect.any(String));
      expect(result.verificationToken).not.toBe("");
      expect(harness.state.credentials).toHaveLength(1);
      expect(harness.state.credentials[0]?.passwordHash).toMatch(
        /^\$argon2id\$/,
      );
      expect(harness.state.credentials[0]?.passwordHash).not.toContain(
        "correct horse battery staple",
      );
      expect(harness.state.verificationTokens).toHaveLength(1);
      expect(harness.state.verificationTokens[0]).toMatchObject({
        accountId: result.account.id,
        digest: digestOpaqueToken(result.verificationToken),
        expiresAt: new Date("2026-07-17T10:00:00.000Z"),
        consumedAt: null,
      });
      expect(JSON.stringify(harness.state)).not.toContain(
        result.verificationToken,
      );
      expect(JSON.stringify(harness.state)).not.toContain(
        "correct horse battery staple",
      );
      expect(harness.transactionCount).toBe(1);
      expect(harness.accountContexts).toEqual([result.account.id]);
      expect(harness.operations).toEqual([
        "lockRegistrationSettings",
        "createAccount",
        `setAccountContext:${result.account.id}`,
        "createCredential",
        "createVerificationToken",
        "insertAuditEvent",
      ]);
      expectCompleteAudit(harness.state.audits[0], {
        actorAccountId: null,
        targetType: "account",
        targetId: result.account.id,
        action: "account.registered",
        correlationId: CORRELATION_ID,
        reason: "self_service_registration",
        previousValue: null,
        newValue: { status: "pending", emailVerified: false },
      });
    },
    20_000,
  );

  test("changes only registration settings and records complete operator audit", async () => {
    const { harness, service } = createHarness("closed");
    const account = seedAccount(harness, "active");
    harness.state.sessions.push(makeSession(1));
    const accountsBefore = structuredClone(harness.state.accounts);
    const sessionsBefore = structuredClone(harness.state.sessions);

    await expect(
      service.changeMode(
        { mode: "open_approval", reason: "Open controlled beta" },
        OPERATOR_CONTEXT,
      ),
    ).resolves.toEqual({ mode: "open_approval" });

    expect(harness.state.accounts).toEqual(accountsBefore);
    expect(harness.state.sessions).toEqual(sessionsBefore);
    expect(harness.state.registrationSettings).toMatchObject({
      mode: "open_approval",
      revision: 2,
      updatedByAccountId: OPERATOR_ACCOUNT_ID,
    });
    expect(harness.accountContexts).toEqual([]);
    expect(harness.operations).toEqual([
      "lockRegistrationSettings",
      "updateRegistrationSettings",
      "insertAuditEvent",
    ]);
    expect(harness.transactionCount).toBe(1);
    expect(harness.state.accounts[0]?.id).toBe(account.id);
    expectCompleteAudit(harness.state.audits[0], {
      actorAccountId: OPERATOR_ACCOUNT_ID,
      targetType: "registration_settings",
      targetId: SETTINGS_ID,
      action: "registration.mode_changed",
      correlationId: CORRELATION_ID,
      reason: "Open controlled beta",
      previousValue: { mode: "closed", revision: 1 },
      newValue: { mode: "open_approval", revision: 2 },
    });
  });

  test("normalizes duplicate email failures and redacts repository details", async () => {
    const { harness, service } = createHarness();
    seedAccount(harness, "pending", { email: "person@example.com" });
    const before = structuredClone(harness.state);

    const error = await captureError(
      service.register(
        {
          email: "  Person@Example.COM ",
          displayName: "Duplicate",
          password: "not persisted",
        },
        REQUEST_CONTEXT,
      ),
    );

    expectDomainError(error, "registration_not_available");
    expect(harness.state).toEqual(before);
    expect(harness.transactionCount).toBe(1);
  }, 20_000);

  test.each([
    [
      "storage failure",
      {
        code: "storage_unavailable",
        message: "connection failed for person@example.com",
        detail: "postgres://admin:secret@database/apollo",
      },
    ],
    [
      "unknown failure",
      new Error("SQLSTATE XX000 digest ddddd at person@example.com"),
    ],
  ])(
    "maps %s to a redacted policy error",
    async (_name, failure) => {
      const { harness, service } = createHarness();
      harness.failOperation = {
        name: "lockRegistrationSettings",
        error: failure,
      };

      const error = await captureError(
        service.register(
          {
            email: "person@example.com",
            displayName: "Person",
            password: "password",
          },
          REQUEST_CONTEXT,
        ),
      );

      expectDomainError(error, "policy_unavailable");
      expect(harness.state.accounts).toEqual([]);
      expect(harness.transactionCount).toBe(1);
    },
    20_000,
  );
});

describe("RegistrationService email verification", () => {
  test("consumes a live token, verifies email, preserves pending, and sets RLS context", async () => {
    const { harness, service } = createHarness();
    seedAccount(harness);
    seedVerificationToken(harness);
    harness.state.entitlements.push(makeEntitlement());

    const verified = await service.consumeVerificationToken(
      RAW_VERIFICATION_TOKEN,
      REQUEST_CONTEXT,
    );

    expect(verified).toMatchObject({
      id: TARGET_ACCOUNT_ID,
      status: "pending",
      emailVerifiedAt: NOW,
      activatedAt: null,
    });
    expect(harness.state.verificationTokens[0]?.consumedAt).toEqual(NOW);
    expect(harness.state.accounts[0]?.status).toBe("pending");
    expect(harness.transactionCount).toBe(1);
    expect(harness.accountContexts).toEqual([TARGET_ACCOUNT_ID]);
    expect(harness.operations).toEqual([
      "lockVerificationTokenByDigest",
      `setAccountContext:${TARGET_ACCOUNT_ID}`,
      "lockAccountById",
      "consumeVerificationToken",
      "markAccountEmailVerified",
      "insertAuditEvent",
    ]);
    expectCompleteAudit(harness.state.audits[0], {
      actorAccountId: null,
      targetType: "account",
      targetId: TARGET_ACCOUNT_ID,
      action: "account.email_verified",
      correlationId: CORRELATION_ID,
      reason: "self_service_email_verification",
      previousValue: { status: "pending", emailVerifiedAt: null },
      newValue: {
        status: "pending",
        emailVerifiedAt: NOW.toISOString(),
      },
    });
  });

  test.each([
    ["missing", null, null],
    ["consumed", new Date("2026-07-16T09:00:00.000Z"), null],
    ["expired", null, new Date("2026-07-16T10:00:00.000Z")],
    ["deleted account", null, null],
  ] as const)(
    "rejects a %s token without observable mutation",
    async (scenario, consumedAt, expiresAt) => {
      const { harness, service } = createHarness();
      if (scenario !== "missing") {
        seedAccount(
          harness,
          scenario === "deleted account" ? "deleted" : "pending",
        );
        seedVerificationToken(harness, RAW_VERIFICATION_TOKEN, {
          consumedAt,
          ...(expiresAt === null ? {} : { expiresAt }),
        });
      }
      const before = structuredClone(harness.state);

      const error = await captureError(
        service.consumeVerificationToken(
          RAW_VERIFICATION_TOKEN,
          REQUEST_CONTEXT,
        ),
      );

      expectDomainError(error, "registration_not_available");
      expect(harness.state).toEqual(before);
      expect(harness.state.audits).toEqual([]);
      expect(harness.transactionCount).toBe(1);
    },
  );
});

describe("RegistrationService activation and suspension", () => {
  test.each([
    ["non-expiring", null],
    ["future-expiring", new Date("2026-07-16T10:00:00.001Z")],
  ] as const)(
    "activates verified pending account with %s live entitlement",
    async (_name, expiresAt) => {
      const { harness, service } = createHarness();
      seedAccount(harness, "pending", { emailVerifiedAt: CREATED_AT });
      harness.state.entitlements.push(makeEntitlement({ expiresAt }));

      const activated = await service.activateAccount(
        { accountId: TARGET_ACCOUNT_ID, reason: "Approved for beta" },
        OPERATOR_CONTEXT,
      );

      expect(activated).toMatchObject({
        status: "active",
        activatedAt: NOW,
        suspendedAt: null,
        deletedAt: null,
      });
      expect(harness.transactionCount).toBe(1);
      expect(harness.accountContexts).toEqual([TARGET_ACCOUNT_ID]);
      expect(harness.operations).toEqual([
        `setAccountContext:${TARGET_ACCOUNT_ID}`,
        "lockAccountById",
        "listAccountEntitlements",
        "updateAccountStatus",
        "insertAuditEvent",
      ]);
      expectCompleteAudit(harness.state.audits[0], {
        actorAccountId: OPERATOR_ACCOUNT_ID,
        targetType: "account",
        targetId: TARGET_ACCOUNT_ID,
        action: "account.activated",
        correlationId: CORRELATION_ID,
        reason: "Approved for beta",
        previousValue: { status: "pending", activatedAt: null },
        newValue: { status: "active", activatedAt: NOW.toISOString() },
      });
    },
  );

  test.each([
    ["unverified", null, [makeEntitlement()]],
    ["missing entitlement", CREATED_AT, []],
    [
      "revoked entitlement",
      CREATED_AT,
      [makeEntitlement({ revokedAt: CREATED_AT })],
    ],
    [
      "expired entitlement",
      CREATED_AT,
      [makeEntitlement({ expiresAt: new Date(NOW) })],
    ],
  ] as const)(
    "does not activate an account with %s",
    async (_scenario, emailVerifiedAt, entitlements) => {
      const { harness, service } = createHarness();
      seedAccount(harness, "pending", { emailVerifiedAt });
      harness.state.entitlements.push(...structuredClone(entitlements));
      const before = structuredClone(harness.state);

      const error = await captureError(
        service.activateAccount(
          { accountId: TARGET_ACCOUNT_ID, reason: "Attempt approval" },
          OPERATOR_CONTEXT,
        ),
      );

      expectDomainError(error, "registration_not_available");
      expect(harness.state).toEqual(before);
      expect(harness.transactionCount).toBe(1);
    },
  );

  test.each(["active", "suspended", "deleted"] as const)(
    "never activates an account already %s",
    async (status) => {
      const { harness, service } = createHarness();
      seedAccount(harness, status, { emailVerifiedAt: CREATED_AT });
      harness.state.entitlements.push(makeEntitlement());
      const before = structuredClone(harness.state);

      const error = await captureError(
        service.activateAccount(
          { accountId: TARGET_ACCOUNT_ID, reason: "No implicit transition" },
          OPERATOR_CONTEXT,
        ),
      );

      expectDomainError(error, "registration_not_available");
      expect(harness.state).toEqual(before);
      expect(harness.transactionCount).toBe(1);
    },
  );

  test.each(["pending", "active"] as const)(
    "suspends a %s account and revokes every live session",
    async (status) => {
      const { harness, service } = createHarness();
      seedAccount(harness, status);
      const previouslyRevokedAt = new Date("2026-07-16T08:00:00.000Z");
      harness.state.sessions.push(
        makeSession(1),
        makeSession(2),
        makeSession(3, { revokedAt: previouslyRevokedAt }),
      );

      const suspended = await service.suspendAccount(
        { accountId: TARGET_ACCOUNT_ID, reason: "Security review" },
        OPERATOR_CONTEXT,
      );

      expect(suspended).toMatchObject({
        status: "suspended",
        suspendedAt: NOW,
      });
      expect(
        harness.state.sessions.map((session) => session.revokedAt),
      ).toEqual([NOW, NOW, previouslyRevokedAt]);
      expect(harness.transactionCount).toBe(1);
      expect(harness.accountContexts).toEqual([TARGET_ACCOUNT_ID]);
      expect(harness.operations).toEqual([
        `setAccountContext:${TARGET_ACCOUNT_ID}`,
        "lockAccountById",
        "updateAccountStatus",
        "revokeAllSessionsForAccount",
        "insertAuditEvent",
      ]);
      expectCompleteAudit(harness.state.audits[0], {
        actorAccountId: OPERATOR_ACCOUNT_ID,
        targetType: "account",
        targetId: TARGET_ACCOUNT_ID,
        action: "account.suspended",
        correlationId: CORRELATION_ID,
        reason: "Security review",
        previousValue: { status, suspendedAt: null },
        newValue: {
          status: "suspended",
          suspendedAt: NOW.toISOString(),
          revokedSessionCount: 2,
        },
      });
    },
  );

  test.each(["suspended", "deleted"] as const)(
    "does not mutate sessions when suspension target is already %s",
    async (status) => {
      const { harness, service } = createHarness();
      seedAccount(harness, status);
      harness.state.sessions.push(makeSession(1));
      const before = structuredClone(harness.state);

      const error = await captureError(
        service.suspendAccount(
          { accountId: TARGET_ACCOUNT_ID, reason: "No repeated transition" },
          OPERATOR_CONTEXT,
        ),
      );

      expectDomainError(error, "registration_not_available");
      expect(harness.state).toEqual(before);
      expect(harness.transactionCount).toBe(1);
    },
  );
});

describe("RegistrationService validation and transaction rollback", () => {
  test.each([
    [
      "change mode",
      (service: RegistrationService) =>
        service.changeMode({ mode: "closed", reason: "   " }, OPERATOR_CONTEXT),
    ],
    [
      "activation",
      (service: RegistrationService) =>
        service.activateAccount(
          { accountId: TARGET_ACCOUNT_ID, reason: "" },
          OPERATOR_CONTEXT,
        ),
    ],
    [
      "suspension",
      (service: RegistrationService) =>
        service.suspendAccount(
          { accountId: TARGET_ACCOUNT_ID, reason: "   " },
          OPERATOR_CONTEXT,
        ),
    ],
  ])(
    "requires a non-empty operator reason before %s",
    async (_name, invoke) => {
      const { harness, service } = createHarness();

      expectDomainError(
        await captureError(invoke(service)),
        "policy_unavailable",
      );
      expect(harness.transactionCount).toBe(0);
      expect(harness.state.audits).toEqual([]);
    },
  );

  test("requires UUID correlation IDs for operator and self-service contexts", async () => {
    const operatorHarness = createHarness();
    const operatorError = await captureError(
      operatorHarness.service.changeMode(
        { mode: "closed", reason: "Close registration" },
        { ...OPERATOR_CONTEXT, correlationId: "not-a-uuid" },
      ),
    );
    expectDomainError(operatorError, "policy_unavailable");
    expect(operatorHarness.harness.transactionCount).toBe(0);

    const registrationHarness = createHarness();
    const registrationError = await captureError(
      registrationHarness.service.register(
        {
          email: "person@example.com",
          displayName: "Person",
          password: "password",
        },
        { correlationId: "not-a-uuid" },
      ),
    );
    expectDomainError(registrationError, "registration_not_available");
    expect(registrationHarness.harness.transactionCount).toBe(0);

    const verificationHarness = createHarness();
    const verificationError = await captureError(
      verificationHarness.service.consumeVerificationToken(
        RAW_VERIFICATION_TOKEN,
        { correlationId: "not-a-uuid" },
      ),
    );
    expectDomainError(verificationError, "registration_not_available");
    expect(verificationHarness.harness.transactionCount).toBe(0);
  });

  test.each([
    [
      "registration",
      (service: RegistrationService) =>
        service.register(
          {
            email: "person@example.com",
            displayName: "Person",
            password: "password",
          },
          REQUEST_CONTEXT,
        ),
    ],
    [
      "verification",
      (service: RegistrationService) =>
        service.consumeVerificationToken(
          RAW_VERIFICATION_TOKEN,
          REQUEST_CONTEXT,
        ),
    ],
    [
      "activation",
      (service: RegistrationService) =>
        service.activateAccount(
          { accountId: TARGET_ACCOUNT_ID, reason: "Approve" },
          OPERATOR_CONTEXT,
        ),
    ],
    [
      "suspension",
      (service: RegistrationService) =>
        service.suspendAccount(
          { accountId: TARGET_ACCOUNT_ID, reason: "Suspend" },
          OPERATOR_CONTEXT,
        ),
    ],
  ])(
    "maps %s clock failures to a frozen policy error",
    async (_name, invoke) => {
      const harness = new StatefulRegistrationHarness();
      const service = new RegistrationService(
        FAKE_POOL,
        harness,
        () => {
          throw new Error(
            "clock connection failed for person@example.com at postgres://admin:secret",
          );
        },
        harness.transaction,
      );

      expectDomainError(
        await captureError(invoke(service)),
        "policy_unavailable",
      );
      expect(harness.transactionCount).toBe(0);
    },
    20_000,
  );

  const rollbackCases: readonly {
    readonly name: string;
    readonly arrange: (harness: StatefulRegistrationHarness) => void;
    readonly invoke: (service: RegistrationService) => Promise<unknown>;
  }[] = [
    {
      name: "registration mode",
      arrange: () => undefined,
      invoke: (service) =>
        service.changeMode(
          { mode: "closed", reason: "Emergency closure" },
          OPERATOR_CONTEXT,
        ),
    },
    {
      name: "new account, credential, and token",
      arrange: () => undefined,
      invoke: (service) =>
        service.register(
          {
            email: "new@example.com",
            displayName: "New Account",
            password: "password",
          },
          REQUEST_CONTEXT,
        ),
    },
    {
      name: "verification consumption and account verification",
      arrange: (harness) => {
        seedAccount(harness);
        seedVerificationToken(harness);
      },
      invoke: (service) =>
        service.consumeVerificationToken(
          RAW_VERIFICATION_TOKEN,
          REQUEST_CONTEXT,
        ),
    },
    {
      name: "account activation",
      arrange: (harness) => {
        seedAccount(harness, "pending", { emailVerifiedAt: CREATED_AT });
        harness.state.entitlements.push(makeEntitlement());
      },
      invoke: (service) =>
        service.activateAccount(
          { accountId: TARGET_ACCOUNT_ID, reason: "Approve" },
          OPERATOR_CONTEXT,
        ),
    },
    {
      name: "account suspension and session revocation",
      arrange: (harness) => {
        seedAccount(harness, "active");
        harness.state.sessions.push(makeSession(1), makeSession(2));
      },
      invoke: (service) =>
        service.suspendAccount(
          { accountId: TARGET_ACCOUNT_ID, reason: "Suspend" },
          OPERATOR_CONTEXT,
        ),
    },
  ];

  test.each(rollbackCases)(
    "audit failure rolls back $name in its single transaction",
    async ({ arrange, invoke }) => {
      const { harness, service } = createHarness();
      arrange(harness);
      const before = structuredClone(harness.state);
      harness.failAudit = true;

      const error = await captureError(invoke(service));

      expectDomainError(error, "policy_unavailable");
      expect(harness.state).toEqual(before);
      expect(harness.transactionCount).toBe(1);
      expect(harness.operations.at(-1)).toBe("insertAuditEvent");
    },
    20_000,
  );
});
