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
import type { Account, AuthSession, PlatformRepository } from "./repository.js";
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

function invalidCredentials(): never {
  throw platformDomainError("invalid_credentials");
}

function activeCapabilities(capabilities: readonly string[]): string[] {
  return capabilities
    .filter((capability) => ACTIVE_OPERATOR_CAPABILITIES.has(capability))
    .sort();
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

    try {
      const passwordHash = await hashPassword(parsedInput.data.password);
      return await this.transaction(this.pool, async (client) => {
        const settings = await this.repository.lockRegistrationSettings(client);
        if (
          settings === null ||
          settings.operatorBootstrapAccountId !== null ||
          settings.operatorBootstrapCompletedAt !== null
        ) {
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
        if (candidate === null) {
          invalidCredentials();
        }
        await setAccountContext(client, candidate.id);
        const account = await this.repository.lockAccountById(
          client,
          candidate.id,
        );
        if (account === null || account.status !== "active") {
          invalidCredentials();
        }
        const credential = await this.repository.findCredentialByAccountId(
          client,
          account.id,
        );
        if (credential === null) {
          invalidCredentials();
        }
        const verification = await verifyPassword(
          credential.passwordHash,
          parsedInput.data.password,
        );
        if (!verification.valid) {
          invalidCredentials();
        }
        const capabilities = activeCapabilities(
          await this.repository.listOperatorCapabilities(client, account.id),
        );
        if (capabilities.length === 0) {
          invalidCredentials();
        }
        const now = this.clock();
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
        const capabilities = activeCapabilities(
          await this.repository.listOperatorCapabilities(
            client,
            session.accountId,
          ),
        );
        const now = this.clock();
        if (
          session.audience !== APOLLO_ADMIN_AUDIENCE ||
          session.revokedAt !== null ||
          session.expiresAt.getTime() <= now.getTime() ||
          account === null ||
          account.status !== "active" ||
          capabilities.length === 0
        ) {
          invalidCredentials();
        }
        return {
          accountId: account.id,
          sessionId: session.id,
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
        const capabilities = activeCapabilities(
          await this.repository.listOperatorCapabilities(
            client,
            session.accountId,
          ),
        );
        const now = this.clock();
        if (
          session.audience !== APOLLO_ADMIN_AUDIENCE ||
          session.revokedAt !== null ||
          session.expiresAt.getTime() <= now.getTime() ||
          account === null ||
          account.status !== "active" ||
          capabilities.length === 0
        ) {
          invalidCredentials();
        }
        const previousValue = publicSessionValue(session);
        const revoked = await this.repository.revokeSession(client, {
          sessionId: session.id,
          revokedAt: now,
        });
        if (revoked === null) {
          invalidCredentials();
        }
        await appendAuditEvent(this.repository, client, {
          actorAccountId: account.id,
          targetType: "auth_session",
          targetId: session.id,
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
