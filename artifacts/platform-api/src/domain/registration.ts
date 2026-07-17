import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  changeRegistrationModeRequestSchema,
  createRegistrationRequestSchema,
  type ChangeRegistrationModeRequest,
  type CreateRegistrationRequest,
  type RegistrationStatusResponse,
} from "@workspace/platform-contract";
import {
  setAccountContext,
  withPlatformTransaction,
} from "@workspace/platform-db";

import {
  appendAuditEvent,
  AUDIT_ACTIONS,
  SYSTEM_AUDIT_REASONS,
} from "./audit.js";
import { mapDomainError, platformDomainError } from "./errors.js";
import type { Account, PlatformRepository } from "./repository.js";
import {
  digestOpaqueToken,
  hashPassword,
  issueOpaqueToken,
  normalizeEmail,
} from "./security.js";

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;

const requestContextSchema = z
  .object({ correlationId: z.string().uuid() })
  .strict();

const operatorContextSchema = requestContextSchema.extend({
  accountId: z.string().uuid(),
});

const accountMutationInputSchema = z
  .object({
    accountId: z.string().uuid(),
    reason: z.string().trim().min(1),
  })
  .strict();

const rawVerificationTokenSchema = z.string().min(1);

export interface RequestContext {
  readonly correlationId: string;
}

export interface OperatorContext extends RequestContext {
  readonly accountId: string;
}

export interface AccountMutationInput {
  readonly accountId: string;
  readonly reason: string;
}

export interface RegistrationResult {
  readonly account: Account;
  readonly verificationToken: string;
}

export type Clock = () => Date;

export type PlatformTransaction = <T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
) => Promise<T>;

function requireRequestContext(
  context: RequestContext,
  errorCode: "registration_not_available" | "policy_unavailable",
): z.infer<typeof requestContextSchema> {
  const parsed = requestContextSchema.safeParse(context);
  if (!parsed.success) {
    throw platformDomainError(errorCode);
  }
  return parsed.data;
}

function requireOperatorContext(
  context: OperatorContext,
): z.infer<typeof operatorContextSchema> {
  const parsed = operatorContextSchema.safeParse(context);
  if (!parsed.success) {
    throw platformDomainError("policy_unavailable");
  }
  return parsed.data;
}

function requireAccountMutationInput(
  input: AccountMutationInput,
): z.infer<typeof accountMutationInputSchema> {
  const parsed = accountMutationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw platformDomainError("policy_unavailable");
  }
  return parsed.data;
}

function throwRegistrationUnavailable(): never {
  throw platformDomainError("registration_not_available");
}

export class RegistrationService {
  constructor(
    private readonly pool: Pool,
    private readonly repository: PlatformRepository,
    private readonly clock: Clock,
    private readonly transaction: PlatformTransaction = withPlatformTransaction,
  ) {}

