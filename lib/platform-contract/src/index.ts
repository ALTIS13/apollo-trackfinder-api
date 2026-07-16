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
