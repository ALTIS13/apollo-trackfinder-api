import type { Router } from "express";
import { z } from "zod";

import {
  PROTECTED_PLATFORM_ROUTES,
  changeEntitlementRequestSchema,
  changeRegistrationModeRequestSchema,
  createInvitationRequestSchema,
  moduleKeySchema,
  type ProtectedPlatformRoute,
} from "@workspace/platform-contract";

import type { EntitlementService } from "../domain/entitlements.js";
import type { InvitationService } from "../domain/invitations.js";
import type { OperatorSessionService } from "../domain/operator-sessions.js";
import type { RegistrationService } from "../domain/registration.js";
import {
  forbiddenError,
  rateLimitedError,
  validationError,
} from "../http/errors.js";
import type { RateLimiter } from "../http/rate-limit.js";
import {
  ADMIN_SESSION_COOKIE,
  clearAdminCookies,
  hasExactAllowedOrigin,
  protectedRoute,
  secureAdminCookies,
  type OperatorRouteHandler,
} from "../http/operator-auth.js";
import { publicAccount } from "./public-registration.js";

const uuidSchema = z.string().uuid();
const reasonSchema = z.object({ reason: z.string().trim().min(1) }).strict();
const entitlementBodySchema = z
  .object({
    expiresAt: z.string().datetime({ offset: true }).optional(),
    reason: z.string().trim().min(1),
  })
  .strict();
const bootstrapSchema = z
  .object({
    bootstrapToken: z.string().min(1),
    email: z.string().trim().toLowerCase().email(),
    displayName: z.string().trim().min(1),
    password: z.string().min(1),
    reason: z.string().trim().min(1),
  })
  .strict();

export const REGISTERED_PROTECTED_PLATFORM_ROUTES = Object.freeze({
  ...PROTECTED_PLATFORM_ROUTES,
});

export interface OperatorRouteDependencies {
  readonly registration: Pick<
    RegistrationService,
    "changeMode" | "activateAccount" | "suspendAccount"
  >;
  readonly invitations: Pick<InvitationService, "create" | "revoke">;
  readonly operatorSessions: Pick<
    OperatorSessionService,
    "bootstrap" | "login" | "authenticate" | "revoke"
  >;
  readonly entitlements: Pick<EntitlementService, "grant" | "revoke">;
  readonly rateLimiter: RateLimiter;
  readonly allowedOrigins: readonly string[];
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw validationError();
  return parsed.data;
}

function operatorContext(response: Parameters<OperatorRouteHandler>[1]) {
  const operator = response.locals.operator as { readonly accountId: string };
  return {
    accountId: operator.accountId,
    correlationId: String(response.locals.requestId),
  };
}

function requirePathId(value: string | string[]): string {
  if (typeof value !== "string") throw validationError();
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw validationError();
  return parsed.data;
}

function requireModuleKey(value: string | string[]): string {
  if (typeof value !== "string") throw validationError();
  const parsed = moduleKeySchema.safeParse(value);
  if (!parsed.success) throw validationError();
  return parsed.data;
}

async function enforceRateLimit(
  rateLimiter: RateLimiter,
  bucket: string,
  ip: string,
  identity: string,
): Promise<void> {
  const result = await rateLimiter.consume({ bucket, ip, identity });
  if (!result.allowed) throw rateLimitedError(result.retryAfterSeconds);
}

function invitationProjection(invitation: {
  readonly id: string;
  readonly expiresAt: Date;
  readonly usesLimit: number;
  readonly usesRemaining: number;
  readonly emailBound: boolean;
  readonly moduleKeys: readonly string[];
}) {
  return {
    id: invitation.id,
    expiresAt: invitation.expiresAt.toISOString(),
    usesLimit: invitation.usesLimit,
    usesRemaining: invitation.usesRemaining,
    emailBound: invitation.emailBound,
    moduleKeys: invitation.moduleKeys,
  };
}

function entitlementProjection(entitlement: {
  readonly id: string;
  readonly accountId: string;
  readonly moduleKey: string;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly source: string;
}) {
  return {
    id: entitlement.id,
    accountId: entitlement.accountId,
    moduleKey: entitlement.moduleKey,
    expiresAt: entitlement.expiresAt?.toISOString() ?? null,
    revokedAt: entitlement.revokedAt?.toISOString() ?? null,
    source: entitlement.source,
  };
}

function registerProtectedRoute(
  router: Router,
  dependencies: OperatorRouteDependencies,
  protectedRouteMapping: Readonly<Record<string, readonly string[]>>,
  route: ProtectedPlatformRoute,
  handler: OperatorRouteHandler,
): void {
  const [method, path] = route.split(" ", 2) as [
    "PATCH" | "POST" | "PUT" | "DELETE",
    string,
  ];
  const middleware = protectedRoute(
    dependencies,
    protectedRouteMapping[route] ?? [],
    handler,
  );
  switch (method) {
    case "PATCH":
      router.patch(path, middleware);
      return;
    case "POST":
      router.post(path, middleware);
      return;
    case "PUT":
      router.put(path, middleware);
      return;
    case "DELETE":
      router.delete(path, middleware);
      return;
  }
}

