import type { Pool, PoolClient } from "pg";
import { describe, expect, test } from "vitest";

import type { RegistrationMode } from "@workspace/platform-contract";

import { PlatformDomainError } from "./errors.js";
import { InvitationService, type PlatformTransaction } from "./invitations.js";
import type {
  Account,
  AccountEntitlement,
  AuditEvent,
  Credential,
  Invitation,
  InvitationGrant,
  PlatformModule,
  PlatformRepository,
  RegistrationSettings,
  VerificationToken,
} from "./repository.js";
import { digestOpaqueToken } from "./security.js";

const NOW = new Date("2026-07-16T10:00:00.000Z");
const CREATED_AT = new Date("2026-07-15T10:00:00.000Z");
const EXPIRES_AT = new Date("2026-07-17T10:00:00.000Z");
const SETTINGS_ID = "00000000-0000-4000-8000-000000000001";
const INVITATION_ID = "00000000-0000-4000-8000-000000000002";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000003";
const OPERATOR_ACCOUNT_ID = "00000000-0000-4000-8000-000000000099";
const CORRELATION_ID = "00000000-0000-4000-8000-000000000100";
const RAW_INVITATION_TOKEN = " invitation-token-secret ";
const FAKE_POOL = {} as Pool;

const OPERATOR = Object.freeze({
  accountId: OPERATOR_ACCOUNT_ID,
  correlationId: CORRELATION_ID,
});
const REQUEST_CONTEXT = Object.freeze({ correlationId: CORRELATION_ID });

interface StoredInvitation extends Invitation {
  readonly tokenDigest: string;
}

interface StoredVerificationToken extends VerificationToken {
  readonly tokenDigest: string;
}

interface InvitationState {
  settings: RegistrationSettings;
  invitations: StoredInvitation[];
  grants: InvitationGrant[];
  accounts: Account[];
  credentials: Credential[];
  verificationTokens: StoredVerificationToken[];
  entitlements: AccountEntitlement[];
  audits: AuditEvent[];
}

