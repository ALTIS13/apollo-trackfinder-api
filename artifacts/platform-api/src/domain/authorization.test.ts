import { createHash } from "node:crypto";

import type {
  AuthorizationCodeExchangeRequest,
  AuthorizationRequest,
  PlatformAssertionClaims,
  PolicyIntrospectionRequest,
} from "@workspace/platform-contract";
import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";

import {
  AuthorizationService,
  pkceS256,
  type AuthorizationServiceRepository,
} from "./authorization.js";
import { OAuthClientRegistry } from "./oauth-clients.js";
import type {
  PlatformAssertionSigningInput,
  SignedPlatformAssertion,
} from "./assertions.js";
import type {
  Account,
  AccountEntitlement,
  AuditEvent,
  AuthorizationCode,
  AuthSession,
  ClientInstallation,
  CreateAuthorizationCodeInput,
  InsertAuditEventInput,
  UpsertClientInstallationInput,
} from "./repository.js";
import type { PlatformTransaction } from "./registration.js";
import type { AuthenticatedUser } from "./user-sessions.js";

const now = new Date("2026-07-24T12:00:00.000Z");
const accountId = "11111111-1111-4111-8111-111111111111";
const sessionId = "20000000-0000-4000-8000-000000000002";
const installationId = "10000000-0000-4000-8000-000000000001";
const authorizationCodeId = "30000000-0000-4000-8000-000000000003";
const correlationId = "40000000-0000-4000-8000-000000000004";
const entitlementId = "50000000-0000-4000-8000-000000000005";
const moduleId = "60000000-0000-4000-8000-000000000006";
const rawCode = "c".repeat(43);
const state = "s".repeat(43);
const nonce = "n".repeat(43);
const verifier = "v".repeat(43);
const clientSecret = "client-secret-\u03c0";
const redirectUri = "https://api.tf.apollot.ru/api/auth/callback";
const clientSecretDigest = createHash("sha256")
  .update(clientSecret, "utf8")
  .digest("hex");
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const user: AuthenticatedUser = {
  accountId,
  sessionId,
  status: "active",
  emailVerified: true,
};
const authorizationRequest: AuthorizationRequest = {
  clientId: "apollo-tf-web",
  redirectUri,
  responseType: "code",
  codeChallenge: pkceS256(verifier),
  codeChallengeMethod: "S256",
  state,
  nonce,
  installationId,
  installationLabel: "Firefox on Windows",
};
const validExchange: AuthorizationCodeExchangeRequest = {
  grantType: "authorization_code",
  clientId: "apollo-tf-web",
  code: rawCode,
  codeVerifier: verifier,
  redirectUri,
};
const introspectionRequest: PolicyIntrospectionRequest = {
  accountId,
  sessionId,
  installationId,
  audience: "apollo-tf",
};

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: accountId,
    email: "active@example.test",
    displayName: "Active User",
    status: "active",
    emailVerifiedAt: new Date(now.getTime() - 60_000),
    activatedAt: new Date(now.getTime() - 60_000),
    suspendedAt: null,
    deletedAt: null,
    createdAt: new Date(now.getTime() - 120_000),
    updatedAt: new Date(now.getTime() - 60_000),
    ...overrides,
  };
}

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    id: sessionId,
    accountId,
    installationId: null,
    audience: "apollo-portal",
    expiresAt: new Date(now.getTime() + 60 * 60_000),
    revokedAt: null,
    createdAt: new Date(now.getTime() - 60_000),
    lastSeenAt: new Date(now.getTime() - 30_000),
    ...overrides,
  };
}

function installation(
  overrides: Partial<ClientInstallation> = {},
): ClientInstallation {
  return {
    id: installationId,
    accountId,
    label: "Firefox on Windows",
    firstSeenAt: new Date(now.getTime() - 60_000),
    lastSeenAt: now,
    revokedAt: null,
    ...overrides,
  };
}

function entitlement(
  overrides: Partial<AccountEntitlement> = {},
): AccountEntitlement {
  return {
    id: entitlementId,
    accountId,
    moduleId,
    moduleKey: "tf.search",
    moduleState: "active",
    expiresAt: null,
    revokedAt: null,
    source: "operator",
    grantedByAccountId: null,
    reason: "test",
    createdAt: new Date(now.getTime() - 60_000),
    updatedAt: new Date(now.getTime() - 60_000),
    ...overrides,
  };
}

