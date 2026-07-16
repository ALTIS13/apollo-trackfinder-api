import { timingSafeEqual } from "node:crypto";

import type { OperatorSessionRequest } from "@workspace/platform-contract";
import { operatorSessionRequestSchema } from "@workspace/platform-contract";
import {
  setAccountContext,
  withPlatformTransaction,
} from "@workspace/platform-db";
import type { Pool } from "pg";
import { z } from "zod";

import {
  appendAuditEvent,
  AUDIT_ACTIONS,
  SYSTEM_AUDIT_REASONS,
} from "./audit.js";
import { mapDomainError, platformDomainError } from "./errors.js";
import type {
  Account,
  AuthSession,
  Credential,
  PlatformRepository,
} from "./repository.js";
import type {
  Clock,
  PlatformTransaction,
  RequestContext,
} from "./registration.js";
import {
  digestOpaqueToken,
  hashPassword,
  issueOpaqueToken,
  normalizeEmail,
  type PasswordVerificationResult,
  verifyPassword,
} from "./security.js";

export const APOLLO_ADMIN_AUDIENCE = "apollo-admin";
export const OPERATOR_CAPABILITIES = Object.freeze([
  "platform.registration.manage",
  "platform.invitations.manage",
  "platform.accounts.manage",
  "platform.entitlements.manage",
] as const);

const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const ACTIVE_OPERATOR_CAPABILITIES = new Set<string>(OPERATOR_CAPABILITIES);
const OPERATOR_LOGIN_DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$dCrSSBd7zISZ/iAdFIAZgw$QcKE8JgsrSf9rUzxW1Xw7mwoOWF4GwOfsLjWeZVEwGQ";

const requestContextSchema = z
  .object({ correlationId: z.string().uuid() })
  .strict();

const bootstrapInputSchema = z
  .object({
    bootstrapToken: z.string().min(1),
    email: z.string().trim().toLowerCase().email(),
    displayName: z.string().trim().min(1),
    password: z.string().min(1),
    reason: z.string().trim().min(1),
  })
  .strict();

const exactSessionTokenSchema = z.string().min(1);

export interface BootstrapOperatorInput {
  readonly bootstrapToken: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly reason: string;
}

export interface OperatorSessionResult {
  readonly account: Account;
  readonly session: AuthSession;
  readonly rawToken: string;
}

export interface AuthenticatedOperator {
  readonly accountId: string;
  readonly sessionId: string;
  readonly capabilities: readonly string[];
}

export interface OperatorPasswordVerification {
  readonly verify: (
    hash: string,
    password: string,
  ) => Promise<PasswordVerificationResult>;
  readonly dummyHash: string;
}

const DEFAULT_PASSWORD_VERIFICATION: OperatorPasswordVerification =
  Object.freeze({
    verify: verifyPassword,
    dummyHash: OPERATOR_LOGIN_DUMMY_PASSWORD_HASH,
  });

function invalidCredentials(): never {
  throw platformDomainError("invalid_credentials");
}

function activeCapabilities(capabilities: readonly string[]): string[] {
  return capabilities
    .filter((capability) => ACTIVE_OPERATOR_CAPABILITIES.has(capability))
    .sort();
}

function policyUnavailable(): never {
  throw platformDomainError("policy_unavailable");
}

function finiteClockValue(clock: Clock): Date {
  const now = clock();
  if (!Number.isFinite(now.getTime())) {
    policyUnavailable();
  }
  return now;
}

function sessionDatesAreFinite(session: AuthSession): boolean {
  return (
    Number.isFinite(session.expiresAt.getTime()) &&
    (session.revokedAt === null || Number.isFinite(session.revokedAt.getTime()))
  );
}

function bootstrapReasonContainsSecret(
  input: Readonly<{
    bootstrapToken: string;
    email: string;
    password: string;
    reason: string;
  }>,
): boolean {
  return (
    input.reason.includes(input.bootstrapToken) ||
    input.reason.includes(input.password) ||
    input.reason.toLowerCase().includes(normalizeEmail(input.email))
  );
}

function publicSessionValue(session: AuthSession) {
  return {
    audience: session.audience,
    expiresAt: session.expiresAt.toISOString(),
    revokedAt: session.revokedAt?.toISOString() ?? null,
  };
}

export class OperatorSessionService {
  private readonly bootstrapTokenDigest: Buffer | null;

  constructor(
    private readonly pool: Pool,
    private readonly repository: PlatformRepository,
    configuredBootstrapToken: string | undefined,
    private readonly clock: Clock,
    private readonly transaction: PlatformTransaction = withPlatformTransaction,
    private readonly passwordVerification: OperatorPasswordVerification = DEFAULT_PASSWORD_VERIFICATION,
  ) {
    this.bootstrapTokenDigest =
      configuredBootstrapToken === undefined ||
      configuredBootstrapToken.length === 0
        ? null
        : Buffer.from(digestOpaqueToken(configuredBootstrapToken), "hex");
  }

