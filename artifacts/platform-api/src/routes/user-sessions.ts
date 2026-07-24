import type { Router } from "express";

import { userSessionRequestSchema } from "@workspace/platform-contract";

import { APOLLO_PORTAL_AUDIENCE } from "../domain/user-sessions.js";
import type { UserSessionService } from "../domain/user-sessions.js";
import { forbiddenError, rateLimitedError, validationError } from "../http/errors.js";
import type { RateLimiter } from "../http/rate-limit.js";
import {
  authenticatePortalUser,
  clearPortalCookies,
  hasMatchingPortalCsrf,
  portalSessionToken,
  securePortalCookies,
} from "../http/user-auth.js";
import { hasExactAllowedOrigin } from "../http/operator-auth.js";

export interface UserSessionRouteDependencies {
  readonly allowedOrigins: readonly string[];
  readonly rateLimiter: RateLimiter;
  readonly userSessions: Pick<
    UserSessionService,
    "login" | "authenticate" | "revoke"
  >;
}

function publicSession(user: {
  readonly accountId: string;
  readonly sessionId: string;
  readonly status: "pending" | "active";
  readonly emailVerified: true;
}) {
  return {
    accountId: user.accountId,
    sessionId: user.sessionId,
    status: user.status,
    emailVerified: true as const,
    audience: APOLLO_PORTAL_AUDIENCE,
  };
}

export function registerUserSessionRoutes(
  router: Router,
  dependencies: UserSessionRouteDependencies,
): void {
  router.post("/v1/sessions", async (request, response, next) => {
    try {
      if (!hasExactAllowedOrigin(request, dependencies.allowedOrigins)) {
        throw forbiddenError();
      }
      const parsed = userSessionRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError();
      const rateLimit = await dependencies.rateLimiter.consume({
        bucket: "user-login",
        ip: request.ip ?? "unavailable",
        identity: parsed.data.email,
      });
      if (!rateLimit.allowed) {
        throw rateLimitedError(rateLimit.retryAfterSeconds);
      }
      const result = await dependencies.userSessions.login(parsed.data, {
        correlationId: String(response.locals.requestId),
      });
      const csrfToken = securePortalCookies(response, result.rawToken);
      response.status(200).json({
        ...publicSession({
          accountId: result.account.id,
          sessionId: result.session.id,
          status: result.account.status as "pending" | "active",
          emailVerified: true,
        }),
        csrfToken,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/v1/session", async (request, response, next) => {
    try {
      const user = await authenticatePortalUser(
        request,
        dependencies.userSessions,
      );
      response.json(publicSession(user));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/v1/session", async (request, response, next) => {
    try {
      if (
        !hasExactAllowedOrigin(request, dependencies.allowedOrigins) ||
        !hasMatchingPortalCsrf(request)
      ) {
        throw forbiddenError();
      }
      const token = portalSessionToken(request);
      await dependencies.userSessions.revoke(token, {
        correlationId: String(response.locals.requestId),
      });
      clearPortalCookies(response);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}