function authorizationCode(
  overrides: Partial<AuthorizationCode> = {},
): AuthorizationCode {
  return {
    id: authorizationCodeId,
    accountId,
    authSessionId: sessionId,
    installationId,
    clientId: "apollo-tf-web",
    redirectUri,
    pkceChallenge: pkceS256(verifier),
    pkceMethod: "S256",
    nonce,
    expiresAt: new Date(now.getTime() + 60_000),
    consumedAt: null,
    createdAt: now,
    ...overrides,
  };
}

class FakeAuthorizationRepository implements AuthorizationServiceRepository {
  account: Account | null = account();
  session: AuthSession | null = session();
  installation: ClientInstallation | null = installation();
  code: AuthorizationCode | null = authorizationCode();
  codeDigest = digest(rawCode);
  entitlements: readonly AccountEntitlement[] = [entitlement()];
  readonly events: string[] = [];
  readonly audits: InsertAuditEventInput[] = [];
  createdCodeInput: CreateAuthorizationCodeInput | null = null;
  upsertInput: UpsertClientInstallationInput | null = null;

  async lockAccountById(
    _client: PoolClient,
    requestedAccountId: string,
  ): Promise<Account | null> {
    this.events.push("lockAccount");
    return this.account?.id === requestedAccountId ? this.account : null;
  }

  async lockSessionById(
    _client: PoolClient,
    requestedSessionId: string,
  ): Promise<AuthSession | null> {
    this.events.push("lockSession");
    return this.session?.id === requestedSessionId ? this.session : null;
  }

  async upsertClientInstallation(
    _client: PoolClient,
    input: UpsertClientInstallationInput,
  ): Promise<ClientInstallation> {
    this.events.push("upsertInstallation");
    this.upsertInput = input;
    this.installation = {
      ...installation(),
      id: input.installationId,
      accountId: input.accountId,
      label: input.label,
      lastSeenAt: input.seenAt,
    };
    return this.installation;
  }

  async lockClientInstallation(
    _client: PoolClient,
    requestedInstallationId: string,
  ): Promise<ClientInstallation | null> {
    this.events.push("lockInstallation");
    return this.installation?.id === requestedInstallationId
      ? this.installation
      : null;
  }

  async createAuthorizationCode(
    _client: PoolClient,
    input: CreateAuthorizationCodeInput,
  ): Promise<AuthorizationCode> {
    this.events.push("createCode");
    this.createdCodeInput = input;
    this.codeDigest = input.codeDigest;
    this.code = authorizationCode({
      accountId: input.accountId,
      authSessionId: input.authSessionId,
      installationId: input.installationId,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      pkceChallenge: input.pkceChallenge,
      nonce: input.nonce,
      expiresAt: input.expiresAt,
      createdAt: now,
    });
    return this.code;
  }

  async lockAuthorizationCodeByDigest(
    _client: PoolClient,
    requestedDigest: string,
  ): Promise<AuthorizationCode | null> {
    this.events.push("lockCode");
    return requestedDigest === this.codeDigest ? this.code : null;
  }

  async consumeAuthorizationCode(
    _client: PoolClient,
    input: {
      readonly authorizationCodeId: string;
      readonly consumedAt: Date;
    },
  ): Promise<AuthorizationCode | null> {
    this.events.push("consumeCode");
    if (
      this.code === null ||
      this.code.id !== input.authorizationCodeId ||
      this.code.consumedAt !== null ||
      this.code.expiresAt.getTime() <= input.consumedAt.getTime()
    ) {
      return null;
    }
    this.code = { ...this.code, consumedAt: input.consumedAt };
    return this.code;
  }

  async listAccountEntitlements(
    _client: PoolClient,
    _accountId: string,
  ): Promise<readonly AccountEntitlement[]> {
    this.events.push("listEntitlements");
    return this.entitlements;
  }