  async bootstrap(
    input: BootstrapOperatorInput,
    context: RequestContext,
  ): Promise<Account> {
    if (this.bootstrapTokenDigest === null) {
      throw platformDomainError("policy_unavailable");
    }
    const parsedInput = bootstrapInputSchema.safeParse(input);
    const parsedContext = requestContextSchema.safeParse(context);
    if (!parsedInput.success || !parsedContext.success) {
      invalidCredentials();
    }
    const suppliedDigest = Buffer.from(
      digestOpaqueToken(parsedInput.data.bootstrapToken),
      "hex",
    );
    if (!timingSafeEqual(this.bootstrapTokenDigest, suppliedDigest)) {
      invalidCredentials();
    }
    if (bootstrapReasonContainsSecret(parsedInput.data)) {
      invalidCredentials();
    }

    try {
      const passwordHash = await hashPassword(parsedInput.data.password);
      return await this.transaction(this.pool, async (client) => {
        const settings = await this.repository.lockRegistrationSettings(client);
        if (settings === null) {
          policyUnavailable();
        }
        if (
          (settings.operatorBootstrapAccountId === null) !==
          (settings.operatorBootstrapCompletedAt === null)
        ) {
          policyUnavailable();
        }
        if (settings.operatorBootstrapAccountId !== null) {
          invalidCredentials();
        }
        const now = this.clock();
        const created = await this.repository.createAccount(client, {
          normalizedEmail: normalizeEmail(parsedInput.data.email),
          displayName: parsedInput.data.displayName,
        });
        await setAccountContext(client, created.id);
        await this.repository.createCredential(client, {
          accountId: created.id,
          passwordHash,
          passwordChangedAt: now,
        });
        await this.repository.markAccountEmailVerified(client, {
          accountId: created.id,
          verifiedAt: now,
        });
        const activated = await this.repository.updateAccountStatus(client, {
          accountId: created.id,
          status: "active",
          changedAt: now,
        });
        await this.repository.insertOperatorCapabilities(client, {
          accountId: created.id,
          capabilities: OPERATOR_CAPABILITIES,
          grantedByAccountId: null,
          reason: parsedInput.data.reason,
        });
        await appendAuditEvent(this.repository, client, {
          actorAccountId: null,
          targetType: "account",
          targetId: created.id,
          action: AUDIT_ACTIONS.operatorBootstrapCompleted,
          correlationId: parsedContext.data.correlationId,
          reason: parsedInput.data.reason,
          previousValue: null,
          newValue: {
            status: "active",
            emailVerified: true,
            capabilities: [...OPERATOR_CAPABILITIES].sort(),
          },
        });
        return activated;
      });
    } catch (error) {
      throw mapDomainError(error, "invalid_credentials");
    }
  }

