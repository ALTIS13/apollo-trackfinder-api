import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  createInvitationRequestSchema,
  type CreateInvitationRequest,
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
import type {
  Account,
  Invitation,
  InvitationGrant,
  PlatformModule,
  PlatformRepository,
} from "./repository.js";
import type {
  Clock,
  OperatorContext,
  PlatformTransaction,
  RequestContext,
} from "./registration.js";
import {
  digestOpaqueToken,
  hashPassword,
  issueOpaqueToken,
  normalizeEmail,
  normalizeModuleKey,
} from "./security.js";

export type {
  Clock,
  OperatorContext,
  PlatformTransaction,
  RequestContext,
} from "./registration.js";

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;
const INITIAL_GRANT_REASON = "invitation_initial_grant";

type OpaqueTokenIssuer = (
  byteLength: number,
) => ReturnType<typeof issueOpaqueToken>;

const requestContextSchema = z
  .object({ correlationId: z.string().uuid() })
  .strict();

const operatorContextSchema = requestContextSchema.extend({
  accountId: z.string().uuid(),
});

const inspectEmailSchema = z.string().trim().toLowerCase().email();
const exactInvitationTokenSchema = z.string().min(1);

const redeemInvitationSchema = z
  .object({
    invitationToken: exactInvitationTokenSchema,
    email: z.string().trim().toLowerCase().email(),
    displayName: z.string().trim().min(1),
    password: z.string().min(1),
  })
  .strict();

const revokeInvitationSchema = z
  .object({
    invitationId: z.string().uuid(),
    reason: z.string().trim().min(1),
  })
  .strict();

export interface PublicInvitationMetadata {
  readonly id: string;
  readonly expiresAt: Date;
  readonly usesLimit: number;
  readonly usesRemaining: number;
  readonly emailBound: boolean;
  readonly moduleKeys: readonly string[];
}

export interface CreateInvitationResult {
  readonly rawToken: string;
  readonly invitation: PublicInvitationMetadata;
}

export interface RedeemInvitationInput {
  readonly invitationToken: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

export interface RedeemInvitationResult {
  readonly account: Account;
  readonly verificationToken: string;
}

export interface RevokeInvitationRequest {
  readonly invitationId: string;
  readonly reason: string;
}

function requireRequestContext(context: RequestContext): RequestContext {
  const parsed = requestContextSchema.safeParse(context);
  if (!parsed.success) {
    throw platformDomainError("invitation_not_available");
  }
  return parsed.data;
}

function requireOperatorContext(context: OperatorContext): OperatorContext {
  const parsed = operatorContextSchema.safeParse(context);
  if (!parsed.success) {
    throw platformDomainError("policy_unavailable");
  }
  return parsed.data;
}

function normalizeRequestedModuleKeys(
  input: unknown,
): readonly string[] | null {
  if (
    typeof input !== "object" ||
    input === null ||
    !("moduleKeys" in input) ||
    !Array.isArray(input.moduleKeys) ||
    !input.moduleKeys.every((moduleKey) => typeof moduleKey === "string")
  ) {
    return null;
  }

  const normalized = input.moduleKeys.map(normalizeModuleKey);
  if (new Set(normalized).size !== normalized.length) {
    throw platformDomainError("module_access_denied");
  }
  return normalized;
}

function requireCreateInput(input: CreateInvitationRequest) {
  const moduleKeys = normalizeRequestedModuleKeys(input);
  const parsed = createInvitationRequestSchema.safeParse(
    moduleKeys === null ? input : { ...input, moduleKeys },
  );
  if (!parsed.success) {
    throw platformDomainError("policy_unavailable");
  }
  return parsed.data;
}

function requireActiveModules(
  modules: readonly PlatformModule[],
  requestedModuleKeys: readonly string[],
): readonly PlatformModule[] {
  const byKey = new Map(modules.map((module) => [module.moduleKey, module]));
  const resolved = requestedModuleKeys.map((moduleKey) => byKey.get(moduleKey));
  if (
    resolved.some((module) => module === undefined || module.state !== "active")
  ) {
    throw platformDomainError("module_access_denied");
  }
  return (resolved as PlatformModule[]).sort((left, right) =>
    left.moduleKey.localeCompare(right.moduleKey),
  );
}

function moduleKeysFromGrants(
  grants: readonly InvitationGrant[],
): readonly string[] {
  return grants.map(({ moduleKey }) => moduleKey).sort();
}

function publicMetadata(
  invitation: Invitation,
  moduleKeys: readonly string[],
): PublicInvitationMetadata {
  return {
    id: invitation.id,
    expiresAt: invitation.expiresAt,
    usesLimit: invitation.usesLimit,
    usesRemaining: invitation.usesLimit - invitation.usesCount,
    emailBound: invitation.email !== null,
    moduleKeys,
  };
}

function ensureAvailable(
  invitation: Invitation | null,
  now: Date,
  normalizedEmail?: string,
): asserts invitation is Invitation {
  if (
    invitation === null ||
    invitation.revokedAt !== null ||
    invitation.expiresAt.getTime() <= now.getTime() ||
    invitation.usesCount >= invitation.usesLimit ||
    (normalizedEmail !== undefined &&
      invitation.email !== null &&
      invitation.email !== normalizedEmail)
  ) {
    throw platformDomainError("invitation_not_available");
  }
}

async function lockInvitationPolicy(
  repository: PlatformRepository,
  client: PoolClient,
  tokenDigest: string,
  clock: Clock,
): Promise<{ readonly invitation: Invitation | null; readonly now: Date }> {
  const settings = await repository.lockRegistrationSettings(client);
  if (settings === null) {
    throw platformDomainError("policy_unavailable");
  }
  const invitation = await repository.lockInvitationByDigest(
    client,
    tokenDigest,
  );
  const now = clock();
  if (settings.mode !== "invite_only") {
    throw platformDomainError("invitation_not_available");
  }
  return { invitation, now };
}

export class InvitationService {
  constructor(
    private readonly pool: Pool,
    private readonly repository: PlatformRepository,
    private readonly clock: Clock,
    private readonly transaction: PlatformTransaction = withPlatformTransaction,
    private readonly invitationTokenIssuer: OpaqueTokenIssuer = issueOpaqueToken,
  ) {}