  async insertAuditEvent(
    _client: PoolClient,
    input: InsertAuditEventInput,
  ): Promise<AuditEvent> {
    this.events.push("audit");
    this.audits.push(input);
    return {
      id: "70000000-0000-4000-8000-000000000007",
      ...input,
      occurredAt: now,
    };
  }
}

class FakeSigner {
  readonly calls: PlatformAssertionSigningInput[] = [];

  constructor(private readonly events: string[]) {}

  async sign(
    input: PlatformAssertionSigningInput,
  ): Promise<SignedPlatformAssertion> {
    this.events.push("sign");
    this.calls.push(input);
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const claims: PlatformAssertionClaims = {
      iss: "https://api.apollot.ru",
      aud: input.audience,
      sub: input.accountId,
      sid: input.sessionId,
      installation_id: input.installationId,
      nonce: input.nonce,
      account_status: "active",
      entitlements: [...input.entitlements],
      jti: "80000000-0000-4000-8000-000000000008",
      iat: nowSeconds,
      nbf: nowSeconds - 5,
      exp: nowSeconds + 300,
    };
    return { assertion: "signed.assertion.secret", claims };
  }
}

function createFixture() {
  const repository = new FakeAuthorizationRepository();
  const signer = new FakeSigner(repository.events);
  const clients = OAuthClientRegistry.parse(
    [
      {
        clientId: "apollo-tf-web",
        audience: "apollo-tf",
        redirectUris: [redirectUri],
        clientSecretDigest,
      },
      {
        clientId: "other-client",
        audience: "apollo-tf",
        redirectUris: ["https://other.example/callback"],
        clientSecretDigest,
      },
    ],
    "production",
  );
  let transactionCount = 0;
  const client = {
    query: async (
      text: string,
      values: readonly unknown[] = [],
    ): Promise<QueryResult> => {
      repository.events.push(
        text.includes("app.account_id")
          ? `accountContext:${String(values[0])}`
          : "query",
      );
      return {
        command: "SELECT",
        rowCount: 0,
        oid: 0,
        fields: [],
        rows: [],
      };
    },
  } as unknown as PoolClient;
  const transaction: PlatformTransaction = async (_pool, callback) => {
    transactionCount += 1;
    return callback(client);
  };
  const service = new AuthorizationService(
    {} as Pool,
    repository,
    clients,
    signer,
    () => now,
    "apollo-tf-web",
    transaction,
  );
  return {
    repository,
    signer,
    service,
    transactions: () => transactionCount,
  };
}

