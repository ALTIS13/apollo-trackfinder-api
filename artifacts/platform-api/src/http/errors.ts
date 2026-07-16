import type { ErrorRequestHandler } from "express";

import { PlatformDomainError } from "../domain/errors.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
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

function domainStatus(code: PlatformDomainError["code"]): number {
  switch (code) {
    case "registration_not_available":
    case "invitation_not_available":
      return 409;
    case "invalid_credentials":
      return 401;
    case "module_access_denied":
      return 403;
    case "policy_unavailable":
      return 503;
  }
}

export const platformErrorHandler: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  _next,
) => {
  const requestId = String(response.locals.requestId ?? "");
  let status = 503;
  let code = "policy_unavailable";

  if (error instanceof PlatformDomainError) {
    status = domainStatus(error.code);
    code = error.code;
  } else if (error instanceof HttpError) {
    status = error.status;
    code = error.code;
  } else if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    status = 413;
    code = "payload_too_large";
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
