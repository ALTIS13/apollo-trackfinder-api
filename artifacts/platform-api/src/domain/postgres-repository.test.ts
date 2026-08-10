import { readFile } from "node:fs/promises";

import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import type {
  AuthorizationBindingRepository,
  PlatformRepository,
} from "./repository.js";
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

  constructor(
    private readonly resultRows: readonly (readonly unknown[])[] = [],
  ) {}

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
const installationId = "10000000-0000-4000-8000-000000000011";
const authorizationCodeId = "10000000-0000-4000-8000-000000000012";
const now = new Date("2026-07-16T10:00:00.000Z");
const later = new Date("2026-07-17T10:00:00.000Z");

const registrationRow = {
  id: "10000000-0000-4000-8000-000000000008",
  mode: "invite_only",
  revision: "7",
  updated_by_account_id: actorAccountId,
  updated_at: now,
  operator_bootstrap_account_id: accountId,
  operator_bootstrap_completed_at: now,
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

const installationRow = {
  id: installationId,
  account_id: accountId,
  label: "Firefox on Windows",
  first_seen_at: now,
  last_seen_at: later,
  revoked_at: null,
};

const authorizationCodeRow = {
  id: authorizationCodeId,
  account_id: accountId,
  auth_session_id: sessionId,
  installation_id: installationId,
  code_digest: "d".repeat(64),
  state_digest: "e".repeat(64),
  client_id: "apollo-desktop",
  redirect_uri: "https://client.example/callback",
  pkce_challenge: "pkce-challenge",
  pkce_method: "S256",
  nonce: "nonce",
  expires_at: later,
  consumed_at: null,
  created_at: now,
};

const credentialRow = {
  account_id: accountId,
  password_hash: "$argon2id$v=19$m=65536,t=3,p=4$hash",
  password_changed_at: now,
  created_at: now,
  updated_at: now,
};

const invitationGrantRow = {
  invitation_id: invitationId,
  module_id: moduleId,
  module_key: "tf.search",
};

const moduleRow = {
  id: moduleId,
  module_key: "tf.search",
  product: "trackfinder",
  display_name: "Search",
  state: "active",
  description: "Search and playback metadata",
  created_at: now,
  updated_at: now,
};

const entitlementRow = {
  id: "10000000-0000-4000-8000-000000000009",
  account_id: accountId,
  module_id: moduleId,
  module_key: "tf.search",
  module_state: "active",
  expires_at: later,
  revoked_at: null,
  source: "invitation",
  granted_by_account_id: actorAccountId,
  reason: "module grant",
  created_at: now,
  updated_at: now,
};

const auditRow = {
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
};

function expectQuery(
  client: RecordingClient,
  index: number,
  sql: RegExp,
  values: readonly unknown[],
): void {
  const query = client.queries[index];
  expect(query, `query ${index}`).toBeDefined();
  expect(query!.text).toMatch(sql);
  expect(query!.values).toEqual(values);
}

describe("PostgresPlatformRepository", () => {
  it("projects module state with every entitlement read and mutation", async () => {
    const client = new RecordingClient([[entitlementRow]]);
    const repository = new PostgresPlatformRepository();

    await expect(
      repository.listAccountEntitlements(asPoolClient(client), accountId),
    ).resolves.toEqual([
      expect.objectContaining({
        moduleKey: "tf.search",
        moduleState: "active",
      }),
    ]);
    expect(client.queries[0]?.text).toMatch(
      /module\.state\s+as\s+module_state/i,
    );
  });

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
      "insertOperatorCapabilities",
      "createSession",
      "findSessionByDigest",
      "lockSessionByDigest",
      "findSessionById",
      "listSessionsForAccount",
      "revokeSession",
      "revokeSessionsForAccountByAudience",
      "revokeAllSessionsForAccount",
      "insertAuditEvent",
    ];

    for (const methodName of methodNames) {
      expect(repository[methodName], methodName).toBeTypeOf("function");
    }
  });

  it("implements the authorization binding repository boundary", () => {
    const repository: AuthorizationBindingRepository =
      new PostgresPlatformRepository();
    const methodNames: readonly (keyof AuthorizationBindingRepository)[] = [
      "upsertClientInstallation",
      "lockClientInstallation",
      "lockSessionById",
      "createAuthorizationCode",
      "lockAuthorizationCodeByDigest",
      "consumeAuthorizationCode",
    ];

    for (const methodName of methodNames) {
      expect(repository[methodName], methodName).toBeTypeOf("function");
    }
  });

  it("persists bound authorization codes without returning raw digests", async () => {
    const client = new RecordingClient([
      [installationRow],
      [installationRow],
      [authorizationCodeRow],
      [],
      [{ account_id: null }],
      [authorizationCodeRow],
      [authorizationCodeRow],
    ]);
    const repository = new PostgresPlatformRepository();

    await expect(
      repository.upsertClientInstallation(asPoolClient(client), {
        installationId,
        accountId,
        label: "Firefox on Windows",
        seenAt: later,
      }),
    ).resolves.toEqual({
      id: installationId,
      accountId,
      label: "Firefox on Windows",
      firstSeenAt: now,
      lastSeenAt: later,
      revokedAt: null,
    });
    await repository.lockClientInstallation(
      asPoolClient(client),
      installationId,
    );
    await expect(
      repository.createAuthorizationCode(asPoolClient(client), {
        accountId,
        authSessionId: sessionId,
        installationId,
        codeDigest: "d".repeat(64),
        stateDigest: "e".repeat(64),
        clientId: "apollo-desktop",
        redirectUri: "https://client.example/callback",
        pkceChallenge: "pkce-challenge",
        nonce: "nonce",
        expiresAt: later,
      }),
    ).resolves.toEqual({
      id: authorizationCodeId,
      accountId,
      authSessionId: sessionId,
      installationId,
      clientId: "apollo-desktop",
      redirectUri: "https://client.example/callback",
      pkceChallenge: "pkce-challenge",
      pkceMethod: "S256",
      nonce: "nonce",
      expiresAt: later,
      consumedAt: null,
      createdAt: now,
    });
    await repository.lockAuthorizationCodeByDigest(
      asPoolClient(client),
      "d".repeat(64),
    );
    await repository.consumeAuthorizationCode(asPoolClient(client), {
      authorizationCodeId,
      consumedAt: now,
    });

    expectQuery(
      client,
      0,
      /insert into apollo_platform\.client_installations[\s\S]*on conflict \(id, account_id\)[\s\S]*set label = excluded\.label,[\s\S]*last_seen_at = excluded\.last_seen_at/i,
      [installationId, accountId, "Firefox on Windows", later],
    );
    const installationConflictClause =
      client.queries[0]!.text.split(/on conflict/i)[1];
    expect(installationConflictClause).toBeDefined();
    expect(installationConflictClause).not.toMatch(
      /revoked_at\s*=|first_seen_at\s*=/i,
    );
    expectQuery(
      client,
      1,
      /from apollo_platform\.client_installations[\s\S]*where id = \$1[\s\S]*for update$/i,
      [installationId],
    );
    expectQuery(
      client,
      2,
      /insert into apollo_platform\.authorization_codes/i,
      [
        accountId,
        sessionId,
        installationId,
        "d".repeat(64),
        "e".repeat(64),
        "apollo-desktop",
        "https://client.example/callback",
        "pkce-challenge",
        "nonce",
        later,
      ],
    );
    expectQuery(
      client,
      3,
      /select set_config\('app\.authorization_code_digest', \$1, true\)/i,
      ["d".repeat(64)],
    );
    expectQuery(
      client,
      4,
      /select nullif\(current_setting\('app\.account_id', true\), ''\)[\s\S]*as account_id/i,
      [],
    );
    expectQuery(
      client,
      5,
      /from apollo_platform\.authorization_codes[\s\S]*where code_digest = \$1$/i,
      ["d".repeat(64)],
    );
    expect(client.queries[5]!.text).not.toMatch(/for update/i);
    expectQuery(
      client,
      6,
      /update apollo_platform\.authorization_codes[\s\S]*where id = \$1 and consumed_at is null and expires_at > \$2/i,
      [authorizationCodeId, now],
    );
  });

  it("rejects malformed timestamps from authorization-code rows", async () => {
    const client = new RecordingClient([
      [],
      [{ account_id: null }],
      [{ ...authorizationCodeRow, created_at: "not-a-timestamp" }],
    ]);
    const repository = new PostgresPlatformRepository();

    await expect(
      repository.lockAuthorizationCodeByDigest(
        asPoolClient(client),
        "d".repeat(64),
      ),
    ).rejects.toThrow("Invalid repository timestamp");
  });

  it("re-locks a digest-selected authorization code under account context", async () => {
    const client = new RecordingClient([
      [],
      [{ account_id: accountId }],
      [authorizationCodeRow],
    ]);
    const repository = new PostgresPlatformRepository();

    await expect(
      repository.lockAuthorizationCodeByDigest(
        asPoolClient(client),
        "d".repeat(64),
      ),
    ).resolves.toMatchObject({ id: authorizationCodeId, accountId });
    expectQuery(
      client,
      2,
      /from apollo_platform\.authorization_codes[\s\S]*where code_digest = \$1[\s\S]*for update$/i,
      ["d".repeat(64)],
    );
  });

  it("keeps authorization repository APIs digest-only", async () => {
    const repositorySource = await readFile(
      new URL("./postgres-repository.ts", import.meta.url),
      "utf8",
    );

    expect(repositorySource).toMatch(
      /insert into apollo_platform\.authorization_codes/i,
    );
    expect(repositorySource).toMatch(/where code_digest = \$1/);
    expect(repositorySource).toMatch(/lockClause[\s\S]*for update/i);
    expect(repositorySource).not.toMatch(
      /\brawCode\b|\bcodeVerifier\b|\brawState\b/,
    );
  });

  it("passes every caller value separately from SQL text", async () => {
    const client = new RecordingClient([
      [registrationRow],
      [],
      [accountRow],
      [
        {
          account_id: accountId,
          password_hash: "$argon2id$v=19$m=65536,t=3,p=4$hash",
          password_changed_at: now,
          created_at: now,
          updated_at: now,
        },
      ],
      [verificationTokenRow],
      [invitationRow],
      [],
      [],
      [
        {
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
        },
      ],
      [sessionRow],
      [
        {
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
        },
      ],
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
      ["operator@example.com"],
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

  it("executes repository methods with their essential SQL and parameter behavior", async () => {
    const passwordHash = credentialRow.password_hash;
    const verificationDigest = "a".repeat(64);
    const invitationDigest = "b".repeat(64);
    const sessionDigest = "c".repeat(64);
    const moduleIds = [moduleId];
    const moduleKeys = ["tf.search", "tf.integrations"];
    const newValue = { status: "active" };
    const client = new RecordingClient([
      [registrationRow],
      [registrationRow],
      [registrationRow],
      [],
      [accountRow],
      [],
      [accountRow],
      [accountRow],
      [accountRow],
      [accountRow],
      [credentialRow],
      [credentialRow],
      [credentialRow],
      [verificationTokenRow],
      [],
      [verificationTokenRow],
      [verificationTokenRow],
      [invitationRow],
      [invitationRow],
      [],
      [invitationGrantRow],
      [invitationRow],
      [invitationRow],
      [moduleRow],
      [entitlementRow],
      [entitlementRow],
      [entitlementRow],
      [{ capability: "platform.accounts.manage" }],
      [sessionRow],
      [],
      [sessionRow],
      [sessionRow],
      [sessionRow],
      [{}, {}],
      [auditRow],
    ]);
    const poolClient = asPoolClient(client);
    const repository = new PostgresPlatformRepository();

    await repository.getRegistrationSettings(poolClient);
    await repository.lockRegistrationSettings(poolClient);
    await repository.updateRegistrationSettings(poolClient, {
      mode: "invite_only",
      updatedByAccountId: actorAccountId,
    });
    await repository.findAccountByNormalizedEmail(
      poolClient,
      "operator@example.com",
    );
    await repository.createAccount(poolClient, {
      normalizedEmail: "operator@example.com",
      displayName: "Apollo Operator",
    });
    await repository.lockAccountById(poolClient, accountId);
    await repository.updateAccountStatus(poolClient, {
      accountId,
      status: "suspended",
      changedAt: later,
    });
    await repository.markAccountEmailVerified(poolClient, {
      accountId,
      verifiedAt: now,
    });
    await repository.createCredential(poolClient, {
      accountId,
      passwordHash,
      passwordChangedAt: now,
    });
    await repository.findCredentialByAccountId(poolClient, accountId);
    await repository.updateCredential(poolClient, {
      accountId,
      passwordHash,
      passwordChangedAt: later,
    });
    await repository.createVerificationToken(poolClient, {
      accountId,
      tokenDigest: verificationDigest,
      expiresAt: later,
    });
    await repository.lockVerificationTokenByDigest(
      poolClient,
      verificationDigest,
    );
    await repository.consumeVerificationToken(poolClient, {
      verificationTokenId: tokenId,
      consumedAt: now,
    });
    await repository.createInvitation(poolClient, {
      tokenDigest: invitationDigest,
      normalizedEmail: "invitee@example.com",
      expiresAt: later,
      usesLimit: 3,
      createdByAccountId: actorAccountId,
      reason: "approved access",
    });
    await repository.lockInvitationByDigest(poolClient, invitationDigest);
    await repository.addInvitationGrants(poolClient, {
      invitationId,
      moduleIds,
    });
    await repository.listInvitationGrants(poolClient, invitationId);
    await repository.incrementInvitationUse(poolClient, {
      invitationId,
      usedAt: now,
    });
    await repository.revokeInvitation(poolClient, {
      invitationId,
      revokedAt: later,
    });
    await repository.findModulesByKeys(poolClient, moduleKeys);
    await repository.listAccountEntitlements(poolClient, accountId);
    await repository.upsertAccountEntitlement(poolClient, {
      accountId,
      moduleId,
      expiresAt: later,
      source: "invitation",
      grantedByAccountId: actorAccountId,
      reason: "module grant",
    });
    await repository.revokeAccountEntitlement(poolClient, {
      accountId,
      moduleId,
      revokedAt: later,
      reason: "access removed",
    });
    await repository.listOperatorCapabilities(poolClient, accountId);
    await repository.createSession(poolClient, {
      accountId,
      installationId: null,
      sessionDigest,
      audience: "apollo-operator",
      expiresAt: later,
    });
    await repository.findSessionByDigest(poolClient, sessionDigest);
    await repository.listSessionsForAccount(poolClient, accountId);
    await repository.revokeSession(poolClient, {
      sessionId,
      revokedAt: later,
    });
    const revokedSessions = await repository.revokeAllSessionsForAccount(
      poolClient,
      { accountId, revokedAt: later },
    );
    await repository.insertAuditEvent(poolClient, {
      actorAccountId,
      targetType: "account",
      targetId: accountId,
      action: "account.created",
      correlationId,
      reason: "registration approved",
      previousValue: null,
      newValue,
    });

    expect(revokedSessions).toBe(2);
    expect(client.queries).toHaveLength(35);
    expectQuery(client, 0, /from apollo_platform\.registration_settings/i, []);
    expectQuery(
      client,
      1,
      /from apollo_platform\.registration_settings[\s\S]*for update/i,
      [],
    );
    expectQuery(client, 2, /update apollo_platform\.registration_settings/i, [
      "invite_only",
      actorAccountId,
    ]);
    expectQuery(client, 3, /set_config\('app\.pre_auth_email', \$1, true\)/i, [
      "operator@example.com",
    ]);
    expectQuery(
      client,
      4,
      /from apollo_platform\.accounts[\s\S]*email = \$1/i,
      ["operator@example.com"],
    );
    expectQuery(client, 5, /set_config\('app\.pre_auth_email', \$1, true\)/i, [
      "operator@example.com",
    ]);
    expectQuery(client, 6, /insert into apollo_platform\.accounts/i, [
      "operator@example.com",
      "Apollo Operator",
    ]);
    expectQuery(
      client,
      7,
      /from apollo_platform\.accounts[\s\S]*where id = \$1[\s\S]*for update/i,
      [accountId],
    );
    expectQuery(client, 8, /update apollo_platform\.accounts/i, [
      accountId,
      "suspended",
      later,
    ]);
    expectQuery(client, 9, /email_verified_at = coalesce/i, [accountId, now]);
    expectQuery(client, 10, /insert into apollo_platform\.credentials/i, [
      accountId,
      passwordHash,
      now,
    ]);
    expectQuery(client, 11, /from apollo_platform\.credentials/i, [accountId]);
    expectQuery(client, 12, /update apollo_platform\.credentials/i, [
      accountId,
      passwordHash,
      later,
    ]);
    expectQuery(
      client,
      13,
      /insert into apollo_platform\.email_verification_tokens/i,
      [accountId, verificationDigest, later],
    );
    expectQuery(
      client,
      14,
      /set_config\('app\.verification_digest', \$1, true\)/i,
      [verificationDigest],
    );
    expectQuery(
      client,
      15,
      /from apollo_platform\.email_verification_tokens[\s\S]*token_digest = \$1[\s\S]*for update/i,
      [verificationDigest],
    );
    expectQuery(
      client,
      16,
      /update apollo_platform\.email_verification_tokens/i,
      [tokenId, now],
    );
    expectQuery(client, 17, /insert into apollo_platform\.invitations/i, [
      invitationDigest,
      "invitee@example.com",
      later,
      3,
      actorAccountId,
      "approved access",
    ]);
    expectQuery(
      client,
      18,
      /from apollo_platform\.invitations[\s\S]*token_digest = \$1[\s\S]*for update/i,
      [invitationDigest],
    );
    expectQuery(
      client,
      19,
      /insert into apollo_platform\.invitation_module_grants[\s\S]*from unnest\(\$2::uuid\[\]\) as invitation_grant\(module_id\)/i,
      [invitationId, moduleIds],
    );
    expectQuery(
      client,
      20,
      /from apollo_platform\.invitation_module_grants as invitation_grant[\s\S]*where invitation_grant\.invitation_id = \$1/i,
      [invitationId],
    );
    expectQuery(client, 21, /uses_count = uses_count \+ 1/i, [
      invitationId,
      now,
    ]);
    expectQuery(
      client,
      22,
      /update apollo_platform\.invitations[\s\S]*where id = \$1 and revoked_at is null/i,
      [invitationId, later],
    );
    expectQuery(client, 23, /from apollo_platform\.modules/i, [moduleKeys]);
    expectQuery(
      client,
      24,
      /from apollo_platform\.account_module_entitlements/i,
      [accountId],
    );
    expectQuery(
      client,
      25,
      /insert into apollo_platform\.account_module_entitlements/i,
      [
        accountId,
        moduleId,
        later,
        "invitation",
        actorAccountId,
        "module grant",
      ],
    );
    expectQuery(
      client,
      26,
      /update apollo_platform\.account_module_entitlements/i,
      [accountId, moduleId, later, "access removed"],
    );
    expectQuery(client, 27, /from apollo_platform\.operator_roles/i, [
      accountId,
    ]);
    expectQuery(client, 28, /insert into apollo_platform\.auth_sessions/i, [
      accountId,
      null,
      sessionDigest,
      "apollo-operator",
      later,
    ]);
    expectQuery(client, 29, /set_config\('app\.session_digest', \$1, true\)/i, [
      sessionDigest,
    ]);
    expectQuery(
      client,
      30,
      /from apollo_platform\.auth_sessions[\s\S]*session_digest = \$1/i,
      [sessionDigest],
    );
    expectQuery(
      client,
      31,
      /from apollo_platform\.auth_sessions[\s\S]*account_id = \$1/i,
      [accountId],
    );
    expectQuery(client, 32, /update apollo_platform\.auth_sessions/i, [
      sessionId,
      later,
    ]);
    expectQuery(
      client,
      33,
      /update apollo_platform\.auth_sessions[\s\S]*account_id = \$1/i,
      [accountId, later],
    );
    expectQuery(client, 34, /insert into apollo_platform\.audit_events/i, [
      actorAccountId,
      "account",
      accountId,
      "account.created",
      correlationId,
      "registration approved",
      null,
      newValue,
    ]);

    const allSql = client.queries.map(({ text }) => text).join("\n");
    for (const callerValue of [
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
      [],
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

    for (const queryIndex of [0, 1, 3, 4]) {
      const lockSql = client.queries[queryIndex]!.text;
      expect(lockSql.match(/\bFOR\s+UPDATE\b/gi)).toHaveLength(1);
      expect(lockSql.trim()).toMatch(/FOR\s+UPDATE$/i);
    }
    expectQuery(
      client,
      2,
      /set_config\('app\.verification_digest', \$1, true\)/i,
      ["a".repeat(64)],
    );
    expect(settings).toEqual({
      id: registrationRow.id,
      mode: "invite_only",
      revision: 7,
      updatedByAccountId: actorAccountId,
      updatedAt: now,
      operatorBootstrapAccountId: accountId,
      operatorBootstrapCompletedAt: now,
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

  it("inserts operator capabilities and scopes session lookup and rotation without secret interpolation", async () => {
    const capabilities = [
      "platform.accounts.manage",
      "platform.entitlements.manage",
    ] as const;
    const client = new RecordingClient([[], [sessionRow], []]);
    const repository = new PostgresPlatformRepository();

    await repository.insertOperatorCapabilities(asPoolClient(client), {
      accountId,
      capabilities,
      grantedByAccountId: null,
      reason: "initial operator bootstrap",
    });
    await expect(
      repository.findSessionById(asPoolClient(client), sessionId),
    ).resolves.toEqual({
      id: sessionId,
      accountId,
      installationId: null,
      audience: "apollo-operator",
      expiresAt: later,
      revokedAt: null,
      createdAt: now,
      lastSeenAt: now,
    });
    await expect(
      repository.revokeSessionsForAccountByAudience(asPoolClient(client), {
        accountId,
        audience: "apollo-admin",
        revokedAt: later,
      }),
    ).resolves.toBe(0);

    expectQuery(
      client,
      0,
      /insert into apollo_platform\.operator_roles[\s\S]*from unnest\(\$2::text\[\]\)/i,
      [accountId, capabilities, null, "initial operator bootstrap"],
    );
    expectQuery(
      client,
      1,
      /from apollo_platform\.auth_sessions[\s\S]*where id = \$1/i,
      [sessionId],
    );
    expectQuery(
      client,
      2,
      /update apollo_platform\.auth_sessions[\s\S]*account_id = \$1[\s\S]*audience = \$2[\s\S]*revoked_at is null/i,
      [accountId, "apollo-admin", later],
    );
    const allSql = client.queries.map(({ text }) => text).join("\n");
    expect(allSql).not.toContain(accountId);
    expect(allSql).not.toContain(sessionId);
    expect(allSql).not.toContain("apollo-admin");
    expect(allSql).not.toContain("initial operator bootstrap");
  });

  it("re-establishes exact digest context and locks a session by digest", async () => {
    const sessionDigest = "d".repeat(64);
    const client = new RecordingClient([[], [sessionRow]]);
    const repository = new PostgresPlatformRepository();

    await expect(
      repository.lockSessionByDigest(asPoolClient(client), sessionDigest),
    ).resolves.toEqual({
      id: sessionId,
      accountId,
      installationId: null,
      audience: "apollo-operator",
      expiresAt: later,
      revokedAt: null,
      createdAt: now,
      lastSeenAt: now,
    });

    expectQuery(client, 0, /set_config\('app\.session_digest', \$1, true\)/i, [
      sessionDigest,
    ]);
    expectQuery(
      client,
      1,
      /from apollo_platform\.auth_sessions[\s\S]*session_digest = \$1[\s\S]*for update$/i,
      [sessionDigest],
    );
    expect(client.queries[1]!.text.match(/\bFOR\s+UPDATE\b/gi)).toHaveLength(1);
    expect(client.queries.map(({ text }) => text).join("\n")).not.toContain(
      sessionDigest,
    );
  });

  it("makes entitlement and individual-session revocation conditional", async () => {
    const client = new RecordingClient([[], []]);
    const repository = new PostgresPlatformRepository();

    await repository.revokeAccountEntitlement(asPoolClient(client), {
      accountId,
      moduleId,
      revokedAt: later,
      reason: "removed",
    });
    await repository.revokeSession(asPoolClient(client), {
      sessionId,
      revokedAt: later,
    });

    expect(client.queries[0]!.text).toMatch(/entitlement\.revoked_at is null/i);
    expect(client.queries[1]!.text).toMatch(/revoked_at is null/i);
  });

  it("aggregates recent accounts from active sessions and current grants", async () => {
    const client = new RecordingClient([
      [
        {
          total: "3",
          active_now: "1",
          pending: "1",
          suspended: "1",
        },
      ],
      [
        {
          account_id: accountId,
          email: accountRow.email,
          display_name: accountRow.display_name,
          status: "active",
          latest_activity_at: now,
          active_session_count: "1",
          module_keys: ["tf.search"],
        },
      ],
    ]);
    const repository = new PostgresPlatformRepository();

    await expect(
      repository.getAdminAccountOverview(asPoolClient(client), now, 100),
    ).resolves.toEqual({
      total: 3,
      activeNow: 1,
      pending: 1,
      suspended: 1,
      accounts: [
        {
          id: accountId,
          email: accountRow.email,
          displayName: accountRow.display_name,
          status: "active",
          latestActivityAt: now,
          activeSessionCount: 1,
          moduleKeys: ["tf.search"],
        },
      ],
    });

    expect(client.queries[0]?.text).toMatch(
      /auth_sessions[\s\S]*revoked_at is null[\s\S]*expires_at > \$1[\s\S]*last_seen_at >= \$2/i,
    );
    expect(client.queries[0]?.values).toEqual([
      now,
      new Date(now.getTime() - 15 * 60 * 1_000),
    ]);
    expect(client.queries[1]?.text).toMatch(
      /array_agg\(distinct module\.module_key[\s\S]*order by latest_activity_at desc nulls last[\s\S]*limit \$3/i,
    );
    expect(client.queries[1]?.values).toEqual([
      now,
      new Date(now.getTime() - 15 * 60 * 1_000),
      100,
    ]);
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
    [
      "23505",
      "conflict",
      "The requested resource conflicts with existing data.",
    ],
    [
      "23514",
      "constraint_violation",
      "The requested operation violates a data constraint.",
    ],
    ["23503", "reference_not_found", "A referenced resource was not found."],
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