describe("pkceS256", () => {
  it("hashes the exact ASCII verifier as unpadded base64url", () => {
    expect(pkceS256(verifier)).toBe(
      createHash("sha256").update(verifier, "ascii").digest("base64url"),
    );
    expect(pkceS256(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("AuthorizationService.issueCode", () => {
  it("revalidates bindings and stores only code/state digests for 60 seconds", async () => {
    const fixture = createFixture();

    const issued = await fixture.service.issueCode(user, authorizationRequest, {
      correlationId,
    });

    expect(issued).toEqual({
      rawCode: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      redirectUri,
      state,
    });
    expect(fixture.repository.createdCodeInput).toMatchObject({
      accountId,
      authSessionId: sessionId,
      installationId,
      codeDigest: digest(issued.rawCode),
      stateDigest: digest(state),
      clientId: "apollo-tf-web",
      redirectUri,
      pkceChallenge: pkceS256(verifier),
      nonce,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    expect(fixture.repository.upsertInput).toEqual({
      installationId,
      accountId,
      label: "Firefox on Windows",
      seenAt: now,
    });
    expect(fixture.repository.events).toEqual([
      `accountContext:${accountId}`,
      "lockAccount",
      "lockSession",
      "upsertInstallation",
      "lockInstallation",
      "createCode",
      "audit",
    ]);
  });

  it("requires an active authenticated user and exact registered redirect", async () => {
    const pending = createFixture();
    await expect(
      pending.service.issueCode(
        { ...user, status: "pending" },
        authorizationRequest,
        { correlationId },
      ),
    ).rejects.toMatchObject({ code: "account_access_denied" });
    expect(pending.transactions()).toBe(0);

    const redirectMismatch = createFixture();
    await expect(
      redirectMismatch.service.issueCode(
        user,
        {
          ...authorizationRequest,
          redirectUri: "https://evil.example/callback",
        },
        { correlationId },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(redirectMismatch.transactions()).toBe(0);
  });

  it.each([
    ["inactive account", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.account = account({ status: "suspended" });
    }],
    ["unverified account", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.account = account({ emailVerifiedAt: null });
    }],
    ["revoked portal session", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.session = session({ revokedAt: now });
    }],
    ["expired portal session", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.session = session({ expiresAt: now });
    }],
    ["wrong portal audience", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.session = session({ audience: "apollo-tf" });
    }],
    ["revoked installation", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.installation = installation({ revokedAt: now });
      fixture.repository.upsertClientInstallation = async () =>
        fixture.repository.installation!;
    }],
  ])("denies %s without issuing a code", async (_name, arrange) => {
    const fixture = createFixture();
    arrange(fixture);

    await expect(
      fixture.service.issueCode(user, authorizationRequest, {
        correlationId,
      }),
    ).rejects.toMatchObject({ code: "account_access_denied" });
    expect(fixture.repository.createdCodeInput).toBeNull();
    expect(fixture.repository.audits).toEqual([]);
  });

  it("maps inconsistent bindings and non-finite dates to policy_unavailable", async () => {
    const inconsistent = createFixture();
    inconsistent.repository.session = session({
      accountId: "99999999-9999-4999-8999-999999999999",
    });
    await expect(
      inconsistent.service.issueCode(user, authorizationRequest, {
        correlationId,
      }),
    ).rejects.toMatchObject({ code: "policy_unavailable" });

    const malformed = createFixture();
    malformed.repository.session = session({
      expiresAt: new Date(Number.NaN),
    });
    await expect(
      malformed.service.issueCode(user, authorizationRequest, {
        correlationId,
      }),
    ).rejects.toMatchObject({ code: "policy_unavailable" });
  });
});

describe("AuthorizationService.exchangeCode", () => {
  it.each([
    ["verifier mismatch", { codeVerifier: "B".repeat(43) }],
    ["redirect mismatch", { redirectUri: "https://evil.example/callback" }],
    ["client mismatch", { clientId: "other-client" }],
  ])(
    "rejects %s without consuming an observable second code",
    async (_name, override) => {
      const fixture = createFixture();

      await expect(
        fixture.service.exchangeCode(
          { ...validExchange, ...override },
          clientSecret,
          { correlationId },
        ),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      expect(fixture.repository.code?.consumedAt).toBeNull();

      await expect(
        fixture.service.exchangeCode(validExchange, clientSecret, {
          correlationId,
        }),
      ).resolves.toMatchObject({
        tokenType: "Bearer",
        expiresIn: 300,
      });
    },
  );

  it("allows one successful exchange and returns generic invalid_grant on replay", async () => {
    const fixture = createFixture();

    const first = await fixture.service.exchangeCode(
      validExchange,
      clientSecret,
      { correlationId },
    );

    expect(first.claims.entitlements).toContain("tf.search");
    await expect(
      fixture.service.exchangeCode(validExchange, clientSecret, {
        correlationId,
      }),
    ).rejects.toMatchObject({
      code: "invalid_grant",
      message: "The authorization grant is invalid.",
    });
    expect(fixture.signer.calls).toHaveLength(1);
    expect(fixture.repository.audits).toHaveLength(1);
  });

  it("accepts a 60-second application expiry when database transaction time is earlier", async () => {
    const fixture = createFixture();
    fixture.repository.code = authorizationCode({
      createdAt: new Date(now.getTime() - 500),
      expiresAt: new Date(now.getTime() + 60_000),
    });

    await expect(
      fixture.service.exchangeCode(validExchange, clientSecret, {
        correlationId,
      }),
    ).resolves.toMatchObject({ tokenType: "Bearer", expiresIn: 300 });
  });

  it("authenticates the confidential client before opening a transaction", async () => {
    const wrongSecret = createFixture();
    await expect(
      wrongSecret.service.exchangeCode(validExchange, "wrong-secret", {
        correlationId,
      }),
    ).rejects.toMatchObject({ code: "invalid_client" });
    expect(wrongSecret.transactions()).toBe(0);

    const unknownClient = createFixture();
    await expect(
      unknownClient.service.exchangeCode(
        { ...validExchange, clientId: "missing-client" },
        clientSecret,
        { correlationId },
      ),
    ).rejects.toMatchObject({ code: "invalid_client" });
    expect(unknownClient.transactions()).toBe(0);
  });

  it("rejects a matching stored redirect that is absent from the client allowlist", async () => {
    const fixture = createFixture();
    const unregisteredRedirect = "https://unregistered.example/callback";
    fixture.repository.code = authorizationCode({
      redirectUri: unregisteredRedirect,
    });

    await expect(
      fixture.service.exchangeCode(
        { ...validExchange, redirectUri: unregisteredRedirect },
        clientSecret,
        { correlationId },
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(fixture.repository.code?.consumedAt).toBeNull();
  });

  it("re-locks every binding and consumes before signing", async () => {
    const fixture = createFixture();

    await fixture.service.exchangeCode(validExchange, clientSecret, {
      correlationId,
    });

    expect(fixture.repository.events).toEqual([
      "lockCode",
      `accountContext:${accountId}`,
      "lockAccount",
      "lockSession",
      "lockInstallation",
      "lockCode",
      "listEntitlements",
      "consumeCode",
      "sign",
      "audit",
    ]);
  });

  it("signs only sorted current active module entitlements", async () => {
    const fixture = createFixture();
    fixture.repository.entitlements = [
      entitlement({
        id: "51000000-0000-4000-8000-000000000005",
        moduleId: "61000000-0000-4000-8000-000000000006",
        moduleKey: "tf.search",
      }),
      entitlement({
        id: "52000000-0000-4000-8000-000000000005",
        moduleId: "62000000-0000-4000-8000-000000000006",
        moduleKey: "tf.downloads",
      }),
      entitlement({
        id: "53000000-0000-4000-8000-000000000005",
        moduleId: "63000000-0000-4000-8000-000000000006",
        moduleKey: "tf.integrations",
        moduleState: "disabled",
      }),
      entitlement({
        id: "54000000-0000-4000-8000-000000000005",
        moduleId: "64000000-0000-4000-8000-000000000006",
        moduleKey: "tf.collections",
        revokedAt: new Date(now.getTime() - 1),
      }),
      entitlement({
        id: "55000000-0000-4000-8000-000000000005",
        moduleId: "65000000-0000-4000-8000-000000000006",
        moduleKey: "tf.collections",
        expiresAt: now,
      }),
    ];

    const result = await fixture.service.exchangeCode(
      validExchange,
      clientSecret,
      { correlationId },
    );

    expect(result.claims.entitlements).toEqual(["tf.downloads", "tf.search"]);
    expect(fixture.signer.calls[0]?.entitlements).toEqual([
      "tf.downloads",
      "tf.search",
    ]);
  });

  it.each([
    ["consumed code", authorizationCode({ consumedAt: now })],
    ["expired code", authorizationCode({ expiresAt: now })],
    [
      "overlong code lifetime",
      authorizationCode({ expiresAt: new Date(now.getTime() + 60_001) }),
    ],
  ])("returns invalid_grant for %s", async (_name, code) => {
    const fixture = createFixture();
    fixture.repository.code = code;

    await expect(
      fixture.service.exchangeCode(validExchange, clientSecret, {
        correlationId,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("maps malformed dates and inconsistent re-locks to policy_unavailable", async () => {
    const malformed = createFixture();
    malformed.repository.entitlements = [
      entitlement({ expiresAt: new Date(Number.NaN) }),
    ];
    await expect(
      malformed.service.exchangeCode(validExchange, clientSecret, {
        correlationId,
      }),
    ).rejects.toMatchObject({ code: "policy_unavailable" });

    const inconsistent = createFixture();
    let lockCount = 0;
    inconsistent.repository.lockAuthorizationCodeByDigest = async () => {
      lockCount += 1;
      return lockCount === 1
        ? inconsistent.repository.code
        : authorizationCode({
            id: "99999999-9999-4999-8999-999999999999",
          });
    };
    await expect(
      inconsistent.service.exchangeCode(validExchange, clientSecret, {
        correlationId,
      }),
    ).rejects.toMatchObject({ code: "policy_unavailable" });
  });
});

describe("AuthorizationService.introspect", () => {
  it("returns the current active account/session/install entitlement projection", async () => {
    const fixture = createFixture();
    fixture.repository.entitlements = [
      entitlement({ moduleKey: "tf.search" }),
      entitlement({
        id: "52000000-0000-4000-8000-000000000005",
        moduleId: "62000000-0000-4000-8000-000000000006",
        moduleKey: "tf.downloads",
      }),
      entitlement({
        id: "53000000-0000-4000-8000-000000000005",
        moduleId: "63000000-0000-4000-8000-000000000006",
        moduleKey: "tf.integrations",
        revokedAt: now,
      }),
    ];

    await expect(
      fixture.service.introspect(introspectionRequest, clientSecret),
    ).resolves.toEqual({
      active: true,
      accountId,
      sessionId,
      installationId,
      accountStatus: "active",
      entitlements: ["tf.downloads", "tf.search"],
      expiresAt: session().expiresAt.toISOString(),
    });
    expect(fixture.repository.events).toEqual([
      `accountContext:${accountId}`,
      "lockAccount",
      "lockSession",
      "lockInstallation",
      "listEntitlements",
    ]);
  });

  it("authenticates before opening an introspection transaction", async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.introspect(introspectionRequest, "wrong-secret"),
    ).rejects.toMatchObject({ code: "invalid_client" });
    expect(fixture.transactions()).toBe(0);
  });

  it.each([
    ["missing account", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.account = null;
    }],
    ["inactive account", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.account = account({ status: "suspended" });
    }],
    ["missing session", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.session = null;
    }],
    ["revoked session", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.session = session({ revokedAt: now });
    }],
    ["expired session", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.session = session({ expiresAt: now });
    }],
    ["wrong session audience", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.session = session({ audience: "apollo-tf" });
    }],
    ["missing installation", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.installation = null;
    }],
    ["revoked installation", (fixture: ReturnType<typeof createFixture>) => {
      fixture.repository.installation = installation({ revokedAt: now });
    }],
  ])("returns inactive for %s", async (_name, arrange) => {
    const fixture = createFixture();
    arrange(fixture);

    await expect(
      fixture.service.introspect(introspectionRequest, clientSecret),
    ).resolves.toEqual({ active: false });
  });

  it("throws policy_unavailable for inconsistent relations or malformed dates", async () => {
    const inconsistent = createFixture();
    inconsistent.repository.session = session({
      accountId: "99999999-9999-4999-8999-999999999999",
    });
    await expect(
      inconsistent.service.introspect(introspectionRequest, clientSecret),
    ).rejects.toMatchObject({ code: "policy_unavailable" });

    const malformed = createFixture();
    malformed.repository.installation = installation({
      lastSeenAt: new Date(Number.NaN),
    });
    await expect(
      malformed.service.introspect(introspectionRequest, clientSecret),
    ).rejects.toMatchObject({ code: "policy_unavailable" });
  });
});

describe("authorization audit safety", () => {
  it("audits only successful issue/exchange with no OAuth or signing secrets", async () => {
    const fixture = createFixture();
    const issued = await fixture.service.issueCode(user, authorizationRequest, {
      correlationId,
    });
    await fixture.service.exchangeCode(
      { ...validExchange, code: issued.rawCode },
      clientSecret,
      { correlationId },
    );

    expect(fixture.repository.audits).toHaveLength(2);
    expect(fixture.repository.audits.map(({ action }) => action)).toEqual([
      "authorization.code_issued",
      "authorization.code_exchanged",
    ]);
    const serialized = JSON.stringify(fixture.repository.audits);
    for (const secret of [
      issued.rawCode,
      digest(issued.rawCode),
      state,
      digest(state),
      verifier,
      pkceS256(verifier),
      clientSecret,
      clientSecretDigest,
      "signed.assertion.secret",
      nonce,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("apollo-tf-web");
    expect(serialized).toContain("https://api.tf.apollot.ru");
    expect(serialized).toContain("tf.search");
  });
});
