import { timingSafeEqual } from "node:crypto";

import type { Request, RequestHandler } from "express";

const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UNSAFE_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

export const AUTH_COOKIE_NAMES = Object.freeze({
  installation: "__Host-apollo_tf_installation",
  transaction: "__Host-apollo_tf_tx",
  session: "__Host-apollo_tf",
  csrf: "__Host-apollo_tf_csrf",
});

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  if (cookies === undefined) return null;
  const descriptor = Object.getOwnPropertyDescriptor(cookies, name);
  return descriptor?.get === undefined && typeof descriptor?.value === "string"
    ? descriptor.value
    : null;
}

function canonicalOpaque(value: string): boolean {
  if (!OPAQUE_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === value;
}

function constantTimeOpaqueMatch(left: string, right: string): boolean {
  if (!canonicalOpaque(left) || !canonicalOpaque(right)) return false;
  return timingSafeEqual(
    Buffer.from(left, "base64url"),
    Buffer.from(right, "base64url"),
  );
}

export function requireTfBrowserMutation(webOrigin: string): RequestHandler {
  return (request, response, next) => {
    if (!UNSAFE_METHODS.has(request.method.toUpperCase())) {
      next();
      return;
    }
    const session = cookieValue(request, AUTH_COOKIE_NAMES.session);
    const csrfCookie = cookieValue(request, AUTH_COOKIE_NAMES.csrf);
    const csrfHeader = request.get("x-csrf-token");
    if (
      request.get("origin") !== webOrigin ||
      session === null ||
      !canonicalOpaque(session) ||
      csrfCookie === null ||
      csrfHeader === undefined ||
      !constantTimeOpaqueMatch(csrfHeader, csrfCookie)
    ) {
      response.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}
