import { randomBytes, timingSafeEqual } from "node:crypto";

import type { Request, Response } from "express";

import { platformDomainError } from "../domain/errors.js";
import type { AuthenticatedUser } from "../domain/user-sessions.js";

export const PORTAL_SESSION_COOKIE = "__Host-apollo_portal";
export const PORTAL_CSRF_COOKIE = "__Host-apollo_portal_csrf";

const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface UserAuthenticationService {
  authenticate(rawToken: string): Promise<AuthenticatedUser>;
}

export function portalSessionToken(request: Request): string {
  const token = request.cookies?.[PORTAL_SESSION_COOKIE];
  if (typeof token !== "string" || !OPAQUE_TOKEN_PATTERN.test(token)) {
    throw platformDomainError("invalid_credentials");
  }
  return token;
}

export async function authenticatePortalUser(
  request: Request,
  userSessions: UserAuthenticationService,
): Promise<AuthenticatedUser> {
  return userSessions.authenticate(portalSessionToken(request));
}

export function hasMatchingPortalCsrf(request: Request): boolean {
  const cookie = request.cookies?.[PORTAL_CSRF_COOKIE];
  const header = request.get("x-csrf-token");
  if (
    typeof cookie !== "string" ||
    header === undefined ||
    !OPAQUE_TOKEN_PATTERN.test(cookie) ||
    !OPAQUE_TOKEN_PATTERN.test(header)
  ) {
    return false;
  }
  const cookieBytes = Buffer.from(cookie, "ascii");
  const headerBytes = Buffer.from(header, "ascii");
  return timingSafeEqual(cookieBytes, headerBytes);
}

export function securePortalCookies(
  response: Response,
  sessionToken: string,
): string {
  response.cookie(PORTAL_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
  const csrfToken = randomBytes(32).toString("base64url");
  response.cookie(PORTAL_CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
  return csrfToken;
}

export function clearPortalCookies(response: Response): void {
  const options = {
    path: "/",
    sameSite: "lax" as const,
    secure: true,
    maxAge: 0,
  };
  response.cookie(PORTAL_SESSION_COOKIE, "", {
    ...options,
    httpOnly: true,
  });
  response.cookie(PORTAL_CSRF_COOKIE, "", {
    ...options,
    httpOnly: false,
  });
}
