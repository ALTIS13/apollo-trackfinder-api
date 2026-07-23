import { describe, expect, it } from "vitest";
import {
  PLATFORM_MODULE_KEYS,
  PROTECTED_PLATFORM_ROUTES,
  accountStatusSchema,
  authorizationCodeExchangeSchema,
  authorizationRequestSchema,
  changeEntitlementRequestSchema,
  changeRegistrationModeRequestSchema,
  createInvitationRequestSchema,
  createRegistrationRequestSchema,
  moduleKeySchema,
  operatorSessionRequestSchema,
  platformErrorCodeSchema,
  platformAssertionClaimsSchema,
  policyDecisionSchema,
  policyIntrospectionRequestSchema,
  policyIntrospectionResponseSchema,
  registrationModeSchema,
  registrationStatusResponseSchema,
  userSessionRequestSchema,
} from "./index";

const accountId = "11111111-1111-4111-8111-111111111111";
const installationId = "10000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000002";
const expiresAt = "2026-08-16T12:00:00.000Z";

describe("platform contract", () => {
  it("publishes the exact platform enums and initial module keys", () => {
    expect(registrationModeSchema.options).toEqual([
      "closed",
      "invite_only",
      "open_approval",
    ]);
    expect(accountStatusSchema.options).toEqual([
      "pending",
      "active",
      "suspended",
      "deleted",
    ]);
    expect(PLATFORM_MODULE_KEYS).toEqual([
      "tf.search",
      "tf.integrations",
      "tf.downloads",
      "tf.collections",
    ]);
    expect(moduleKeySchema.safeParse("TF.Search").success).toBe(false);
    expect(moduleKeySchema.parse("tf.search")).toBe("tf.search");
    expect(platformErrorCodeSchema.parse("module_access_denied")).toBe(
      "module_access_denied",
    );
  });

  it("normalizes public identity inputs and rejects unknown object fields", () => {
    expect(
      createRegistrationRequestSchema.parse({
        email: "  User@Example.COM ",
        displayName: "  Apollo User  ",
        password: " password with spaces ",
        invitationToken: "  invite-token  ",
      }),
    ).toEqual({
      email: "user@example.com",
      displayName: "Apollo User",
      password: " password with spaces ",
      invitationToken: "invite-token",
    });
    expect(
      operatorSessionRequestSchema.parse({
        email: "  Operator@Example.COM ",
        password: "operator-password",
      }),
    ).toEqual({
      email: "operator@example.com",
      password: "operator-password",
    });
    expect(
      registrationStatusResponseSchema.safeParse({
        mode: "closed",
        internalRevision: 7,
      }).success,
    ).toBe(false);
    expect(
      createRegistrationRequestSchema.safeParse({
        email: "user@example.com",
        displayName: "User",
        password: "password",
        internalStatus: "active",
      }).success,
    ).toBe(false);
  });

  it("normalizes bounded user session input and rejects unknown fields", () => {
    expect(
      userSessionRequestSchema.parse({
        email: "  User@Example.COM ",
        password: "password",
      }),
    ).toEqual({ email: "user@example.com", password: "password" });
    expect(
      userSessionRequestSchema.safeParse({
        email: "user@example.com",
        password: "password",
        audience: "apollo-tf",
      }).success,
    ).toBe(false);
    expect(
      userSessionRequestSchema.safeParse({
        email: "user@example.com",
        password: "p".repeat(1025),
      }).success,
    ).toBe(false);
  });

  it("accepts only exact S256 authorization input", () => {
    const request = {
      clientId: "apollo-tf-web",
      redirectUri: "https://api.tf.apollot.ru/api/auth/callback",
      responseType: "code",
      codeChallenge: "A".repeat(43),
      codeChallengeMethod: "S256",
      state: "s".repeat(43),
      nonce: "n".repeat(43),
      installationId,
      installationLabel: "Firefox on Windows",
    };

    expect(authorizationRequestSchema.parse(request)).toMatchObject({
      codeChallengeMethod: "S256",
    });
    expect(
      authorizationRequestSchema.safeParse({
        ...request,
        codeChallengeMethod: "plain",
      }).success,
    ).toBe(false);
    expect(
      authorizationRequestSchema.safeParse({
        ...request,
        state: "state-value",
      }).success,
    ).toBe(false);
    expect(
      authorizationRequestSchema.safeParse({
        ...request,
        internalRedirect: true,
      }).success,
    ).toBe(false);
  });

  it("accepts bounded authorization code exchanges only", () => {
    const exchange = {
      grantType: "authorization_code",
      clientId: "apollo-tf-web",
      code: "c".repeat(32),
      codeVerifier: "v".repeat(43),
      redirectUri: "https://api.tf.apollot.ru/api/auth/callback",
    };

    expect(authorizationCodeExchangeSchema.parse(exchange)).toEqual(exchange);
    expect(
      authorizationCodeExchangeSchema.safeParse({
        ...exchange,
        codeVerifier: "v".repeat(42),
      }).success,
    ).toBe(false);
    expect(
      authorizationCodeExchangeSchema.safeParse({
        ...exchange,
        grantType: "refresh_token",
      }).success,
    ).toBe(false);
  });

  it("validates bounded active platform assertion claims", () => {
    const claims = {
      iss: "https://api.apollot.ru",
      aud: "apollo-tf",
      sub: accountId,
      sid: sessionId,
      installation_id: installationId,
      nonce: "n".repeat(43),
      account_status: "active",
      entitlements: ["tf.search", "tf.downloads"],
      jti: "30000000-0000-4000-8000-000000000003",
      iat: 1_700_000_000,
      nbf: 1_700_000_000,
      exp: 1_700_000_300,
    };

    expect(platformAssertionClaimsSchema.parse(claims)).toEqual(claims);
    expect(
      platformAssertionClaimsSchema.safeParse({
        ...claims,
        aud: "other-audience",
      }).success,
    ).toBe(false);
    expect(
      platformAssertionClaimsSchema.safeParse({
        ...claims,
        entitlements: ["tf.search", "tf.search"],
      }).success,
    ).toBe(false);
    expect(
      platformAssertionClaimsSchema.safeParse({
        ...claims,
        exp: claims.iat + 301,
      }).success,
    ).toBe(false);
    expect(
      platformAssertionClaimsSchema.safeParse({
        ...claims,
        nbf: claims.iat + 1,
      }).success,
    ).toBe(false);
  });

  it("validates strict policy introspection contracts", () => {
    const request = {
      accountId,
      sessionId,
      installationId,
      audience: "apollo-tf",
    };
    const activeResponse = {
      active: true,
      accountId,
      sessionId,
      installationId,
      accountStatus: "active",
      entitlements: ["tf.search"],
      expiresAt,
    };

    expect(policyIntrospectionRequestSchema.parse(request)).toEqual(request);
    expect(policyIntrospectionResponseSchema.parse({ active: false })).toEqual({
      active: false,
    });
    expect(policyIntrospectionResponseSchema.parse(activeResponse)).toEqual(
      activeResponse,
    );
    expect(
      policyIntrospectionRequestSchema.safeParse({
        ...request,
        audience: "apollo-admin",
      }).success,
    ).toBe(false);
    expect(
      policyIntrospectionResponseSchema.safeParse({
        active: false,
        accountId,
      }).success,
    ).toBe(false);
    expect(
      policyIntrospectionResponseSchema.safeParse({
        ...activeResponse,
        entitlements: ["tf.search", "tf.search"],
      }).success,
    ).toBe(false);
  });

  it("validates invitation and operator mutation inputs", () => {
    expect(
      createInvitationRequestSchema.parse({
        email: "  Invitee@Example.COM ",
        expiresAt,
        usesLimit: 1,
        moduleKeys: ["tf.search", "tf.downloads"],
        reason: "  Closed beta access  ",
      }),
    ).toEqual({
      email: "invitee@example.com",
      expiresAt,
      usesLimit: 1,
      moduleKeys: ["tf.search", "tf.downloads"],
      reason: "Closed beta access",
    });
    expect(
      createInvitationRequestSchema.safeParse({
        expiresAt: "tomorrow",
        usesLimit: 1,
        moduleKeys: ["tf.search"],
        reason: "Invite",
      }).success,
    ).toBe(false);
    expect(
      createInvitationRequestSchema.safeParse({
        expiresAt,
        usesLimit: 1,
        moduleKeys: ["tf.search", "tf.search"],
        reason: "Invite",
      }).success,
    ).toBe(false);
    expect(
      changeRegistrationModeRequestSchema.parse({
        mode: "invite_only",
        reason: "  Restrict beta access  ",
      }),
    ).toEqual({
      mode: "invite_only",
      reason: "Restrict beta access",
    });
    expect(
      changeEntitlementRequestSchema.parse({
        accountId,
        moduleKey: "tf.collections",
        expiresAt,
        reason: "  Grant collections  ",
      }),
    ).toEqual({
      accountId,
      moduleKey: "tf.collections",
      expiresAt,
      reason: "Grant collections",
    });
    expect(
      changeEntitlementRequestSchema.safeParse({
        accountId: "not-a-uuid",
        moduleKey: "tf.search",
        reason: "Grant search",
      }).success,
    ).toBe(false);
  });

  it("exposes only public-safe policy decision fields", () => {
    expect(policyDecisionSchema.parse({ allowed: true })).toEqual({
      allowed: true,
    });
    expect(
      policyDecisionSchema.parse({
        allowed: false,
        code: "module_access_denied",
        missingModuleKeys: ["tf.search"],
      }),
    ).toEqual({
      allowed: false,
      code: "module_access_denied",
      missingModuleKeys: ["tf.search"],
    });
    expect(
      policyDecisionSchema.safeParse({
        allowed: false,
        code: "policy_unavailable",
        databaseMessage: "connection refused",
      }).success,
    ).toBe(false);
  });

  it("maps every protected operator route to an explicit capability", () => {
    expect(new Set(Object.keys(PROTECTED_PLATFORM_ROUTES))).toEqual(
      new Set([
        "PATCH /v1/operator/registration-settings",
        "POST /v1/operator/invitations",
        "POST /v1/operator/invitations/:id/revoke",
        "POST /v1/operator/accounts/:id/activate",
        "POST /v1/operator/accounts/:id/suspend",
        "PUT /v1/operator/accounts/:id/entitlements/:moduleKey",
        "DELETE /v1/operator/accounts/:id/entitlements/:moduleKey",
      ]),
    );
    expect(PROTECTED_PLATFORM_ROUTES).toEqual({
      "PATCH /v1/operator/registration-settings": [
        "platform.registration.manage",
      ],
      "POST /v1/operator/invitations": ["platform.invitations.manage"],
      "POST /v1/operator/invitations/:id/revoke": [
        "platform.invitations.manage",
      ],
      "POST /v1/operator/accounts/:id/activate": ["platform.accounts.manage"],
      "POST /v1/operator/accounts/:id/suspend": ["platform.accounts.manage"],
      "PUT /v1/operator/accounts/:id/entitlements/:moduleKey": [
        "platform.entitlements.manage",
      ],
      "DELETE /v1/operator/accounts/:id/entitlements/:moduleKey": [
        "platform.entitlements.manage",
      ],
    });
  });
});