  async login(
    input: OperatorSessionRequest,
    context: RequestContext,
  ): Promise<OperatorSessionResult> {
    const parsedInput = operatorSessionRequestSchema.safeParse(input);
    const parsedContext = requestContextSchema.safeParse(context);
    if (!parsedInput.success || !parsedContext.success) {
      invalidCredentials();
    }

    try {
      return await this.transaction(this.pool, async (client) => {
        const candidate = await this.repository.findAccountByNormalizedEmail(
          client,
          normalizeEmail(parsedInput.data.email),
        );
        let account: Account | null = null;
        let credential: Credential | null = null;
        let capabilities: string[] = [];
        if (candidate !== null) {
          await setAccountContext(client, candidate.id);
          account = await this.repository.lockAccountById(client, candidate.id);
          credential = await this.repository.findCredentialByAccountId(
            client,
            candidate.id,
          );
          capabilities = activeCapabilities(
            await this.repository.listOperatorCapabilities(
              client,
              candidate.id,
            ),
          );
        }

        const credentialIsConsistent =
          credential === null ||
          (candidate !== null && credential.accountId === candidate.id);
        const verification = await this.passwordVerification.verify(
          credential !== null && credentialIsConsistent
            ? credential.passwordHash
            : this.passwordVerification.dummyHash,
          parsedInput.data.password,
        );
        if (
          candidate !== null &&
          ((account !== null && account.id !== candidate.id) ||
            !credentialIsConsistent)
        ) {
          policyUnavailable();
        }
        if (
          candidate === null ||
          account === null ||
          account.status !== "active" ||
          credential === null ||
          !verification.valid ||
          capabilities.length === 0
        ) {
          invalidCredentials();
        }
        const now = finiteClockValue(this.clock);
        if (verification.needsRehash) {
          await this.repository.updateCredential(client, {
            accountId: account.id,
            passwordHash: await hashPassword(parsedInput.data.password),
            passwordChangedAt: now,
          });
        }
        const token = issueOpaqueToken(32);
        const rotatedSessionCount =
          await this.repository.revokeSessionsForAccountByAudience(client, {
            accountId: account.id,
            audience: APOLLO_ADMIN_AUDIENCE,
            revokedAt: now,
          });
        const session = await this.repository.createSession(client, {
          accountId: account.id,
          installationId: null,
          sessionDigest: token.digest,
          audience: APOLLO_ADMIN_AUDIENCE,
          expiresAt: new Date(now.getTime() + ADMIN_SESSION_TTL_MS),
        });
        await appendAuditEvent(this.repository, client, {
          actorAccountId: account.id,
          targetType: "auth_session",
          targetId: session.id,
          action: AUDIT_ACTIONS.operatorSessionCreated,
          correlationId: parsedContext.data.correlationId,
          reason: SYSTEM_AUDIT_REASONS.operatorLogin,
          previousValue: null,
          newValue: {
            ...publicSessionValue(session),
            rotatedSessionCount,
          },
        });
        return { account, session, rawToken: token.raw };
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async authenticate(rawToken: string): Promise<AuthenticatedOperator> {
    const parsedToken = exactSessionTokenSchema.safeParse(rawToken);
    if (!parsedToken.success) {
      invalidCredentials();
    }
    const digest = digestOpaqueToken(parsedToken.data);

    try {
      return await this.transaction(this.pool, async (client) => {
        const session = await this.repository.findSessionByDigest(
          client,
          digest,
        );
        if (session === null) {
          invalidCredentials();
        }
        await setAccountContext(client, session.accountId);
        const account = await this.repository.lockAccountById(
          client,
          session.accountId,
        );
        const freshSession = await this.repository.lockSessionByDigest(
          client,
          digest,
        );
        if (
          (account !== null && account.id !== session.accountId) ||
          freshSession === null ||
          freshSession.id !== session.id ||
          freshSession.accountId !== session.accountId ||
          !sessionDatesAreFinite(freshSession)
        ) {
          policyUnavailable();
        }
        const capabilities = activeCapabilities(
          await this.repository.listOperatorCapabilities(
            client,
            freshSession.accountId,
          ),
        );
        const now = finiteClockValue(this.clock);
        if (
          freshSession.audience !== APOLLO_ADMIN_AUDIENCE ||
          freshSession.revokedAt !== null ||
          freshSession.expiresAt.getTime() <= now.getTime() ||
          account === null ||
          account.status !== "active" ||
          capabilities.length === 0
        ) {
          invalidCredentials();
        }
        return {
          accountId: account.id,
          sessionId: freshSession.id,
          capabilities,
        };
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async revoke(rawToken: string, context: RequestContext): Promise<void> {
    const parsedToken = exactSessionTokenSchema.safeParse(rawToken);
    const parsedContext = requestContextSchema.safeParse(context);
    if (!parsedToken.success || !parsedContext.success) {
      invalidCredentials();
    }
    const digest = digestOpaqueToken(parsedToken.data);

    try {
      await this.transaction(this.pool, async (client) => {
        const session = await this.repository.findSessionByDigest(
          client,
          digest,
        );
        if (session === null) {
          invalidCredentials();
        }
        await setAccountContext(client, session.accountId);
        const account = await this.repository.lockAccountById(
          client,
          session.accountId,
        );
        const freshSession = await this.repository.lockSessionByDigest(
          client,
          digest,
        );
        if (
          (account !== null && account.id !== session.accountId) ||
          freshSession === null ||
          freshSession.id !== session.id ||
          freshSession.accountId !== session.accountId ||
          !sessionDatesAreFinite(freshSession)
        ) {
          policyUnavailable();
        }
        const capabilities = activeCapabilities(
          await this.repository.listOperatorCapabilities(
            client,
            freshSession.accountId,
          ),
        );
        const now = finiteClockValue(this.clock);
        if (
          freshSession.audience !== APOLLO_ADMIN_AUDIENCE ||
          freshSession.revokedAt !== null ||
          freshSession.expiresAt.getTime() <= now.getTime() ||
          account === null ||
          account.status !== "active" ||
          capabilities.length === 0
        ) {
          invalidCredentials();
        }
        const previousValue = publicSessionValue(freshSession);
        const revoked = await this.repository.revokeSession(client, {
          sessionId: freshSession.id,
          revokedAt: now,
        });
        if (revoked === null) {
          invalidCredentials();
        }
        if (
          revoked.id !== freshSession.id ||
          revoked.accountId !== freshSession.accountId ||
          revoked.revokedAt === null ||
          !sessionDatesAreFinite(revoked)
        ) {
          policyUnavailable();
        }
        await appendAuditEvent(this.repository, client, {
          actorAccountId: account.id,
          targetType: "auth_session",
          targetId: freshSession.id,
          action: AUDIT_ACTIONS.operatorSessionRevoked,
          correlationId: parsedContext.data.correlationId,
          reason: SYSTEM_AUDIT_REASONS.operatorLogout,
          previousValue,
          newValue: publicSessionValue(revoked),
        });
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }
}
