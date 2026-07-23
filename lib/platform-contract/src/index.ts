import { z } from "zod";

export const registrationModeSchema = z.enum([
  "closed",
  "invite_only",
  "open_approval",
]);

export const accountStatusSchema = z.enum([
  "pending",
  "active",
  "suspended",
  "deleted",
]);

export const PLATFORM_MODULE_KEYS = [
  "tf.search",
  "tf.integrations",
  "tf.downloads",
  "tf.collections",
] as const;

export const moduleKeySchema = z
  .string()
  .regex(/^[a-z0-9]+(?:\.[a-z0-9]+)+$/, "Invalid module key");

export const platformErrorCodeSchema = z.enum([
  "registration_not_available",
  "invitation_not_available",
  "invalid_credentials",
  "module_access_denied",
  "policy_unavailable",
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "account_access_denied",
]);

const normalizedEmailSchema = z.string().trim().toLowerCase().email();
const displayNameSchema = z.string().trim().min(1);
const reasonSchema = z.string().trim().min(1);
const passwordSchema = z.string().min(1);
const opaqueTokenSchema = z.string().trim().min(1);
const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const moduleKeysSchema = z
  .array(moduleKeySchema)
  .min(1)
  .refine((moduleKeys) => new Set(moduleKeys).size === moduleKeys.length, {
    message: "Module keys must be unique",
  });
const tfEntitlementsSchema = z
  .array(z.enum(PLATFORM_MODULE_KEYS))
  .max(PLATFORM_MODULE_KEYS.length)
  .refine((values) => new Set(values).size === values.length, {
    message: "Entitlements must be unique",
  });

export const registrationStatusResponseSchema = z
  .object({
    mode: registrationModeSchema,
  })
  .strict();

export const createRegistrationRequestSchema = z
  .object({
    email: normalizedEmailSchema,
    displayName: displayNameSchema,
    password: passwordSchema,
    invitationToken: opaqueTokenSchema.optional(),
  })
  .strict();

export const operatorSessionRequestSchema = z
  .object({
    email: normalizedEmailSchema,
    password: passwordSchema,
  })
  .strict();

export const userSessionRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).max(1024),
  })
  .strict();

export const authorizationRequestSchema = z
  .object({
    clientId: z.string().trim().min(1).max(128),
    redirectUri: z.string().url().max(2048),
    responseType: z.literal("code"),
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    codeChallengeMethod: z.literal("S256"),
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    installationId: z.string().uuid(),
    installationLabel: z.string().trim().min(1).max(120),
  })
  .strict();

export const authorizationCodeExchangeSchema = z
  .object({
    grantType: z.literal("authorization_code"),
    clientId: z.string().trim().min(1).max(128),
    code: z.string().min(32).max(512),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    redirectUri: z.string().url().max(2048),
  })
  .strict();

