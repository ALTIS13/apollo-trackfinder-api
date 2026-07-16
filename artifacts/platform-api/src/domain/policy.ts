import {
  moduleKeySchema,
  PROTECTED_PLATFORM_ROUTES,
  type PolicyDecision,
} from "@workspace/platform-contract";
import {
  setAccountContext,
  withPlatformTransaction,
} from "@workspace/platform-db";
import type { Pool } from "pg";
import { z } from "zod";

import type {
  AccountEntitlement,
  PlatformModule,
  PlatformRepository,
} from "./repository.js";
import type { PlatformTransaction } from "./registration.js";

const evaluateInputSchema = z
  .object({
    accountId: z.string().uuid(),
    sessionId: z.string().uuid(),
    audience: z
      .string()
      .min(1)
      .refine((value) => value === value.trim()),
    requiredModules: z
      .array(moduleKeySchema)
      .min(1)
      .refine((values) => new Set(values).size === values.length),
    now: z.date(),
  })
  .strict();

export interface PolicyEvaluationInput {
  readonly accountId: string;
  readonly sessionId: string;
  readonly audience: string;
  readonly requiredModules: readonly string[];
  readonly now: Date;
}

function policyUnavailable(): PolicyDecision {
  return { allowed: false, code: "policy_unavailable" };
}

function moduleAccessDenied(moduleKeys: readonly string[]): PolicyDecision {
  return {
    allowed: false,
    code: "module_access_denied",
    missingModuleKeys: [...moduleKeys].sort(),
  };
}

function knownModules(
  requested: readonly string[],
  modules: readonly PlatformModule[],
): Map<string, PlatformModule> | null {
  const byKey = new Map(modules.map((module) => [module.moduleKey, module]));
  if (
    byKey.size !== requested.length ||
    requested.some((key) => byKey.get(key)?.state !== "active")
  ) {
    return null;
  }
  return byKey;
}

function entitlementStateIsConsistent(
  requested: ReadonlySet<string>,
  modules: ReadonlyMap<string, PlatformModule>,
  entitlements: readonly AccountEntitlement[],
): boolean {
  const seen = new Set<string>();
  for (const entitlement of entitlements) {
    if (!requested.has(entitlement.moduleKey)) continue;
    const module = modules.get(entitlement.moduleKey);
    if (
      module === undefined ||
      module.id !== entitlement.moduleId ||
      seen.has(entitlement.moduleKey) ||
      (entitlement.expiresAt !== null &&
        !Number.isFinite(entitlement.expiresAt.getTime())) ||
      (entitlement.revokedAt !== null &&
        !Number.isFinite(entitlement.revokedAt.getTime()))
    ) {
      return false;
    }
    seen.add(entitlement.moduleKey);
  }
  return true;
}

export class PolicyService {
  constructor(
    private readonly pool: Pool,
    private readonly repository: PlatformRepository,
    private readonly transaction: PlatformTransaction = withPlatformTransaction,
  ) {}

  async evaluate(input: PolicyEvaluationInput): Promise<PolicyDecision> {
    const parsed = evaluateInputSchema.safeParse(input);
    if (!parsed.success || !Number.isFinite(parsed.data.now.getTime())) {
      return policyUnavailable();
    }
    const requiredModules = [...parsed.data.requiredModules].sort();

    try {
      return await this.transaction(this.pool, async (client) => {
        await setAccountContext(client, parsed.data.accountId);
        const account = await this.repository.lockAccountById(
          client,
          parsed.data.accountId,
        );
        const session = await this.repository.findSessionById(
          client,
          parsed.data.sessionId,
        );
        if (
          session !== null &&
          (!Number.isFinite(session.expiresAt.getTime()) ||
            (session.revokedAt !== null &&
              !Number.isFinite(session.revokedAt.getTime())))
        ) {
          return policyUnavailable();
        }
        const modules = knownModules(
          requiredModules,
          await this.repository.findModulesByKeys(client, requiredModules),
        );
        if (modules === null) {
          return policyUnavailable();
        }
        const entitlements = await this.repository.listAccountEntitlements(
          client,
          parsed.data.accountId,
        );
        const requestedSet = new Set(requiredModules);
        if (
          !entitlementStateIsConsistent(requestedSet, modules, entitlements)
        ) {
          return policyUnavailable();
        }
        if (
          account === null ||
          account.status !== "active" ||
          session === null ||
          session.accountId !== account.id ||
          session.audience !== parsed.data.audience ||
          session.revokedAt !== null ||
          session.expiresAt.getTime() <= parsed.data.now.getTime()
        ) {
          return moduleAccessDenied(requiredModules);
        }
        const liveModuleKeys = new Set(
          entitlements
            .filter(
              (entitlement) =>
                requestedSet.has(entitlement.moduleKey) &&
                entitlement.revokedAt === null &&
                (entitlement.expiresAt === null ||
                  entitlement.expiresAt.getTime() > parsed.data.now.getTime()),
            )
            .map((entitlement) => entitlement.moduleKey),
        );
        const missingModuleKeys = requiredModules.filter(
          (moduleKey) => !liveModuleKeys.has(moduleKey),
        );
        return missingModuleKeys.length === 0
          ? { allowed: true }
          : moduleAccessDenied(missingModuleKeys);
      });
    } catch {
      return policyUnavailable();
    }
  }
}

function canonicalRouteMapping(
  routes: Readonly<Record<string, readonly string[]>>,
): string {
  return JSON.stringify(
    Object.entries(routes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([route, capabilities]) => [route, [...capabilities]]),
  );
}

export function assertProtectedOperatorRoutes(
  registeredProtectedRoutes: Readonly<Record<string, readonly string[]>>,
): void {
  if (
    canonicalRouteMapping(registeredProtectedRoutes) !==
    canonicalRouteMapping(PROTECTED_PLATFORM_ROUTES)
  ) {
    throw new Error("Protected operator route mapping mismatch");
  }
}
