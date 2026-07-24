import { TextDecoder } from "node:util";

import type { Request, Router } from "express";
import { z } from "zod";

import {
  authorizationCodeExchangeSchema,
  authorizationRequestSchema,
  policyIntrospectionRequestSchema,
} from "@workspace/platform-contract";

import type { AuthorizationService } from "../domain/authorization.js";
import type { PlatformAssertionSigner } from "../domain/assertions.js";
import { platformDomainError } from "../domain/errors.js";
import type { UserSessionService } from "../domain/user-sessions.js";
import { authenticatePortalUser } from "../http/user-auth.js";

const BASIC_HEADER_MAX_BYTES = 2_048;
const BASIC_CLIENT_ID_MAX_CHARACTERS = 128;
const BASIC_CLIENT_SECRET_MAX_CHARACTERS = 512;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const tokenBodySchema = z
  .object({
    grant_type: z.literal("authorization_code"),
    code: z.string(),
    redirect_uri: z.string(),
    code_verifier: z.string(),
  })
  .strict();

const AUTHORIZATION_QUERY_FIELDS = Object.freeze([
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "state",
  "nonce",
  "installation_id",
  "installation_label",
] as const);

export interface OAuthRouteDependencies {
  readonly authorization: Pick<
    AuthorizationService,
    "issueCode" | "exchangeCode" | "introspect"
  >;
  readonly assertionSigner: Pick<PlatformAssertionSigner, "publicJwks">;
  readonly introspectionClientId: string;
  readonly userSessions: Pick<UserSessionService, "authenticate">;
}

interface BasicCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

function invalidRequest(): never {
  throw platformDomainError("invalid_request");
}

function invalidClient(): never {
  throw platformDomainError("invalid_client");
}

function rawAuthorizationHeaders(request: Request): readonly string[] {
  const headers: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "authorization") {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) headers.push(value);
    }
  }
  return headers;
}

export function parseBasicCredentials(request: Request): BasicCredentials {
  const authorizationHeaders = rawAuthorizationHeaders(request);
  if (authorizationHeaders.length !== 1) invalidClient();
  const header = authorizationHeaders[0]!;
  if (
    Buffer.byteLength(header, "utf8") > BASIC_HEADER_MAX_BYTES ||
    !header.startsWith("Basic ")
  ) {
    invalidClient();
  }
  const encoded = header.slice("Basic ".length);
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !CANONICAL_BASE64_PATTERN.test(encoded)
  ) {
    invalidClient();
  }
  let bytes: Buffer;
  let decoded: string;
  try {
    bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) invalidClient();
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidClient();
  }
  const colon = decoded.indexOf(":");
  if (colon < 1 || colon === decoded.length - 1) invalidClient();
  const clientId = decoded.slice(0, colon);
  const clientSecret = decoded.slice(colon + 1);
  if (
    clientId.trim() !== clientId ||
    clientId.length > BASIC_CLIENT_ID_MAX_CHARACTERS ||
    clientSecret.length > BASIC_CLIENT_SECRET_MAX_CHARACTERS
  ) {
    invalidClient();
  }
  return { clientId, clientSecret };
}

function exactSearchParameters(request: Request): URLSearchParams {
  const queryIndex = request.originalUrl.indexOf("?");
  return new URLSearchParams(
    queryIndex < 0 ? "" : request.originalUrl.slice(queryIndex + 1),
  );
}

function parseAuthorizationQuery(request: Request) {
  const parameters = exactSearchParameters(request);
  const expected = new Set<string>(AUTHORIZATION_QUERY_FIELDS);
  const values = new Map<string, string>();
  for (const [name, value] of parameters) {
    if (!expected.has(name) || values.has(name)) invalidRequest();
    values.set(name, value);
  }
  if (values.size !== AUTHORIZATION_QUERY_FIELDS.length) invalidRequest();
  const parsed = authorizationRequestSchema.safeParse({
    clientId: values.get("client_id"),
    redirectUri: values.get("redirect_uri"),
    responseType: values.get("response_type"),
    codeChallenge: values.get("code_challenge"),
    codeChallengeMethod: values.get("code_challenge_method"),
    state: values.get("state"),
    nonce: values.get("nonce"),
    installationId: values.get("installation_id"),
    installationLabel: values.get("installation_label"),
  });
  if (!parsed.success) invalidRequest();
  return parsed.data;
}

function requireNoQueryParameters(request: Request): void {
  if ([...exactSearchParameters(request)].length !== 0) invalidRequest();
}

export function registerOAuthRoutes(
  router: Router,
  dependencies: OAuthRouteDependencies,
): void {
  router.get("/v1/oauth/authorize", async (request, response, next) => {
    try {
      const user = await authenticatePortalUser(
        request,
        dependencies.userSessions,
      );
      if (user.status !== "active") {
        throw platformDomainError("account_access_denied");
      }
      const input = parseAuthorizationQuery(request);
      const issued = await dependencies.authorization.issueCode(user, input, {
        correlationId: String(response.locals.requestId),
      });
      const redirect = new URL(issued.redirectUri);
      redirect.searchParams.set("code", issued.rawCode);
      redirect.searchParams.set("state", issued.state);
      response.status(303).setHeader("Location", redirect.toString());
      response.end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/v1/oauth/token", async (request, response, next) => {
    try {
      requireNoQueryParameters(request);
      const credentials = parseBasicCredentials(request);
      const body = tokenBodySchema.safeParse(request.body);
      if (!body.success) invalidRequest();
      const exchange = authorizationCodeExchangeSchema.safeParse({
        grantType: body.data.grant_type,
        clientId: credentials.clientId,
        code: body.data.code,
        redirectUri: body.data.redirect_uri,
        codeVerifier: body.data.code_verifier,
      });
      if (!exchange.success) invalidRequest();
      const result = await dependencies.authorization.exchangeCode(
        exchange.data,
        credentials.clientSecret,
        { correlationId: String(response.locals.requestId) },
      );
      response.json({
        access_token: result.assertion,
        token_type: result.tokenType,
        expires_in: result.expiresIn,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/v1/oauth/introspect", async (request, response, next) => {
    try {
      requireNoQueryParameters(request);
      const credentials = parseBasicCredentials(request);
      if (credentials.clientId !== dependencies.introspectionClientId) {
        invalidClient();
      }
      const body = policyIntrospectionRequestSchema.safeParse(request.body);
      if (!body.success) invalidRequest();
      response.json(
        await dependencies.authorization.introspect(
          body.data,
          credentials.clientSecret,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/.well-known/jwks.json", (_request, response) => {
    response.setHeader("Cache-Control", "public, max-age=300");
    response.json(dependencies.assertionSigner.publicJwks());
  });
}
