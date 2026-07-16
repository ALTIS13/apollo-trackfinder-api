import { describe, expect, it } from "vitest";
import {
  PLATFORM_MODULE_KEYS,
  PROTECTED_PLATFORM_ROUTES,
  accountStatusSchema,
  changeEntitlementRequestSchema,
  changeRegistrationModeRequestSchema,
  createInvitationRequestSchema,
  createRegistrationRequestSchema,
  moduleKeySchema,
  operatorSessionRequestSchema,
  platformErrorCodeSchema,
  policyDecisionSchema,
  registrationModeSchema,
  registrationStatusResponseSchema,
} from "./index";

const accountId = "11111111-1111-4111-8111-111111111111";
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
