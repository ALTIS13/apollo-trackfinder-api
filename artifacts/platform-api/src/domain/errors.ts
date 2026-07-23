import type { PlatformErrorCode } from "@workspace/platform-contract";

export const PLATFORM_DOMAIN_ERROR_MESSAGES: Readonly<
  Record<PlatformErrorCode, string>
> = Object.freeze({
  registration_not_available: "Registration is not available.",
  invitation_not_available: "Invitation registration is not available.",
  invalid_credentials: "Credentials are invalid.",
  module_access_denied: "Module access is denied.",
  policy_unavailable: "Policy is unavailable.",
});

export class PlatformDomainError extends Error {
  readonly code: PlatformErrorCode;

  constructor(code: PlatformErrorCode) {
    super(PLATFORM_DOMAIN_ERROR_MESSAGES[code]);
    this.code = code;
    Object.freeze(this);
  }
}

export function platformDomainError(
  code: PlatformErrorCode,
): PlatformDomainError {
  return new PlatformDomainError(code);
}

export function invalidCredentialsError(): PlatformDomainError {
  return platformDomainError("invalid_credentials");
}

function isRepositoryConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "conflict"
  );
}

export function mapDomainError(
  error: unknown,
  conflictCode?: PlatformErrorCode,
): PlatformDomainError {
  if (error instanceof PlatformDomainError) {
    return error;
  }
  if (conflictCode !== undefined && isRepositoryConflict(error)) {
    return platformDomainError(conflictCode);
  }
  return platformDomainError("policy_unavailable");
}