function uuid(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

function makeModule(
  sequence: number,
  moduleKey: string,
  state: PlatformModule["state"] = "active",
): PlatformModule {
  return {
    id: uuid(200 + sequence),
    moduleKey,
    product: "trackfinder",
    displayName: moduleKey,
    state,
    description: `${moduleKey} module`,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

const MODULES = [
  makeModule(1, "tf.search"),
  makeModule(2, "tf.collections"),
  makeModule(3, "tf.downloads", "disabled"),
] as const;

function makeSettings(mode: RegistrationMode): RegistrationSettings {
  return {
    id: SETTINGS_ID,
    mode,
    revision: 1,
    updatedByAccountId: null,
    updatedAt: CREATED_AT,
    operatorBootstrapAccountId: null,
    operatorBootstrapCompletedAt: null,
  };
}

class InvitationHarness implements PlatformRepository {
  state: InvitationState;
  transactionCount = 0;
  readonly operations: string[] = [];
  readonly accountContexts: string[] = [];
  failAudit = false;
  failOperation: string | null = null;
  onInvitationLock: (() => void) | null = null;

  constructor(mode: RegistrationMode = "invite_only") {
    this.state = {
      settings: makeSettings(mode),
      invitations: [],
      grants: [],
      accounts: [],
      credentials: [],
      verificationTokens: [],
      entitlements: [],
      audits: [],
    };
  }

  readonly clock = (): Date => {
    this.operations.push("clock");
    return new Date(NOW);
  };

  readonly transaction: PlatformTransaction = async <T>(
    _pool: Pool,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> => {
    this.transactionCount += 1;
    const snapshot = structuredClone(this.state);
    const client = {
      query: async (sql: string, values?: readonly unknown[]) => {
        if (!sql.includes("set_config('app.account_id'")) {
          throw new Error(`Unexpected client query: ${sql}`);
        }
        const accountId = values?.[0];
        if (typeof accountId !== "string") {
          throw new Error("Missing account context");
        }
        this.accountContexts.push(accountId);
        this.operations.push("setAccountContext");
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;

    try {
      return await callback(client);
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  };

  private record(operation: string): void {
    this.operations.push(operation);
    if (this.failOperation === operation) {
      throw new Error(`Injected ${operation} failure`);
    }
  }

  private unsupported(operation: string): never {
    throw new Error(`Unexpected repository operation: ${operation}`);
  }

  getRegistrationSettings: PlatformRepository["getRegistrationSettings"] =
    async () => this.unsupported("getRegistrationSettings");

  lockRegistrationSettings: PlatformRepository["lockRegistrationSettings"] =
    async () => {
      this.record("lockRegistrationSettings");
      return this.state.settings;
    };

  updateRegistrationSettings: PlatformRepository["updateRegistrationSettings"] =
    async () => this.unsupported("updateRegistrationSettings");

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
      this.state.accounts.some(({ email }) => email === input.normalizedEmail)
    ) {
      throw { code: "conflict" };
    }
    const account: Account = {
      id: ACCOUNT_ID,
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

  lockAccountById: PlatformRepository["lockAccountById"] = async () =>
    this.unsupported("lockAccountById");

  updateAccountStatus: PlatformRepository["updateAccountStatus"] = async () =>
    this.unsupported("updateAccountStatus");

  markAccountEmailVerified: PlatformRepository["markAccountEmailVerified"] =
    async () => this.unsupported("markAccountEmailVerified");

  createCredential: PlatformRepository["createCredential"] = async (
    _client,
    input,
  ) => {
    this.record("createCredential");
    const credential: Credential = {
      ...input,
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
      this.record("createVerificationToken");
      const token: StoredVerificationToken = {
        id: uuid(300 + this.state.verificationTokens.length),
        accountId: input.accountId,
        tokenDigest: input.tokenDigest,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: NOW,
      };
      this.state.verificationTokens.push(token);
      return token;
    };

  lockVerificationTokenByDigest: PlatformRepository["lockVerificationTokenByDigest"] =
    async () => this.unsupported("lockVerificationTokenByDigest");

  consumeVerificationToken: PlatformRepository["consumeVerificationToken"] =
    async () => this.unsupported("consumeVerificationToken");

  createInvitation: PlatformRepository["createInvitation"] = async (
    _client,
    input,
  ) => {
    this.record("createInvitation");
    const invitation: StoredInvitation = {
      id: INVITATION_ID,
      tokenDigest: input.tokenDigest,
      email: input.normalizedEmail,
      expiresAt: input.expiresAt,
      usesLimit: input.usesLimit,
      usesCount: 0,
      revokedAt: null,
      createdByAccountId: input.createdByAccountId,
      reason: input.reason,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.state.invitations.push(invitation);
    return invitation;
  };

  lockInvitationByDigest: PlatformRepository["lockInvitationByDigest"] = async (
    _client,
    tokenDigest,
  ) => {
    this.record("lockInvitationByDigest");
    this.onInvitationLock?.();
    return (
      this.state.invitations.find(
        (invitation) => invitation.tokenDigest === tokenDigest,
      ) ?? null
    );
  };

  addInvitationGrants: PlatformRepository["addInvitationGrants"] = async (
    _client,
    input,
  ) => {
    this.record("addInvitationGrants");
    for (const moduleId of input.moduleIds) {
      const module = MODULES.find((candidate) => candidate.id === moduleId);
      if (module === undefined) {
        throw new Error("Missing module in harness");
      }
      this.state.grants.push({
        invitationId: input.invitationId,
        moduleId,
        moduleKey: module.moduleKey,
      });
    }
  };

  listInvitationGrants: PlatformRepository["listInvitationGrants"] = async (
    _client,
    invitationId,
  ) => {
    this.record("listInvitationGrants");
    return this.state.grants.filter(
      (grant) => grant.invitationId === invitationId,
    );
  };

  incrementInvitationUse: PlatformRepository["incrementInvitationUse"] = async (
    _client,
    input,
  ) => {
    this.record("incrementInvitationUse");
    const index = this.state.invitations.findIndex(
      ({ id }) => id === input.invitationId,
    );
    const invitation = this.state.invitations[index];
    if (
      invitation === undefined ||
      invitation.usesCount >= invitation.usesLimit
    ) {
      return null;
    }
    const updated = {
      ...invitation,
      usesCount: invitation.usesCount + 1,
      updatedAt: input.usedAt,
    };
    this.state.invitations[index] = updated;
    return updated;
  };

  revokeInvitation: PlatformRepository["revokeInvitation"] = async (
    _client,
    input,
  ) => {
    this.record("revokeInvitation");
    const index = this.state.invitations.findIndex(
      ({ id }) => id === input.invitationId,
    );
    const invitation = this.state.invitations[index];
    if (invitation === undefined || invitation.revokedAt !== null) {
      return null;
    }
    const updated = {
      ...invitation,
      revokedAt: input.revokedAt,
      updatedAt: input.revokedAt,
    };
    this.state.invitations[index] = updated;
    return updated;
  };

  findModulesByKeys: PlatformRepository["findModulesByKeys"] = async (
    _client,
    moduleKeys,
  ) => {
    this.record("findModulesByKeys");
    return MODULES.filter(({ moduleKey }) => moduleKeys.includes(moduleKey));
  };

  listAccountEntitlements: PlatformRepository["listAccountEntitlements"] =
    async () => this.unsupported("listAccountEntitlements");

  upsertAccountEntitlement: PlatformRepository["upsertAccountEntitlement"] =
    async (_client, input) => {
      this.record("upsertAccountEntitlement");
      const module = MODULES.find(({ id }) => id === input.moduleId);
      if (module === undefined) {
        throw new Error("Missing entitlement module in harness");
      }
      const entitlement: AccountEntitlement = {
        id: uuid(400 + this.state.entitlements.length),
        accountId: input.accountId,
        moduleId: input.moduleId,
        moduleKey: module.moduleKey,
        expiresAt: input.expiresAt,
        revokedAt: null,
        source: input.source,
        grantedByAccountId: input.grantedByAccountId,
        reason: input.reason,
        createdAt: NOW,
        updatedAt: NOW,
      };
      this.state.entitlements.push(entitlement);
      return entitlement;
    };

  revokeAccountEntitlement: PlatformRepository["revokeAccountEntitlement"] =
    async () => this.unsupported("revokeAccountEntitlement");

  listOperatorCapabilities: PlatformRepository["listOperatorCapabilities"] =
    async () => this.unsupported("listOperatorCapabilities");

  insertOperatorCapabilities: PlatformRepository["insertOperatorCapabilities"] =
    async () => this.unsupported("insertOperatorCapabilities");

  createSession: PlatformRepository["createSession"] = async () =>
    this.unsupported("createSession");

  findSessionByDigest: PlatformRepository["findSessionByDigest"] = async () =>
    this.unsupported("findSessionByDigest");

  lockSessionByDigest: PlatformRepository["lockSessionByDigest"] = async () =>
    this.unsupported("lockSessionByDigest");

  findSessionById: PlatformRepository["findSessionById"] = async () =>
    this.unsupported("findSessionById");

  listSessionsForAccount: PlatformRepository["listSessionsForAccount"] =
    async () => this.unsupported("listSessionsForAccount");

  revokeSession: PlatformRepository["revokeSession"] = async () =>
    this.unsupported("revokeSession");

  revokeSessionsForAccountByAudience: PlatformRepository["revokeSessionsForAccountByAudience"] =
    async () => this.unsupported("revokeSessionsForAccountByAudience");

  revokeAllSessionsForAccount: PlatformRepository["revokeAllSessionsForAccount"] =
    async () => this.unsupported("revokeAllSessionsForAccount");

  insertAuditEvent: PlatformRepository["insertAuditEvent"] = async (
    _client,
    input,
  ) => {
    this.record("insertAuditEvent");
    if (this.failAudit) {
      throw new Error("Audit storage failed with secret material");
    }
    const audit: AuditEvent = {
      id: uuid(500 + this.state.audits.length),
      ...input,
      occurredAt: NOW,
    };
    this.state.audits.push(audit);
    return audit;
  };
}

function createHarness(mode: RegistrationMode = "invite_only") {
  const harness = new InvitationHarness(mode);
  const service = new InvitationService(
    FAKE_POOL,
    harness,
    harness.clock,
    harness.transaction,
  );
  return { harness, service };
}

function seedInvitation(
  harness: InvitationHarness,
  overrides: Partial<StoredInvitation> = {},
): StoredInvitation {
  const invitation: StoredInvitation = {
    id: INVITATION_ID,
    tokenDigest: digestOpaqueToken(RAW_INVITATION_TOKEN),
    email: "invitee@example.com",
    expiresAt: EXPIRES_AT,
    usesLimit: 1,
    usesCount: 0,
    revokedAt: null,
    createdByAccountId: OPERATOR_ACCOUNT_ID,
    reason: "Approved beta access",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
  harness.state.invitations.push(invitation);
  harness.state.grants.push(
    {
      invitationId: invitation.id,
      moduleId: MODULES[0].id,
      moduleKey: MODULES[0].moduleKey,
    },
    {
      invitationId: invitation.id,
      moduleId: MODULES[1].id,
      moduleKey: MODULES[1].moduleKey,
    },
  );
  return invitation;
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
  code:
    | "invitation_not_available"
    | "module_access_denied"
    | "policy_unavailable",
): void {
  expect(error).toBeInstanceOf(PlatformDomainError);
  if (!(error instanceof PlatformDomainError)) {
    throw new Error("Expected PlatformDomainError");
  }
  expect(error.code).toBe(code);
  expect(Object.isFrozen(error)).toBe(true);
  expect(JSON.stringify(error)).not.toContain(RAW_INVITATION_TOKEN);
  expect("cause" in error).toBe(false);
}

function expectAuditRedacted(audit: AuditEvent | undefined): void {
  expect(audit).toBeDefined();
  const serialized = JSON.stringify(audit).toLowerCase();
  for (const secret of [
    RAW_INVITATION_TOKEN.trim().toLowerCase(),
    digestOpaqueToken(RAW_INVITATION_TOKEN),
    "invitee@example.com",
    "$argon2",
    "verification",
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

describe("InvitationService create and inspect", () => {
  test("creates an atomic invitation while persisting only its digest", async () => {
    const { harness, service } = createHarness();

    const result = await service.create(
      {
        email: " Invitee@Example.COM ",
        expiresAt: EXPIRES_AT.toISOString(),
        usesLimit: 2,
        moduleKeys: ["tf.search", "tf.collections"],
        reason: " Approved beta access ",
      },
      OPERATOR,
    );

    expect(result.rawToken).toBeTypeOf("string");
    expect(Buffer.from(result.rawToken, "base64url")).toHaveLength(32);
    expect(result.invitation).toEqual({
      id: INVITATION_ID,
      expiresAt: EXPIRES_AT,
      usesLimit: 2,
      usesRemaining: 2,
      emailBound: true,
      moduleKeys: ["tf.collections", "tf.search"],
    });
    expect(harness.state.invitations[0]).toMatchObject({
      tokenDigest: digestOpaqueToken(result.rawToken),
      email: "invitee@example.com",
      reason: "Approved beta access",
    });
    expect(JSON.stringify(harness.state)).not.toContain(result.rawToken);
    expect(harness.operations).toEqual([
      "findModulesByKeys",
      "clock",
      "createInvitation",
      "addInvitationGrants",
      "insertAuditEvent",
    ]);
    expect(harness.state.audits[0]).toMatchObject({
      actorAccountId: OPERATOR_ACCOUNT_ID,
      action: "invitation.created",
      correlationId: CORRELATION_ID,
      reason: "Approved beta access",
      previousValue: null,
      newValue: {
        usesLimit: 2,
        emailBound: true,
        moduleKeys: ["tf.collections", "tf.search"],
      },
    });
    expectAuditRedacted(harness.state.audits[0]);
  });

  test("maps invitation token issuance failures before opening a transaction", async () => {
    const harness = new InvitationHarness();
    const issuerFailureMessage = "CSPRNG provider exposed internal state";
    const service = new InvitationService(
      FAKE_POOL,
      harness,
      harness.clock,
      harness.transaction,
      () => {
        throw new Error(issuerFailureMessage);
      },
    );

    const error = await captureError(
      service.create(
        {
          expiresAt: EXPIRES_AT.toISOString(),
          usesLimit: 1,
          moduleKeys: ["tf.search"],
          reason: "Issuer failure",
        },
        OPERATOR,
      ),
    );

    expectDomainError(error, "policy_unavailable");
    expect((error as Error).message).not.toContain(issuerFailureMessage);
    expect(harness.transactionCount).toBe(0);
    expect(harness.operations).toEqual([]);
    expect(harness.state.invitations).toEqual([]);
    expect(harness.state.grants).toEqual([]);
    expect(harness.state.audits).toEqual([]);
  });

  test.each([
    ["unknown", ["tf.search", "tf.unknown"]],
    ["disabled", ["tf.downloads"]],
    ["duplicate after normalization", ["tf.search", " TF.SEARCH "]],
  ])("rejects %s module grants", async (_scenario, moduleKeys) => {
    const { harness, service } = createHarness();

    const error = await captureError(
      service.create(
        {
          expiresAt: EXPIRES_AT.toISOString(),
          usesLimit: 1,
          moduleKeys,
          reason: "Grant modules",
        },
        OPERATOR,
      ),
    );

    expectDomainError(error, "module_access_denied");
    expect(harness.state.invitations).toEqual([]);
    expect(harness.state.audits).toEqual([]);
  });

  test("reads the expiry decision clock inside the transaction", async () => {
    const { harness, service } = createHarness();

    const error = await captureError(
      service.create(
        {
          expiresAt: NOW.toISOString(),
          usesLimit: 1,
          moduleKeys: ["tf.search"],
          reason: "Already expired",
        },
        OPERATOR,
      ),
    );

    expectDomainError(error, "policy_unavailable");
    expect(harness.transactionCount).toBe(1);
    expect(harness.state.invitations).toEqual([]);
    expect(harness.state.audits).toEqual([]);
  });

  test("inspects an available invitation using exact token bytes and normalized email", async () => {
    const { harness, service } = createHarness();
    seedInvitation(harness, { usesLimit: 3, usesCount: 1 });

    const metadata = await service.inspect(
      RAW_INVITATION_TOKEN,
      " INVITEE@example.COM ",
    );

    expect(metadata).toEqual({
      id: INVITATION_ID,
      expiresAt: EXPIRES_AT,
      usesLimit: 3,
      usesRemaining: 2,
      emailBound: true,
      moduleKeys: ["tf.collections", "tf.search"],
    });
    expect(harness.operations).toEqual([
      "lockRegistrationSettings",
      "lockInvitationByDigest",
      "clock",
      "listInvitationGrants",
    ]);
    expect(harness.state.audits).toEqual([]);

    expectDomainError(
      await captureError(
        service.inspect(RAW_INVITATION_TOKEN.trim(), "invitee@example.com"),
      ),
      "invitation_not_available",
    );
  });

  test.each([
    ["wrong mode", { mode: "closed" as const }],
    ["expired", { expiresAt: NOW }],
    ["revoked", { revokedAt: CREATED_AT }],
    ["exhausted", { usesCount: 1 }],
    ["wrong email", { email: "other@example.com" }],
  ])("conceals an invitation that is %s", async (_scenario, change) => {
    const { harness, service } = createHarness();
    const invitationChange: Partial<StoredInvitation> =
      "mode" in change ? {} : change;
    seedInvitation(harness, invitationChange);
    if ("mode" in change) {
      harness.state.settings = makeSettings(change.mode);
    }

    const error = await captureError(
      service.inspect(RAW_INVITATION_TOKEN, "invitee@example.com"),
    );

    expectDomainError(error, "invitation_not_available");
    expect(harness.state.audits).toEqual([]);
  });
});

describe("InvitationService redeem and revoke", () => {
  test("redeems atomically and copies every initial grant", async () => {
    const { harness, service } = createHarness();
    seedInvitation(harness);

    const result = await service.redeem(
      {
        invitationToken: RAW_INVITATION_TOKEN,
        email: " Invitee@Example.COM ",
        displayName: " Invitee ",
        password: "correct horse battery staple",
      },
      REQUEST_CONTEXT,
    );

    expect(result.account).toMatchObject({
      id: ACCOUNT_ID,
      email: "invitee@example.com",
      displayName: "Invitee",
      status: "pending",
    });
    expect(result.verificationToken).toBeTypeOf("string");
    expect(harness.state.credentials).toHaveLength(1);
    expect(harness.state.credentials[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      passwordChangedAt: NOW,
    });
    expect(harness.state.verificationTokens).toHaveLength(1);
    expect(harness.state.verificationTokens[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      tokenDigest: digestOpaqueToken(result.verificationToken),
      expiresAt: new Date("2026-07-17T10:00:00.000Z"),
    });
    expect(harness.state.invitations[0]?.usesCount).toBe(1);
    expect(harness.state.entitlements).toEqual([
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        moduleKey: "tf.search",
        expiresAt: null,
        source: "invitation",
        grantedByAccountId: OPERATOR_ACCOUNT_ID,
        reason: "invitation_initial_grant",
      }),
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        moduleKey: "tf.collections",
        expiresAt: null,
        source: "invitation",
        grantedByAccountId: OPERATOR_ACCOUNT_ID,
        reason: "invitation_initial_grant",
      }),
    ]);
    expect(harness.accountContexts).toEqual([ACCOUNT_ID]);
    expect(harness.state.audits[0]).toMatchObject({
      actorAccountId: null,
      targetType: "invitation",
      targetId: INVITATION_ID,
      action: "invitation.redeemed",
      correlationId: CORRELATION_ID,
      reason: "invitation_redemption",
      previousValue: { usesCount: 0, usesRemaining: 1 },
      newValue: {
        accountId: ACCOUNT_ID,
        status: "pending",
        usesCount: 1,
        usesRemaining: 0,
        moduleKeys: ["tf.collections", "tf.search"],
      },
    });
    expectAuditRedacted(harness.state.audits[0]);
  }, 20_000);

  test("conceals duplicate account email and rolls back every row", async () => {
    const { harness, service } = createHarness();
    seedInvitation(harness);
    harness.state.accounts.push({
      id: uuid(88),
      email: "invitee@example.com",
      displayName: "Existing",
      status: "active",
      emailVerifiedAt: CREATED_AT,
      activatedAt: CREATED_AT,
      suspendedAt: null,
      deletedAt: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    const before = structuredClone(harness.state);

    const error = await captureError(
      service.redeem(
        {
          invitationToken: RAW_INVITATION_TOKEN,
          email: "invitee@example.com",
          displayName: "Duplicate",
          password: "password",
        },
        REQUEST_CONTEXT,
      ),
    );

    expectDomainError(error, "invitation_not_available");
    expect(harness.state).toEqual(before);
  }, 20_000);

  test("atomically revokes once and writes no audit for repeated or unknown revocation", async () => {
    const { harness, service } = createHarness();
    seedInvitation(harness);

    const revoked = await service.revoke(
      { invitationId: INVITATION_ID, reason: " Access withdrawn " },
      OPERATOR,
    );

    expect(revoked).toEqual({
      id: INVITATION_ID,
      expiresAt: EXPIRES_AT,
      usesLimit: 1,
      usesRemaining: 1,
      emailBound: true,
      moduleKeys: ["tf.collections", "tf.search"],
    });
    expect(harness.state.invitations[0]?.revokedAt).toEqual(NOW);
    expect(harness.state.audits).toHaveLength(1);
    expect(harness.state.audits[0]).toMatchObject({
      actorAccountId: OPERATOR_ACCOUNT_ID,
      action: "invitation.revoked",
      reason: "Access withdrawn",
      previousValue: { revokedAt: null },
      newValue: { revokedAt: NOW.toISOString() },
    });
    expectAuditRedacted(harness.state.audits[0]);

    for (const invitationId of [INVITATION_ID, uuid(999)]) {
      expectDomainError(
        await captureError(
          service.revoke(
            { invitationId, reason: "Repeated withdrawal" },
            OPERATOR,
          ),
        ),
        "invitation_not_available",
      );
    }
    expect(harness.state.audits).toHaveLength(1);
  });

  test.each(["create", "redeem", "revoke"] as const)(
    "rolls back %s domain rows when the audit append fails",
    async (operation) => {
      const { harness, service } = createHarness();
      if (operation !== "create") {
        seedInvitation(harness);
      }
      const before = structuredClone(harness.state);
      harness.failAudit = true;

      const error = await captureError(
        operation === "create"
          ? service.create(
              {
                expiresAt: EXPIRES_AT.toISOString(),
                usesLimit: 1,
                moduleKeys: ["tf.search"],
                reason: "Create",
              },
              OPERATOR,
            )
          : operation === "redeem"
            ? service.redeem(
                {
                  invitationToken: RAW_INVITATION_TOKEN,
                  email: "invitee@example.com",
                  displayName: "Invitee",
                  password: "password",
                },
                REQUEST_CONTEXT,
              )
            : service.revoke(
                { invitationId: INVITATION_ID, reason: "Revoke" },
                OPERATOR,
              ),
      );

      expectDomainError(error, "policy_unavailable");
      expect(harness.state).toEqual(before);
      expect(harness.operations.at(-1)).toBe("insertAuditEvent");
    },
    20_000,
  );

  test("rejects malformed input and contexts before mutation", async () => {
    const { harness, service } = createHarness();
    seedInvitation(harness);

    expectDomainError(
      await captureError(
        service.redeem(
          {
            invitationToken: "",
            email: "invitee@example.com",
            displayName: "Invitee",
            password: "password",
          },
          REQUEST_CONTEXT,
        ),
      ),
      "invitation_not_available",
    );
    expectDomainError(
      await captureError(
        service.revoke({ invitationId: INVITATION_ID, reason: " " }, OPERATOR),
      ),
      "policy_unavailable",
    );
    expectDomainError(
      await captureError(
        service.create(
          {
            expiresAt: EXPIRES_AT.toISOString(),
            usesLimit: 1,
            moduleKeys: ["tf.search"],
            reason: "Create",
          },
          { ...OPERATOR, correlationId: "bad" },
        ),
      ),
      "policy_unavailable",
    );
    expect(harness.transactionCount).toBe(0);
  });
});