export function registerOperatorRoutes(
  router: Router,
  dependencies: OperatorRouteDependencies,
  protectedRouteMapping: Readonly<
    Record<string, readonly string[]>
  > = REGISTERED_PROTECTED_PLATFORM_ROUTES,
): void {
  router.post("/v1/operator/bootstrap", async (request, response, next) => {
    try {
      if (!hasExactAllowedOrigin(request, dependencies.allowedOrigins)) {
        throw forbiddenError();
      }
      const account = await dependencies.operatorSessions.bootstrap(
        parseBody(bootstrapSchema, request.body),
        { correlationId: String(response.locals.requestId) },
      );
      response.status(201).json({ account: publicAccount(account) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/v1/operator/sessions", async (request, response, next) => {
    try {
      if (!hasExactAllowedOrigin(request, dependencies.allowedOrigins)) {
        throw forbiddenError();
      }
      const input = parseBody(
        z
          .object({
            email: z.string().trim().toLowerCase().email(),
            password: z.string().min(1),
          })
          .strict(),
        request.body,
      );
      const email = input.email;
      if (typeof email !== "string") throw validationError();
      await enforceRateLimit(
        dependencies.rateLimiter,
        "login",
        request.ip ?? "unavailable",
        email,
      );
      const result = await dependencies.operatorSessions.login(input, {
        correlationId: String(response.locals.requestId),
      });
      const csrfToken = secureAdminCookies(response, result.rawToken);
      response.status(200).json({ csrfToken });
    } catch (error) {
      next(error);
    }
  });

  router.delete(
    "/v1/operator/sessions/current",
    protectedRoute(dependencies, [], async (request, response) => {
      const sessionToken = request.cookies?.[ADMIN_SESSION_COOKIE] as string;
      await dependencies.operatorSessions.revoke(sessionToken, {
        correlationId: String(response.locals.requestId),
      });
      clearAdminCookies(response);
      response.status(204).end();
    }),
  );

  registerProtectedRoute(
    router,
    dependencies,
    protectedRouteMapping,
    "PATCH /v1/operator/registration-settings",
    async (request, response) => {
      const result = await dependencies.registration.changeMode(
        parseBody(changeRegistrationModeRequestSchema, request.body),
        operatorContext(response),
      );
      response.json(result);
    },
  );

  registerProtectedRoute(
    router,
    dependencies,
    protectedRouteMapping,
    "POST /v1/operator/invitations",
    async (request, response) => {
      const result = await dependencies.invitations.create(
        parseBody(createInvitationRequestSchema, request.body),
        operatorContext(response),
      );
      response.status(201).json({
        invitation: invitationProjection(result.invitation),
        invitationToken: result.rawToken,
      });
    },
  );

  registerProtectedRoute(
    router,
    dependencies,
    protectedRouteMapping,
    "POST /v1/operator/invitations/:id/revoke",
    async (request, response) => {
      const result = await dependencies.invitations.revoke(
        {
          invitationId: requirePathId(request.params.id),
          ...parseBody(reasonSchema, request.body),
        },
        operatorContext(response),
      );
      response.json({ invitation: invitationProjection(result) });
    },
  );

  registerProtectedRoute(
    router,
    dependencies,
    protectedRouteMapping,
    "POST /v1/operator/accounts/:id/activate",
    async (request, response) => {
      const account = await dependencies.registration.activateAccount(
        {
          accountId: requirePathId(request.params.id),
          ...parseBody(reasonSchema, request.body),
        },
        operatorContext(response),
      );
      response.json({ account: publicAccount(account) });
    },
  );

  registerProtectedRoute(
    router,
    dependencies,
    protectedRouteMapping,
    "POST /v1/operator/accounts/:id/suspend",
    async (request, response) => {
      const account = await dependencies.registration.suspendAccount(
        {
          accountId: requirePathId(request.params.id),
          ...parseBody(reasonSchema, request.body),
        },
        operatorContext(response),
      );
      response.json({ account: publicAccount(account) });
    },
  );

  registerProtectedRoute(
    router,
    dependencies,
    protectedRouteMapping,
    "PUT /v1/operator/accounts/:id/entitlements/:moduleKey",
    async (request, response) => {
      const body = parseBody(entitlementBodySchema, request.body);
      const result = await dependencies.entitlements.grant(
        parseBody(changeEntitlementRequestSchema, {
          accountId: requirePathId(request.params.id),
          moduleKey: requireModuleKey(request.params.moduleKey),
          ...body,
        }),
        operatorContext(response),
      );
      response.json({ entitlement: entitlementProjection(result) });
    },
  );

  registerProtectedRoute(
    router,
    dependencies,
    protectedRouteMapping,
    "DELETE /v1/operator/accounts/:id/entitlements/:moduleKey",
    async (request, response) => {
      const result = await dependencies.entitlements.revoke(
        parseBody(changeEntitlementRequestSchema, {
          ...parseBody(reasonSchema, request.body),
          accountId: requirePathId(request.params.id),
          moduleKey: requireModuleKey(request.params.moduleKey),
        }),
        operatorContext(response),
      );
      response.json({ entitlement: entitlementProjection(result) });
    },
  );
}
