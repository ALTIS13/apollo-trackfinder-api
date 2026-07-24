import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { PlatformAssertionClaims } from "@workspace/platform-contract";
import {
  Router,
  type CookieOptions,
  type Request,
  type Response,
} from "express";

import {
  PlatformAuthUnavailableError,
  type PlatformAuthClient,
} from "../lib/platform-auth-client.js";
import {
  TfSessionStoreUnavailableError,
  type TfSessionStore,
} from "../lib/tf-session-store.js";

const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[\x21-\x7e]{32,512}$/;
const INSTALLATION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1_000;
const TRANSACTION_MAX_AGE_MS = 5 * 60 * 1_000;
const INSTALLATION_LABEL = "Apollo TF Web";

export const AUTH_COOKIE_NAMES = Object.freeze({
  installation: "__Host-apollo_tf_installation",
  transaction: "__Host-apollo_tf_tx",
  session: "__Host-apollo_tf",
  csrf: "__Host-apollo_tf_csrf",
});

export interface AuthRouteDependencies {
  readonly platform: Pick<
    PlatformAuthClient,
    "createAuthorizationUrl" | "exchangeCode" | "introspect"
  >;
  readonly sessionStore: Pick<
    TfSessionStore,
    | "createTransaction"
    | "consumeTransaction"
    | "createSession"
    | "getSession"
    | "observeSession"
    | "refreshSession"
    | "revokeSession"
  >;
  readonly webOrigin: string;
  readonly secureCookies: boolean;
}

class AuthRequestError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 503) {
    super("authentication failed");
  }
}

function opaqueValue(): string {
  return randomBytes(32).toString("base64url");
}

function baseCookieOptions(secure: boolean, httpOnly: boolean): CookieOptions {
  return {
    secure,
    httpOnly,
    sameSite: "lax",
    path: "/",
  };
}

function setHostCookie(
  response: Response,
  name: string,
  value: string,
  options: CookieOptions,
): void {
  response.cookie(name, value, options);
}

function clearHostCookie(
  response: Response,
  name: string,
  options: CookieOptions,
): void {
  response.clearCookie(name, options);
}

function cookieValue(request: Request, name: string): string | null {
  const value = (request.cookies as Record<string, unknown> | undefined)?.[
    name
  ];
  return typeof value === "string" ? value : null;
}

function exactQuery(
  request: Request,
  expectedFields: readonly string[],
): Readonly<Record<string, string>> {
  const queryIndex = request.originalUrl.indexOf("?");
  const parameters = new URLSearchParams(
    queryIndex < 0 ? "" : request.originalUrl.slice(queryIndex + 1),
  );
  const expected = new Set(expectedFields);
  const values: Record<string, string> = Object.create(null);
  for (const [name, value] of parameters) {
    if (!expected.has(name) || Object.hasOwn(values, name)) {
      throw new AuthRequestError(400);
    }
    values[name] = value;
  }
  if (Object.keys(values).length !== expectedFields.length) {
    throw new AuthRequestError(400);
  }
  return values;
}

function requireNoQuery(request: Request): void {
  exactQuery(request, []);
}

