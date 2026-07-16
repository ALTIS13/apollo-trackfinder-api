import { readFile } from "node:fs/promises";

import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import type { PlatformRepository } from "./repository.js";
import {
  PostgresPlatformRepository,
  mapRepositoryError,
} from "./postgres-repository.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

class RecordingClient {
  readonly queries: RecordedQuery[] = [];

  constructor(private readonly resultRows: readonly (readonly unknown[])[] = []) {}

  async query(text: string, values: readonly unknown[] = []) {
    const rows = this.resultRows[this.queries.length] ?? [];
    this.queries.push({ text, values });
    return {
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows,
    };
  }
}

const asPoolClient = (client: RecordingClient): PoolClient =>
  client as unknown as PoolClient;

const accountId = "10000000-0000-4000-8000-000000000001";
const actorAccountId = "10000000-0000-4000-8000-000000000002";
const invitationId = "10000000-0000-4000-8000-000000000003";
const moduleId = "10000000-0000-4000-8000-000000000004";
const sessionId = "10000000-0000-4000-8000-000000000005";
const tokenId = "10000000-0000-4000-8000-000000000006";
const correlationId = "10000000-0000-4000-8000-000000000007";
const now = new Date("2026-07-16T10:00:00.000Z");
const later = new Date("2026-07-17T10:00:00.000Z");

const registrationRow = {
  id: "10000000-0000-4000-8000-000000000008",
  mode: "invite_only",
  revision: "7",
  updated_by_account_id: actorAccountId,
  updated_at: now,
};

const accountRow = {
  id: accountId,
  email: "operator@example.com",
  display_name: "Apollo Operator",
  status: "active",
  email_verified_at: now,
  activated_at: now,
  suspended_at: null,
  deleted_at: null,
  created_at: now,
  updated_at: now,
};

const verificationTokenRow = {
  id: tokenId,
  account_id: accountId,
  token_digest: "a".repeat(64),
  expires_at: later,
  consumed_at: null,
  created_at: now,
};

const invitationRow = {
  id: invitationId,
  token_digest: "b".repeat(64),
  email: "invitee@example.com",
  expires_at: later,
  uses_limit: 3,
  uses_count: 1,
  revoked_at: null,
  created_by_account_id: actorAccountId,
  reason: "approved access",
  created_at: now,
  updated_at: now,
};

const sessionRow = {
  id: sessionId,
  account_id: accountId,
  installation_id: null,
  session_digest: "c".repeat(64),
  audience: "apollo-operator",
  expires_at: later,
  revoked_at: null,
  created_at: now,
  last_seen_at: now,
};