  async getStatus(): Promise<RegistrationStatusResponse> {
    try {
      return await this.transaction(this.pool, async (client) => {
        const settings = await this.repository.getRegistrationSettings(client);
        if (settings === null) {
          throw platformDomainError("policy_unavailable");
        }
        return { mode: settings.mode };
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async changeMode(
    input: ChangeRegistrationModeRequest,
    operator: OperatorContext,
  ): Promise<RegistrationStatusResponse> {
    const parsedInput = changeRegistrationModeRequestSchema.safeParse(input);
    if (!parsedInput.success) {
      throw platformDomainError("policy_unavailable");
    }
    const parsedOperator = requireOperatorContext(operator);

    try {
      return await this.transaction(this.pool, async (client) => {
        const previous = await this.repository.lockRegistrationSettings(client);
        if (previous === null) {
          throw platformDomainError("policy_unavailable");
        }
        const updated = await this.repository.updateRegistrationSettings(
          client,
          {
            mode: parsedInput.data.mode,
            updatedByAccountId: parsedOperator.accountId,
          },
        );
        await appendAuditEvent(this.repository, client, {
          actorAccountId: parsedOperator.accountId,
          targetType: "registration_settings",
          targetId: previous.id,
          action: AUDIT_ACTIONS.registrationModeChanged,
          correlationId: parsedOperator.correlationId,
          reason: parsedInput.data.reason,
          previousValue: { mode: previous.mode, revision: previous.revision },
          newValue: { mode: updated.mode, revision: updated.revision },
        });
        return { mode: updated.mode };
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async register(
    input: CreateRegistrationRequest,
    context: RequestContext,
  ): Promise<RegistrationResult> {
    const parsedInput = createRegistrationRequestSchema.safeParse(input);
    if (!parsedInput.success) {
      throw platformDomainError("registration_not_available");
    }
    const parsedContext = requireRequestContext(
      context,
      "registration_not_available",
    );
    const normalizedEmail = normalizeEmail(parsedInput.data.email);

    try {
      const passwordHash = await hashPassword(parsedInput.data.password);
      const verificationToken = issueOpaqueToken();

      const account = await this.transaction(this.pool, async (client) => {
        const settings = await this.repository.lockRegistrationSettings(client);
        if (settings === null) {
          throw platformDomainError("policy_unavailable");
        }
        if (settings.mode === "closed") {
          throw platformDomainError("registration_not_available");
        }
        if (settings.mode === "invite_only") {
          throw platformDomainError("invitation_not_available");
        }
        const now = this.clock();
        const expiresAt = new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS);

        const created = await this.repository.createAccount(client, {
          normalizedEmail,
          displayName: parsedInput.data.displayName,
        });
        await setAccountContext(client, created.id);
        await this.repository.createCredential(client, {
          accountId: created.id,
          passwordHash,
          passwordChangedAt: now,
        });
        await this.repository.createVerificationToken(client, {
          accountId: created.id,
          tokenDigest: verificationToken.digest,
          expiresAt,
        });
        await appendAuditEvent(this.repository, client, {
          actorAccountId: null,
          targetType: "account",
          targetId: created.id,
          action: AUDIT_ACTIONS.accountRegistered,
          correlationId: parsedContext.correlationId,
          reason: SYSTEM_AUDIT_REASONS.registration,
          previousValue: null,
          newValue: { status: "pending", emailVerified: false },
        });
        return created;
      });

      return { account, verificationToken: verificationToken.raw };
    } catch (error) {
      throw mapDomainError(error, "registration_not_available");
    }
  }

  async consumeVerificationToken(
    rawToken: string,
    context: RequestContext,
  ): Promise<Account> {
    const parsedToken = rawVerificationTokenSchema.safeParse(rawToken);
    if (!parsedToken.success) {
      throw platformDomainError("registration_not_available");
    }
    const parsedContext = requireRequestContext(
      context,
      "registration_not_available",
    );

    try {
      const tokenDigest = digestOpaqueToken(parsedToken.data);
      return await this.transaction(this.pool, async (client) => {
        const token = await this.repository.lockVerificationTokenByDigest(
          client,
          tokenDigest,
        );
        if (token === null || token.consumedAt !== null) {
          throwRegistrationUnavailable();
        }

        await setAccountContext(client, token.accountId);
        const account = await this.repository.lockAccountById(
          client,
          token.accountId,
        );
        const now = this.clock();
        if (
          token.expiresAt.getTime() <= now.getTime() ||
          account === null ||
          account.status !== "pending"
        ) {
          throwRegistrationUnavailable();
        }
        const consumed = await this.repository.consumeVerificationToken(
          client,
          {
            verificationTokenId: token.id,
            consumedAt: now,
          },
        );
        if (consumed === null) {
          throwRegistrationUnavailable();
        }
        const verified = await this.repository.markAccountEmailVerified(
          client,
          {
            accountId: account.id,
            verifiedAt: now,
          },
        );
        await appendAuditEvent(this.repository, client, {
          actorAccountId: null,
          targetType: "account",
          targetId: account.id,
          action: AUDIT_ACTIONS.accountEmailVerified,
          correlationId: parsedContext.correlationId,
          reason: SYSTEM_AUDIT_REASONS.emailVerification,
          previousValue: {
            status: account.status,
            emailVerifiedAt: account.emailVerifiedAt?.toISOString() ?? null,
          },
          newValue: {
            status: verified.status,
            emailVerifiedAt: verified.emailVerifiedAt?.toISOString() ?? null,
          },
        });
        return verified;
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async activateAccount(
    input: AccountMutationInput,
    operator: OperatorContext,
  ): Promise<Account> {
    const parsedInput = requireAccountMutationInput(input);
    const parsedOperator = requireOperatorContext(operator);

    try {
      return await this.transaction(this.pool, async (client) => {
        await setAccountContext(client, parsedInput.accountId);
        const account = await this.repository.lockAccountById(
          client,
          parsedInput.accountId,
        );
        if (
          account === null ||
          account.status !== "pending" ||
          account.emailVerifiedAt === null
        ) {
          throwRegistrationUnavailable();
        }
        const entitlements = await this.repository.listAccountEntitlements(
          client,
          account.id,
        );
        const now = this.clock();
        const hasLiveEntitlement = entitlements.some(
          (entitlement) =>
            entitlement.moduleState === "active" &&
            entitlement.revokedAt === null &&
            (entitlement.expiresAt === null ||
              entitlement.expiresAt.getTime() > now.getTime()),
        );
        if (!hasLiveEntitlement) {
          throwRegistrationUnavailable();
        }
        const activated = await this.repository.updateAccountStatus(client, {
          accountId: account.id,
          status: "active",
          changedAt: now,
        });
        await appendAuditEvent(this.repository, client, {
          actorAccountId: parsedOperator.accountId,
          targetType: "account",
          targetId: account.id,
          action: AUDIT_ACTIONS.accountActivated,
          correlationId: parsedOperator.correlationId,
          reason: parsedInput.reason,
          previousValue: {
            status: account.status,
            activatedAt: account.activatedAt?.toISOString() ?? null,
          },
          newValue: {
            status: activated.status,
            activatedAt: activated.activatedAt?.toISOString() ?? null,
          },
        });
        return activated;
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async suspendAccount(
    input: AccountMutationInput,
    operator: OperatorContext,
  ): Promise<Account> {
    const parsedInput = requireAccountMutationInput(input);
    const parsedOperator = requireOperatorContext(operator);

    try {
      return await this.transaction(this.pool, async (client) => {
        await setAccountContext(client, parsedInput.accountId);
        const account = await this.repository.lockAccountById(
          client,
          parsedInput.accountId,
        );
        if (
          account === null ||
          (account.status !== "pending" && account.status !== "active")
        ) {
          throwRegistrationUnavailable();
        }
        const now = this.clock();
        const suspended = await this.repository.updateAccountStatus(client, {
          accountId: account.id,
          status: "suspended",
          changedAt: now,
        });
        const revokedSessionCount =
          await this.repository.revokeAllSessionsForAccount(client, {
            accountId: account.id,
            revokedAt: now,
          });
        await appendAuditEvent(this.repository, client, {
          actorAccountId: parsedOperator.accountId,
          targetType: "account",
          targetId: account.id,
          action: AUDIT_ACTIONS.accountSuspended,
          correlationId: parsedOperator.correlationId,
          reason: parsedInput.reason,
          previousValue: {
            status: account.status,
            suspendedAt: account.suspendedAt?.toISOString() ?? null,
          },
          newValue: {
            status: suspended.status,
            suspendedAt: suspended.suspendedAt?.toISOString() ?? null,
            revokedSessionCount,
          },
        });
        return suspended;
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }
}
