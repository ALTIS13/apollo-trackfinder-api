import { randomUUID, timingSafeEqual } from "node:crypto";

import type { Request, RequestHandler, Response } from "express";

import { platformDomainError } from "../domain/errors.js";
import type { AuthenticatedOperator } from "../domain/operator-sessions.js";
import { forbiddenError } from "./errors.js";

export const ADMIN_SESSION_COOKIE = "__Host-apollo_admin";
export const ADMIN_CSRF_COOKIE = "apollo_admin_csrf";

export interface OperatorAuthenticationService {
  authenticate(rawToken: string): Promise<AuthenticatedOperator>;
}

export interface OperatorAuthDependencies {
  readonly allowedOrigins: readonly string[];
  readonly operatorSessions: OperatorAuthenticationService;
}

export type OperatorRouteHandler = (
  request: Request,
  response: Response,
) => Promise<void> | void;

export function hasExactAllowedOrigin(
  request: Request,
  allowedOrigins: readonly string[],
): boolean {
  const origin = request.get("origin");
  return origin !== undefined && allowedOrigins.includes(origin);
}

function hasMatchingCsrfToken(request: Request): boolean {
  const csrfCookie = request.cookies?.[ADMIN_CSRF_COOKIE];
  const csrfHeader = request.get("x-csrf-token");
  if (typeof csrfCookie !== "string" || csrfHeader === undefined) {
    return false;
  }
  const left = Buffer.from(csrfCookie);
  const right = Buffer.from(csrfHeader);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function secureAdminCookies(
  response: Response,
  sessionToken: string,
): void {
  response.cookie(ADMIN_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
  response.cookie(ADMIN_CSRF_COOKIE, randomUUID(), {
    httpOnly: false,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
}

export function clearAdminCookies(response: Response): void {
  const options = {
    path: "/",
    sameSite: "lax" as const,
    secure: true,
    maxAge: 0,
  };
  response.cookie(ADMIN_SESSION_COOKIE, "", { ...options, httpOnly: true });
  response.cookie(ADMIN_CSRF_COOKIE, "", { ...options, httpOnly: false });
}

export function protectedRoute(
  dependencies: OperatorAuthDependencies,
  requiredCapabilities: readonly string[],
  handler: OperatorRouteHandler,
): RequestHandler {
  const middleware: RequestHandler & {
    requiredCapabilities?: readonly string[];
  } = async (request, response, next) => {
    try {
      if (
        !hasExactAllowedOrigin(request, dependencies.allowedOrigins) ||
        !hasMatchingCsrfToken(request)
      ) {
        throw forbiddenError();
      }
      const sessionToken = request.cookies?.[ADMIN_SESSION_COOKIE];
      if (typeof sessionToken !== "string" || sessionToken.length === 0) {
        throw platformDomainError("invalid_credentials");
      }
      const operator =
        await dependencies.operatorSessions.authenticate(sessionToken);
      if (
        !requiredCapabilities.every((capability) =>
          operator.capabilities.includes(capability),
        )
      ) {
        throw platformDomainError("module_access_denied");
      }
      response.locals.operator = operator;
      await handler(request, response);
    } catch (error) {
      next(error);
    }
  };
  middleware.requiredCapabilities = Object.freeze([...requiredCapabilities]);
  return middleware;
}