export const platformAssertionClaimsSchema = z
  .object({
    iss: z.string().url().max(2048),
    aud: z.literal("apollo-tf"),
    sub: z.string().uuid(),
    sid: z.string().uuid(),
    installation_id: z.string().uuid(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    account_status: z.literal("active"),
    entitlements: tfEntitlementsSchema,
    jti: z.string().uuid(),
    iat: z.number().int().nonnegative(),
    nbf: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict()
  .superRefine((claims, context) => {
    if (
      claims.nbf > claims.iat ||
      claims.iat >= claims.exp ||
      claims.exp - claims.iat > 300
    ) {
      context.addIssue({ code: "custom", message: "Invalid assertion lifetime" });
    }
  });

export const policyIntrospectionRequestSchema = z
  .object({
    accountId: z.string().uuid(),
    sessionId: z.string().uuid(),
    installationId: z.string().uuid(),
    audience: z.literal("apollo-tf"),
  })
  .strict();

export const policyIntrospectionResponseSchema = z.discriminatedUnion(
  "active",
  [
    z.object({ active: z.literal(false) }).strict(),
    z
      .object({
        active: z.literal(true),
        accountId: z.string().uuid(),
        sessionId: z.string().uuid(),
        installationId: z.string().uuid(),
        accountStatus: z.literal("active"),
        entitlements: tfEntitlementsSchema,
        expiresAt: z.string().datetime({ offset: true }),
      })
      .strict(),
  ],
);

export const createInvitationRequestSchema = z
  .object({
    email: normalizedEmailSchema.optional(),
    expiresAt: timestampSchema,
    usesLimit: z.number().int().positive(),
    moduleKeys: moduleKeysSchema,
    reason: reasonSchema,
  })
  .strict();

export const changeRegistrationModeRequestSchema = z
  .object({
    mode: registrationModeSchema,
    reason: reasonSchema,
  })
  .strict();

export const changeEntitlementRequestSchema = z
  .object({
    accountId: uuidSchema,
    moduleKey: moduleKeySchema,
    expiresAt: timestampSchema.optional(),
    reason: reasonSchema,
  })
  .strict();

export const policyDecisionSchema = z.union([
  z.object({ allowed: z.literal(true) }).strict(),
  z
    .object({
      allowed: z.literal(false),
      code: z.literal("module_access_denied"),
      missingModuleKeys: moduleKeysSchema,
    })
    .strict(),
  z
    .object({
      allowed: z.literal(false),
      code: z.literal("policy_unavailable"),
    })
    .strict(),
]);

export const PROTECTED_PLATFORM_ROUTES = {
  "PATCH /v1/operator/registration-settings": ["platform.registration.manage"],
  "POST /v1/operator/invitations": ["platform.invitations.manage"],
  "POST /v1/operator/invitations/:id/revoke": ["platform.invitations.manage"],
  "POST /v1/operator/accounts/:id/activate": ["platform.accounts.manage"],
  "POST /v1/operator/accounts/:id/suspend": ["platform.accounts.manage"],
  "PUT /v1/operator/accounts/:id/entitlements/:moduleKey": [
    "platform.entitlements.manage",
  ],
  "DELETE /v1/operator/accounts/:id/entitlements/:moduleKey": [
    "platform.entitlements.manage",
  ],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type RegistrationMode = z.infer<typeof registrationModeSchema>;
export type AccountStatus = z.infer<typeof accountStatusSchema>;
export type ModuleKey = z.infer<typeof moduleKeySchema>;
export type PlatformErrorCode = z.infer<typeof platformErrorCodeSchema>;
export type RegistrationStatusResponse = z.infer<
  typeof registrationStatusResponseSchema
>;
export type CreateRegistrationRequest = z.infer<
  typeof createRegistrationRequestSchema
>;
export type OperatorSessionRequest = z.infer<
  typeof operatorSessionRequestSchema
>;
export type UserSessionRequest = z.infer<typeof userSessionRequestSchema>;
export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;
export type AuthorizationCodeExchangeRequest = z.infer<
  typeof authorizationCodeExchangeSchema
>;
export type PlatformAssertionClaims = z.infer<
  typeof platformAssertionClaimsSchema
>;
export type PolicyIntrospectionRequest = z.infer<
  typeof policyIntrospectionRequestSchema
>;
export type PolicyIntrospectionResponse = z.infer<
  typeof policyIntrospectionResponseSchema
>;
export type CreateInvitationRequest = z.infer<
  typeof createInvitationRequestSchema
>;
export type ChangeRegistrationModeRequest = z.infer<
  typeof changeRegistrationModeRequestSchema
>;
export type ChangeEntitlementRequest = z.infer<
  typeof changeEntitlementRequestSchema
>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type ProtectedPlatformRoute = keyof typeof PROTECTED_PLATFORM_ROUTES;
export type PlatformOperatorCapability =
  (typeof PROTECTED_PLATFORM_ROUTES)[ProtectedPlatformRoute][number];
