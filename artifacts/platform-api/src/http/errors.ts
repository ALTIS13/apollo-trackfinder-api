import type { ErrorRequestHandler } from "express";

import { PlatformDomainError } from "../domain/errors.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

export function validationError(): HttpError {
  return new HttpError(400, "validation_failed");
}

export function forbiddenError(): HttpError {
  return new HttpError(403, "module_access_denied");
}

export function rateLimitedError(retryAfterSeconds?: number): HttpError {
  return new HttpError(429, "rate_limited", retryAfterSeconds);
}

const DOMAIN_STATUS: Readonly<Record<PlatformDomainError["code"], number>> =
  Object.freeze({
    registration_not_available: 409,
    invitation_not_available: 409,
    invalid_credentials: 401,
    module_access_denied: 403,
    policy_unavailable: 503,
    invalid_request: 400,
    invalid_client: 401,
    invalid_grant: 400,
    account_access_denied: 403,
  });

function domainStatus(code: PlatformDomainError["code"]): number {
  return DOMAIN_STATUS[code];
}

const BODY_PARSER_PAYLOAD_ERROR_TYPES = new Set([
  "entity.too.large",
  "parameters.too.many",
  "querystring.parse.rangeError",
]);
const BODY_PARSER_VALIDATION_ERROR_TYPES = new Set([
  "charset.unsupported",
  "encoding.unsupported",
  "entity.parse.failed",
  "entity.verify.failed",
  "request.aborted",
  "request.size.invalid",
]);

function bodyParserErrorType(error: unknown): string | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("type" in error) ||
    typeof error.type !== "string"
  ) {
    return null;
  }
  return error.type;
}

export const platformErrorHandler: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  _next,
) => {
  const requestId = String(response.locals.requestId ?? "");
  const parserErrorType = bodyParserErrorType(error);
  let status = 503;
  let code = "policy_unavailable";

  if (error instanceof PlatformDomainError) {
    status = domainStatus(error.code);
    code = error.code;
  } else if (error instanceof HttpError) {
    status = error.status;
    code = error.code;
    if (error.retryAfterSeconds !== undefined) {
      response.setHeader("Retry-After", String(error.retryAfterSeconds));
    }
  } else if (
    parserErrorType !== null &&
    BODY_PARSER_PAYLOAD_ERROR_TYPES.has(parserErrorType)
  ) {
    status = 413;
    code = "payload_too_large";
  } else if (
    parserErrorType !== null &&
    BODY_PARSER_VALIDATION_ERROR_TYPES.has(parserErrorType)
  ) {
    status = 400;
    code = "validation_failed";
  } else if (
    error instanceof SyntaxError ||
    (typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 400)
  ) {
    status = 400;
    code = "validation_failed";
  }

  request.app.locals.logger?.error(
    { requestId, method: request.method, path: request.path, status },
    "request failed",
  );
  response.status(status).json({ error: code, requestId });
};