function fixedOpaqueEqual(left: string, right: string): boolean {
  if (!OPAQUE_PATTERN.test(left) || !OPAQUE_PATTERN.test(right)) {
    return false;
  }
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return (
    leftBytes.byteLength === 32 &&
    rightBytes.byteLength === 32 &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function requireBoundIntrospection(
  claims: PlatformAssertionClaims,
  introspection: Awaited<
    ReturnType<AuthRouteDependencies["platform"]["introspect"]>
  >,
): asserts introspection is Extract<typeof introspection, { active: true }> {
  if (
    !introspection.active ||
    introspection.accountId !== claims.sub ||
    introspection.sessionId !== claims.sid ||
    introspection.installationId !== claims.installation_id
  ) {
    throw new AuthRequestError(400);
  }
}

function statusFor(error: unknown): 400 | 503 {
  if (
    error instanceof PlatformAuthUnavailableError ||
    error instanceof TfSessionStoreUnavailableError
  ) {
    return 503;
  }
  if (error instanceof AuthRequestError && error.status === 400) {
    return 400;
  }
  return 503;
}

function sendAuthenticationError(
  response: Response,
  status: 400 | 401 | 403 | 503,
): void {
  if (status === 401) {
    response.status(401).json({ error: "unauthorized" });
    return;
  }
  if (status === 403) {
    response.status(403).json({ error: "forbidden" });
    return;
  }
  response.status(status).json({
    error:
      status === 503 ? "authentication_unavailable" : "authentication_failed",
  });
}

export function createAuthRouter(dependencies: AuthRouteDependencies): Router {
  const router = Router();
  const httpOnlyCookie = baseCookieOptions(dependencies.secureCookies, true);
  const csrfCookie = baseCookieOptions(dependencies.secureCookies, false);

  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  router.get("/start", async (request, response) => {
    try {
      requireNoQuery(request);
      const existingInstallation = cookieValue(
        request,
        AUTH_COOKIE_NAMES.installation,
      );
      const installationId =
        existingInstallation !== null && UUID_PATTERN.test(existingInstallation)
          ? existingInstallation
          : randomUUID();
      const state = opaqueValue();
      const nonce = opaqueValue();
      const codeVerifier = opaqueValue();
      const transactionHandle =
        await dependencies.sessionStore.createTransaction({
          state,
          nonce,
          codeVerifier,
          installationId,
          installationLabel: INSTALLATION_LABEL,
        });
      const codeChallenge = createHash("sha256")
        .update(codeVerifier, "ascii")
        .digest("base64url");
      const location = dependencies.platform.createAuthorizationUrl({
        codeChallenge,
        state,
        nonce,
        installationId,
        installationLabel: INSTALLATION_LABEL,
      });

      setHostCookie(response, AUTH_COOKIE_NAMES.installation, installationId, {
        ...httpOnlyCookie,
        maxAge: INSTALLATION_MAX_AGE_MS,
      });
      setHostCookie(
        response,
        AUTH_COOKIE_NAMES.transaction,
        transactionHandle,
        {
          ...httpOnlyCookie,
          maxAge: TRANSACTION_MAX_AGE_MS,
        },
      );
      response.redirect(303, location);
    } catch (error) {
      sendAuthenticationError(response, statusFor(error));
    }
  });

  router.get("/callback", async (request, response) => {
    try {
      const transactionHandle = cookieValue(
        request,
        AUTH_COOKIE_NAMES.transaction,
      );
      if (
        transactionHandle === null ||
        !OPAQUE_PATTERN.test(transactionHandle)
      ) {
        throw new AuthRequestError(400);
      }
      const transaction =
        await dependencies.sessionStore.consumeTransaction(transactionHandle);
      if (transaction === null) {
        throw new AuthRequestError(400);
      }
      const query = exactQuery(request, ["code", "state"]);
      const code = query.code!;
      const state = query.state!;
      if (
        !CODE_PATTERN.test(code) ||
        !OPAQUE_PATTERN.test(state) ||
        !fixedOpaqueEqual(transaction.state, state)
      ) {
        throw new AuthRequestError(400);
      }
      const exchange = await dependencies.platform.exchangeCode({
        code,
        codeVerifier: transaction.codeVerifier,
        expectedNonce: transaction.nonce,
      });
      const introspection = await dependencies.platform.introspect({
        accountId: exchange.claims.sub,
        sessionId: exchange.claims.sid,
        installationId: exchange.claims.installation_id,
        audience: "apollo-tf",
      });
      requireBoundIntrospection(exchange.claims, introspection);
      const created = await dependencies.sessionStore.createSession({
        assertionClaims: exchange.claims,
        introspection,
      });
      const sessionMaxAge = Date.parse(created.session.expiresAt) - Date.now();
      if (!Number.isFinite(sessionMaxAge) || sessionMaxAge < 1) {
        throw new AuthRequestError(400);
      }
      const csrf = opaqueValue();
      clearHostCookie(response, AUTH_COOKIE_NAMES.transaction, httpOnlyCookie);
      setHostCookie(response, AUTH_COOKIE_NAMES.session, created.handle, {
        ...httpOnlyCookie,
        maxAge: sessionMaxAge,
      });
      setHostCookie(response, AUTH_COOKIE_NAMES.csrf, csrf, {
        ...csrfCookie,
        maxAge: sessionMaxAge,
      });
      response.redirect(303, dependencies.webOrigin);
    } catch (error) {
      clearHostCookie(response, AUTH_COOKIE_NAMES.transaction, httpOnlyCookie);
      sendAuthenticationError(response, statusFor(error));
    }
  });

  router.get("/me", async (request, response) => {
    const handle = cookieValue(request, AUTH_COOKIE_NAMES.session);
    if (handle === null || !OPAQUE_PATTERN.test(handle)) {
      sendAuthenticationError(response, 401);
      return;
    }
    try {
      const session = await dependencies.sessionStore.getSession(handle);
      if (session === null) {
        sendAuthenticationError(response, 401);
        return;
      }
      response.json({
        accountId: session.accountId,
        installationId: session.installationId,
        entitlements: session.entitlements,
        expiresAt: session.expiresAt,
      });
    } catch {
      sendAuthenticationError(response, 503);
    }
  });

  router.post("/logout", async (request, response) => {
    const origin = request.get("origin");
    const csrfHeader = request.get("x-csrf-token");
    const csrf = cookieValue(request, AUTH_COOKIE_NAMES.csrf);
    const handle = cookieValue(request, AUTH_COOKIE_NAMES.session);
    if (
      origin !== dependencies.webOrigin ||
      csrfHeader === undefined ||
      csrf === null ||
      !fixedOpaqueEqual(csrfHeader, csrf) ||
      handle === null ||
      !OPAQUE_PATTERN.test(handle)
    ) {
      sendAuthenticationError(response, 403);
      return;
    }

    let status: 204 | 503 = 204;
    try {
      await dependencies.sessionStore.revokeSession(handle);
    } catch {
      status = 503;
    }
    clearHostCookie(response, AUTH_COOKIE_NAMES.session, httpOnlyCookie);
    clearHostCookie(response, AUTH_COOKIE_NAMES.csrf, csrfCookie);
    clearHostCookie(response, AUTH_COOKIE_NAMES.transaction, httpOnlyCookie);
    if (status === 503) {
      sendAuthenticationError(response, 503);
      return;
    }
    response.status(204).end();
  });

  return router;
}
