import {
  changeEntitlementRequestSchema,
  type ChangeEntitlementRequest,
} from "@workspace/platform-contract";
import {
  setAccountContext,
  withPlatformTransaction,
} from "@workspace/platform-db";
import type { Pool } from "pg";
import { z } from "zod";

import { appendAuditEvent, AUDIT_ACTIONS } from "./audit.js";
import { mapDomainError, platformDomainError } from "./errors.js";
import type {
  AccountEntitlement,
  PlatformModule,
  PlatformRepository,
} from "./repository.js";
import type {
  Clock,
  OperatorContext,
  PlatformTransaction,
} from "./registration.js";

const operatorContextSchema = z
  .object({
    accountId: z.string().uuid(),
    correlationId: z.string().uuid(),
  })
  .strict();

const listEffectiveInputSchema = z
  .object({ accountId: z.string().uuid(), now: z.date() })
  .strict();

function moduleAccessDenied(): never {
  throw platformDomainError("module_access_denied");
}

function requireActiveModule(
  modules: readonly PlatformModule[],
  moduleKey: string,
): PlatformModule {
  if (
    modules.length !== 1 ||
    modules[0]?.moduleKey !== moduleKey ||
    modules[0].state !== "active"
  ) {
    moduleAccessDenied();
  }
  return modules[0];
}

function publicEntitlementValue(entitlement: AccountEntitlement) {
  return {
    accountId: entitlement.accountId,
    moduleKey: entitlement.moduleKey,
    expiresAt: entitlement.expiresAt?.toISOString() ?? null,
    revokedAt: entitlement.revokedAt?.toISOString() ?? null,
    source: entitlement.source,
  };
}

function isMutableAccountStatus(status: string): boolean {
  return status === "pending" || status === "active";
}

export class EntitlementService {
  constructor(
    private readonly pool: Pool,
    private readonly repository: PlatformRepository,
    private readonly clock: Clock,
    private readonly transaction: PlatformTransaction = withPlatformTransaction,
  ) {}

  async grant(
    input: ChangeEntitlementRequest,
    operator: OperatorContext,
  ): Promise<AccountEntitlement> {
    const parsedInput = changeEntitlementRequestSchema.safeParse(input);
    const parsedOperator = operatorContextSchema.safeParse(operator);
    if (!parsedInput.success || !parsedOperator.success) {
      throw platformDomainError("policy_unavailable");
    }

    try {
      return await this.transaction(this.pool, async (client) => {
        await setAccountContext(client, parsedInput.data.accountId);
        const account = await this.repository.lockAccountById(
          client,
          parsedInput.data.accountId,
        );
        if (account === null || !isMutableAccountStatus(account.status)) {
          moduleAccessDenied();
        }
        const module = requireActiveModule(
          await this.repository.findModulesByKeys(client, [
            parsedInput.data.moduleKey,
          ]),
          parsedInput.data.moduleKey,
        );
        const existing = (
          await this.repository.listAccountEntitlements(client, account.id)
        ).find((entitlement) => entitlement.moduleId === module.id);
        const now = this.clock();
        const expiresAt =
          parsedInput.data.expiresAt === undefined
            ? null
            : new Date(parsedInput.data.expiresAt);
        if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
          moduleAccessDenied();
        }
        const granted = await this.repository.upsertAccountEntitlement(client, {
          accountId: account.id,
          moduleId: module.id,
          expiresAt,
          source: "operator",
          grantedByAccountId: parsedOperator.data.accountId,
          reason: parsedInput.data.reason,
        });
        await appendAuditEvent(this.repository, client, {
          actorAccountId: parsedOperator.data.accountId,
          targetType: "account_entitlement",
          targetId: granted.id,
          action: AUDIT_ACTIONS.entitlementGranted,
          correlationId: parsedOperator.data.correlationId,
          reason: parsedInput.data.reason,
          previousValue:
            existing === undefined ? null : publicEntitlementValue(existing),
          newValue: publicEntitlementValue(granted),
        });
        return granted;
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async revoke(
    input: ChangeEntitlementRequest,
    operator: OperatorContext,
  ): Promise<AccountEntitlement> {
    const parsedInput = changeEntitlementRequestSchema.safeParse(input);
    const parsedOperator = operatorContextSchema.safeParse(operator);
    if (!parsedInput.success || !parsedOperator.success) {
      throw platformDomainError("policy_unavailable");
    }

    try {
      return await this.transaction(this.pool, async (client) => {
        await setAccountContext(client, parsedInput.data.accountId);
        const account = await this.repository.lockAccountById(
          client,
          parsedInput.data.accountId,
        );
        if (account === null || !isMutableAccountStatus(account.status)) {
          moduleAccessDenied();
        }
        const module = requireActiveModule(
          await this.repository.findModulesByKeys(client, [
            parsedInput.data.moduleKey,
          ]),
          parsedInput.data.moduleKey,
        );
        const existing = (
          await this.repository.listAccountEntitlements(client, account.id)
        ).find((entitlement) => entitlement.moduleId === module.id);
        const now = this.clock();
        if (existing === undefined || existing.revokedAt !== null) {
          moduleAccessDenied();
        }
        const previousValue = publicEntitlementValue(existing);
        const revoked = await this.repository.revokeAccountEntitlement(client, {
          accountId: account.id,
          moduleId: module.id,
          revokedAt: now,
          reason: parsedInput.data.reason,
        });
        if (revoked === null) {
          moduleAccessDenied();
        }
        await appendAuditEvent(this.repository, client, {
          actorAccountId: parsedOperator.data.accountId,
          targetType: "account_entitlement",
          targetId: revoked.id,
          action: AUDIT_ACTIONS.entitlementRevoked,
          correlationId: parsedOperator.data.correlationId,
          reason: parsedInput.data.reason,
          previousValue,
          newValue: publicEntitlementValue(revoked),
        });
        return revoked;
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async listEffective(
    accountId: string,
    now: Date,
  ): Promise<readonly AccountEntitlement[]> {
    const parsed = listEffectiveInputSchema.safeParse({ accountId, now });
    if (!parsed.success || !Number.isFinite(parsed.data.now.getTime())) {
      throw platformDomainError("policy_unavailable");
    }

    try {
      return await this.transaction(this.pool, async (client) => {
        await setAccountContext(client, parsed.data.accountId);
        return (
          await this.repository.listAccountEntitlements(
            client,
            parsed.data.accountId,
          )
        )
          .filter(
            (entitlement) =>
              entitlement.moduleState === "active" &&
              entitlement.revokedAt === null &&
              (entitlement.expiresAt === null ||
                entitlement.expiresAt.getTime() > parsed.data.now.getTime()),
          )
          .sort((left, right) => left.moduleKey.localeCompare(right.moduleKey));
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }
}