describe("PostgresPlatformRepository", () => {
  it("implements the complete transaction-scoped repository boundary", () => {
    const repository: PlatformRepository = new PostgresPlatformRepository();
    const methodNames: readonly (keyof PlatformRepository)[] = [
      "getRegistrationSettings",
      "lockRegistrationSettings",
      "updateRegistrationSettings",
      "findAccountByNormalizedEmail",
      "createAccount",
      "lockAccountById",
      "updateAccountStatus",
      "markAccountEmailVerified",
      "createCredential",
      "findCredentialByAccountId",
      "updateCredential",
      "createVerificationToken",
      "lockVerificationTokenByDigest",
      "consumeVerificationToken",
      "createInvitation",
      "lockInvitationByDigest",
      "addInvitationGrants",
      "listInvitationGrants",
      "incrementInvitationUse",
      "revokeInvitation",
      "findModulesByKeys",
      "listAccountEntitlements",
      "upsertAccountEntitlement",
      "revokeAccountEntitlement",
      "listOperatorCapabilities",
      "createSession",
      "findSessionByDigest",
      "listSessionsForAccount",
      "revokeSession",
      "revokeAllSessionsForAccount",
      "insertAuditEvent",
    ];

    for (const methodName of methodNames) {
      expect(repository[methodName], methodName).toBeTypeOf("function");
    }
  });

  it("passes every caller value separately from SQL text", async () => {
    const client = new RecordingClient([
      [registrationRow],
      [accountRow],
      [{
        account_id: accountId,
        password_hash: "$argon2id$v=19$m=65536,t=3,p=4$hash",
        password_changed_at: now,
        created_at: now,
        updated_at: now,
      }],
      [verificationTokenRow],
      [invitationRow],
      [],
      [],
      [{
        id: "10000000-0000-4000-8000-000000000009",
        account_id: accountId,
        module_id: moduleId,
        module_key: "tf.search",
        expires_at: later,
        revoked_at: null,
        source: "invitation",
        granted_by_account_id: actorAccountId,
        reason: "module grant",
        created_at: now,
        updated_at: now,
      }],
      [sessionRow],
      [{
        id: "10000000-0000-4000-8000-000000000010",
        actor_account_id: actorAccountId,
        target_type: "account",
        target_id: accountId,
        action: "account.created",
        correlation_id: correlationId,
        reason: "registration approved",
        previous_value: null,
        new_value: { status: "active" },
        occurred_at: now,
      }],
    ]);
    const repository = new PostgresPlatformRepository();
    const passwordHash = "$argon2id$v=19$m=65536,t=3,p=4$hash";
    const verificationDigest = "a".repeat(64);
    const invitationDigest = "b".repeat(64);
    const sessionDigest = "c".repeat(64);
    const moduleIds = [moduleId];
    const moduleKeys = ["tf.search", "tf.integrations"];
    const newValue = { status: "active" };

    await repository.updateRegistrationSettings(asPoolClient(client), {
      mode: "invite_only",
      updatedByAccountId: actorAccountId,
    });
    await repository.createAccount(asPoolClient(client), {
      normalizedEmail: "operator@example.com",
      displayName: "Apollo Operator",
    });
    await repository.createCredential(asPoolClient(client), {
      accountId,
      passwordHash,
      passwordChangedAt: now,
    });
    await repository.createVerificationToken(asPoolClient(client), {
      accountId,
      tokenDigest: verificationDigest,
      expiresAt: later,
    });
    await repository.createInvitation(asPoolClient(client), {
      tokenDigest: invitationDigest,
      normalizedEmail: "invitee@example.com",
      expiresAt: later,
      usesLimit: 3,
      createdByAccountId: actorAccountId,
      reason: "approved access",
    });
    await repository.addInvitationGrants(asPoolClient(client), {
      invitationId,
      moduleIds,
    });
    await repository.findModulesByKeys(asPoolClient(client), moduleKeys);
    await repository.upsertAccountEntitlement(asPoolClient(client), {
      accountId,
      moduleId,
      expiresAt: later,
      source: "invitation",
      grantedByAccountId: actorAccountId,
      reason: "module grant",
    });
    await repository.createSession(asPoolClient(client), {
      accountId,
      installationId: null,
      sessionDigest,
      audience: "apollo-operator",
      expiresAt: later,
    });
    await repository.insertAuditEvent(asPoolClient(client), {
      actorAccountId,
      targetType: "account",
      targetId: accountId,
      action: "account.created",
      correlationId,
      reason: "registration approved",
      previousValue: null,
      newValue,
    });

    expect(client.queries.map(({ values }) => values)).toEqual([
      ["invite_only", actorAccountId],
      ["operator@example.com", "Apollo Operator"],
      [accountId, passwordHash, now],
      [accountId, verificationDigest, later],
      [
        invitationDigest,
        "invitee@example.com",
        later,
        3,
        actorAccountId,
        "approved access",
      ],
      [invitationId, moduleIds],
      [moduleKeys],
      [
        accountId,
        moduleId,
        later,
        "invitation",
        actorAccountId,
        "module grant",
      ],
      [accountId, null, sessionDigest, "apollo-operator", later],
      [
        actorAccountId,
        "account",
        accountId,
        "account.created",
        correlationId,
        "registration approved",
        null,
        newValue,
      ],
    ]);

    const allSql = client.queries.map(({ text }) => text).join("\n");
    for (const callerValue of [
      "invite_only",
      actorAccountId,
      "operator@example.com",
      "Apollo Operator",
      passwordHash,
      verificationDigest,
      invitationDigest,
      "invitee@example.com",
      "approved access",
      invitationId,
      moduleId,
      "tf.search",
      "tf.integrations",
      sessionDigest,
      "apollo-operator",
      correlationId,
      "account.created",
      "registration approved",
    ]) {
      expect(allSql, callerValue).not.toContain(callerValue);
    }
  });

  it("uses FOR UPDATE for every lock method and maps only safe row fields", async () => {
    const hostileAccountRow = {
      ...accountRow,
      password_hash: "must-not-leak",
      token_digest: "must-not-leak",
      connection_string: "postgres://must-not-leak",
    };
    const client = new RecordingClient([
      [registrationRow],
      [hostileAccountRow],
      [verificationTokenRow],
      [invitationRow],
    ]);
    const repository = new PostgresPlatformRepository();

    const settings = await repository.lockRegistrationSettings(
      asPoolClient(client),
    );
    const account = await repository.lockAccountById(
      asPoolClient(client),
      accountId,
    );
    const verificationToken = await repository.lockVerificationTokenByDigest(
      asPoolClient(client),
      "a".repeat(64),
    );
    const invitation = await repository.lockInvitationByDigest(
      asPoolClient(client),
      "b".repeat(64),
    );

    for (const query of client.queries) {
      expect(query.text).toMatch(/\bFOR\s+UPDATE\b/i);
    }
    expect(settings).toEqual({
      id: registrationRow.id,
      mode: "invite_only",
      revision: 7,
      updatedByAccountId: actorAccountId,
      updatedAt: now,
    });
    expect(account).toEqual({
      id: accountId,
      email: "operator@example.com",
      displayName: "Apollo Operator",
      status: "active",
      emailVerifiedAt: now,
      activatedAt: now,
      suspendedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(verificationToken).toEqual({
      id: tokenId,
      accountId,
      expiresAt: later,
      consumedAt: null,
      createdAt: now,
    });
    expect(invitation).toEqual({
      id: invitationId,
      email: "invitee@example.com",
      expiresAt: later,
      usesLimit: 3,
      usesCount: 1,
      revokedAt: null,
      createdByAccountId: actorAccountId,
      reason: "approved access",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("keeps token and session repository APIs digest-only", async () => {
    const repositorySource = await readFile(
      new URL("./repository.ts", import.meta.url),
      "utf8",
    );

    expect(repositorySource).toMatch(/\btokenDigest\b/);
    expect(repositorySource).toMatch(/\bsessionDigest\b/);
    expect(repositorySource).not.toMatch(/\b(?:rawToken|password|secret)\b/);
  });

  it.each([
    ["23505", "conflict", "The requested resource conflicts with existing data."],
    [
      "23514",
      "constraint_violation",
      "The requested operation violates a data constraint.",
    ],
    [
      "23503",
      "reference_not_found",
      "A referenced resource was not found.",
    ],
    [
      "08006",
      "storage_unavailable",
      "The storage operation could not be completed.",
    ],
  ] as const)(
    "maps SQLSTATE %s to stable redacted repository errors",
    (sqlState, code, message) => {
      const mapped = mapRepositoryError({
        code: sqlState,
        message: "duplicate email operator@example.com",
        detail: `token ${"d".repeat(64)}`,
        query: "select * from apollo_platform.accounts",
        constraint: "accounts_email_key",
        connectionString: "postgres://operator:password@database/apollo",
      });

      expect(mapped).toEqual({ code, message });
      const exposed = JSON.stringify(mapped);
      expect(exposed).not.toContain("operator@example.com");
      expect(exposed).not.toContain("accounts_email_key");
      expect(exposed).not.toContain("postgres://");
      expect(exposed).not.toContain("apollo_platform");
      expect(exposed).not.toContain("d".repeat(64));
    },
  );
});