  async create(
    input: CreateInvitationRequest,
    operator: OperatorContext,
  ): Promise<CreateInvitationResult> {
    const parsedInput = requireCreateInput(input);
    const parsedOperator = requireOperatorContext(operator);
    const expiresAt = new Date(parsedInput.expiresAt);

    try {
      const issuedToken = this.invitationTokenIssuer(32);
      const invitation = await this.transaction(this.pool, async (client) => {
        const foundModules = await this.repository.findModulesByKeys(
          client,
          parsedInput.moduleKeys,
        );
        const modules = requireActiveModules(
          foundModules,
          parsedInput.moduleKeys,
        );
        const now = this.clock();
        if (expiresAt.getTime() <= now.getTime()) {
          throw platformDomainError("policy_unavailable");
        }

        const created = await this.repository.createInvitation(client, {
          tokenDigest: issuedToken.digest,
          normalizedEmail:
            parsedInput.email === undefined
              ? null
              : normalizeEmail(parsedInput.email),
          expiresAt,
          usesLimit: parsedInput.usesLimit,
          createdByAccountId: parsedOperator.accountId,
          reason: parsedInput.reason,
        });
        await this.repository.addInvitationGrants(client, {
          invitationId: created.id,
          moduleIds: modules.map(({ id }) => id),
        });
        const moduleKeys = modules.map(({ moduleKey }) => moduleKey);
        await appendAuditEvent(this.repository, client, {
          actorAccountId: parsedOperator.accountId,
          targetType: "invitation",
          targetId: created.id,
          action: AUDIT_ACTIONS.invitationCreated,
          correlationId: parsedOperator.correlationId,
          reason: parsedInput.reason,
          previousValue: null,
          newValue: {
            expiresAt: expiresAt.toISOString(),
            usesLimit: created.usesLimit,
            emailBound: created.email !== null,
            moduleKeys,
          },
        });
        return publicMetadata(created, moduleKeys);
      });

      return { rawToken: issuedToken.raw, invitation };
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async inspect(
    rawToken: string,
    email?: string,
  ): Promise<PublicInvitationMetadata> {
    const parsedToken = exactInvitationTokenSchema.safeParse(rawToken);
    const parsedEmail =
      email === undefined ? undefined : inspectEmailSchema.safeParse(email);
    if (
      !parsedToken.success ||
      (parsedEmail !== undefined && !parsedEmail.success)
    ) {
      throw platformDomainError("invitation_not_available");
    }
    const normalizedEmail =
      parsedEmail?.success === true
        ? normalizeEmail(parsedEmail.data)
        : undefined;

    try {
      const tokenDigest = digestOpaqueToken(parsedToken.data);
      return await this.transaction(this.pool, async (client) => {
        const { invitation, now } = await lockInvitationPolicy(
          this.repository,
          client,
          tokenDigest,
          this.clock,
        );
        ensureAvailable(invitation, now, normalizedEmail);
        const grants = await this.repository.listInvitationGrants(
          client,
          invitation.id,
        );
        return publicMetadata(invitation, moduleKeysFromGrants(grants));
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async redeem(
    input: RedeemInvitationInput,
    context: RequestContext,
  ): Promise<RedeemInvitationResult> {
    const parsedInput = redeemInvitationSchema.safeParse(input);
    if (!parsedInput.success) {
      throw platformDomainError("invitation_not_available");
    }
    const parsedContext = requireRequestContext(context);
    const normalizedEmail = normalizeEmail(parsedInput.data.email);

    try {
      const passwordHash = await hashPassword(parsedInput.data.password);
      const verificationToken = issueOpaqueToken(32);
      const invitationDigest = digestOpaqueToken(
        parsedInput.data.invitationToken,
      );

      const account = await this.transaction(this.pool, async (client) => {
        const { invitation, now } = await lockInvitationPolicy(
          this.repository,
          client,
          invitationDigest,
          this.clock,
        );
        ensureAvailable(invitation, now, normalizedEmail);
        const grants = await this.repository.listInvitationGrants(
          client,
          invitation.id,
        );
        const moduleKeys = moduleKeysFromGrants(grants);
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
          expiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS),
        });
        const incremented = await this.repository.incrementInvitationUse(
          client,
          { invitationId: invitation.id, usedAt: now },
        );
        if (incremented === null) {
          throw platformDomainError("invitation_not_available");
        }
        for (const grant of grants) {
          await this.repository.upsertAccountEntitlement(client, {
            accountId: created.id,
            moduleId: grant.moduleId,
            expiresAt: null,
            source: "invitation",
            grantedByAccountId: invitation.createdByAccountId,
            reason: INITIAL_GRANT_REASON,
          });
        }
        await appendAuditEvent(this.repository, client, {
          actorAccountId: null,
          targetType: "invitation",
          targetId: invitation.id,
          action: AUDIT_ACTIONS.invitationRedeemed,
          correlationId: parsedContext.correlationId,
          reason: SYSTEM_AUDIT_REASONS.invitationRedemption,
          previousValue: {
            usesCount: invitation.usesCount,
            usesRemaining: invitation.usesLimit - invitation.usesCount,
          },
          newValue: {
            accountId: created.id,
            status: created.status,
            usesCount: incremented.usesCount,
            usesRemaining: incremented.usesLimit - incremented.usesCount,
            moduleKeys,
          },
        });
        return created;
      });

      return { account, verificationToken: verificationToken.raw };
    } catch (error) {
      throw mapDomainError(error, "invitation_not_available");
    }
  }

  async revoke(
    input: RevokeInvitationRequest,
    operator: OperatorContext,
  ): Promise<PublicInvitationMetadata> {
    const parsedInput = revokeInvitationSchema.safeParse(input);
    if (!parsedInput.success) {
      throw platformDomainError("policy_unavailable");
    }
    const parsedOperator = requireOperatorContext(operator);

    try {
      return await this.transaction(this.pool, async (client) => {
        const now = this.clock();
        const revoked = await this.repository.revokeInvitation(client, {
          invitationId: parsedInput.data.invitationId,
          revokedAt: now,
        });
        if (revoked === null) {
          throw platformDomainError("invitation_not_available");
        }
        const grants = await this.repository.listInvitationGrants(
          client,
          revoked.id,
        );
        const moduleKeys = moduleKeysFromGrants(grants);
        await appendAuditEvent(this.repository, client, {
          actorAccountId: parsedOperator.accountId,
          targetType: "invitation",
          targetId: revoked.id,
          action: AUDIT_ACTIONS.invitationRevoked,
          correlationId: parsedOperator.correlationId,
          reason: parsedInput.data.reason,
          previousValue: { revokedAt: null },
          newValue: { revokedAt: revoked.revokedAt?.toISOString() ?? null },
        });
        return publicMetadata(revoked, moduleKeys);
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }
}
