import type { Pool, PoolClient } from "pg";
import { describe, expect, test, vi } from "vitest";

import { EntitlementService } from "./entitlements.js";
import { PlatformDomainError } from "./errors.js";
import type {
  Account,
  AccountEntitlement,
  AuditEvent,
  PlatformModule,
  PlatformRepository,
} from "./repository.js";
import type { PlatformTransaction } from "./registration.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000101";
const OPERATOR_ID = "00000000-0000-4000-8000-000000000102";
const MODULE_ID = "00000000-0000-4000-8000-000000000103";
const CORRELATION_ID = "00000000-0000-4000-8000-000000000104";
const NOW = new Date("2026-07-16T12:00:00.000Z");

interface EntitlementState {
  account: Account | null;
  modules: PlatformModule[];
  entitlements: AccountEntitlement[];
  audits: AuditEvent[];
}

function targetAccount(status: Account["status"] = "pending"): Account {
  return {
    id: ACCOUNT_ID,
    email: "private-target@example.com",
    displayName: "Target Account",
    status,
    emailVerifiedAt: NOW,
    activatedAt: status === "active" ? NOW : null,
    suspendedAt: status === "suspended" ? NOW : null,
    deletedAt: status === "deleted" ? NOW : null,
    createdAt: new Date(NOW.getTime() - 60_000),
    updatedAt: NOW,
  };
}

function platformModule(
  overrides: Partial<PlatformModule> = {},
): PlatformModule {
  return {
    id: MODULE_ID,
    moduleKey: "tf.search",
    product: "trackfinder",
    displayName: "Search",
    state: "active",
    description: "Search access",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function entitlement(
  overrides: Partial<AccountEntitlement> = {},
): AccountEntitlement {
  return {
    id: "00000000-0000-4000-8000-000000000105",
    accountId: ACCOUNT_ID,
    moduleId: MODULE_ID,
    moduleKey: "tf.search",
    expiresAt: null,
    revokedAt: null,
    source: "operator",
    grantedByAccountId: OPERATOR_ID,
    reason: "approved access",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function expectDomainError(error: unknown, code: PlatformDomainError["code"]) {
  expect(error).toBeInstanceOf(PlatformDomainError);
  expect((error as PlatformDomainError).code).toBe(code);
  expect(Object.isFrozen(error)).toBe(true);
  expect(JSON.stringify(error)).not.toContain("private-target@example.com");
}

function createHarness() {
  const timeline: string[] = [];
  const state: EntitlementState = {
    account: targetAccount(),
    modules: [platformModule()],
    entitlements: [],
    audits: [],
  };
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      timeline.push(`query:${text}:${JSON.stringify(values ?? [])}`);
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as PoolClient;
  const repository = {
    lockAccountById: vi.fn(async (_client, accountId: string) => {
      timeline.push("lockAccountById");
      return state.account?.id === accountId ? state.account : null;
    }),
    findModulesByKeys: vi.fn(async (_client, moduleKeys: readonly string[]) => {
      timeline.push("findModulesByKeys");
      return state.modules.filter((candidate) =>
        moduleKeys.includes(candidate.moduleKey),
      );
    }),
    listAccountEntitlements: vi.fn(async (_client, accountId: string) => {
      timeline.push("listAccountEntitlements");
      return state.entitlements.filter(
        (candidate) => candidate.accountId === accountId,
      );
    }),
    upsertAccountEntitlement: vi.fn(async (_client, input) => {
      timeline.push("upsertAccountEntitlement");
      const existing = state.entitlements.find(
        (candidate) =>
          candidate.accountId === input.accountId &&
          candidate.moduleId === input.moduleId,
      );
      if (existing) {
        Object.assign(existing, {
          expiresAt: input.expiresAt,
          revokedAt: null,
          source: input.source,
          grantedByAccountId: input.grantedByAccountId,
          reason: input.reason,
          updatedAt: NOW,
        });
        return existing;
      }
      const created = entitlement({
        accountId: input.accountId,
        moduleId: input.moduleId,
        expiresAt: input.expiresAt,
        source: input.source,
        grantedByAccountId: input.grantedByAccountId,
        reason: input.reason,
      });
      state.entitlements.push(created);
      return created;
    }),
    revokeAccountEntitlement: vi.fn(async (_client, input) => {
      timeline.push("revokeAccountEntitlement");
      const existing = state.entitlements.find(
        (candidate) =>
          candidate.accountId === input.accountId &&
          candidate.moduleId === input.moduleId &&
          candidate.revokedAt === null,
      );
      if (!existing) return null;
      Object.assign(existing, {
        revokedAt: input.revokedAt,
        reason: input.reason,
        updatedAt: input.revokedAt,
      });
      return existing;
    }),
    insertAuditEvent: vi.fn(async (_client, input) => {
      timeline.push("insertAuditEvent");
      const event: AuditEvent = {
        id: `00000000-0000-4000-8000-${String(state.audits.length + 110).padStart(12, "0")}`,
        occurredAt: NOW,
        ...input,
      };
      state.audits.push(event);
      return event;
    }),
  };
  const transaction: PlatformTransaction = async (_pool, callback) => {
    timeline.push("transaction:start");
    const snapshot = structuredClone(state);
    try {
      const result = await callback(client);
      timeline.push("transaction:commit");
      return result;
    } catch (error) {
      Object.assign(state, snapshot);
      timeline.push("transaction:rollback");
      throw error;
    }
  };
  const clock = vi.fn(() => {
    timeline.push("clock");
    return new Date(NOW);
  });
  const service = new EntitlementService(
    {} as Pool,
    repository as unknown as PlatformRepository,
    clock,
    transaction,
  );
  return { service, state, repository, timeline, clock };
}

const operator = { accountId: OPERATOR_ID, correlationId: CORRELATION_ID };

describe("EntitlementService", () => {
  test.each(["pending", "active"] as const)(
    "grants a live module to a %s account with complete redacted audit evidence",
    async (status) => {
      const harness = createHarness();
      harness.state.account = targetAccount(status);
      const expiresAt = new Date(NOW.getTime() + 60_000);

      const granted = await harness.service.grant(
        {
          accountId: ACCOUNT_ID,
          moduleKey: "tf.search",
          expiresAt: expiresAt.toISOString(),
          reason: "Approved by operator",
        },
        operator,
      );

      expect(granted).toMatchObject({
        accountId: ACCOUNT_ID,
        moduleId: MODULE_ID,
        moduleKey: "tf.search",
        expiresAt,
        revokedAt: null,
        source: "operator",
        grantedByAccountId: OPERATOR_ID,
        reason: "Approved by operator",
      });
      expect(harness.state.audits[0]).toMatchObject({
        actorAccountId: OPERATOR_ID,
        targetType: "account_entitlement",
        targetId: granted.id,
        action: "entitlement.granted",
        correlationId: CORRELATION_ID,
        reason: "Approved by operator",
        previousValue: null,
        newValue: {
          accountId: ACCOUNT_ID,
          moduleKey: "tf.search",
          expiresAt: expiresAt.toISOString(),
          revokedAt: null,
          source: "operator",
        },
      });
      expect(JSON.stringify(harness.state.audits)).not.toContain(
        "private-target@example.com",
      );
      expect(harness.timeline.indexOf("clock")).toBeGreaterThan(
        harness.timeline.indexOf("findModulesByKeys"),
      );
    },
  );

  test.each([
    ["missing reason", { reason: "" }],
    ["unknown module", { moduleKey: "tf.unknown" }],
    ["disabled module", {}],
    ["expired grant", { expiresAt: NOW.toISOString() }],
  ] as const)(
    "rejects %s without mutation or audit",
    async (scenario, overrides) => {
      const harness = createHarness();
      if (scenario === "disabled module") {
        harness.state.modules = [platformModule({ state: "disabled" })];
      }
      const input = {
        accountId: ACCOUNT_ID,
        moduleKey: "tf.search",
        reason: "approved",
        ...overrides,
      };
      const before = structuredClone(harness.state);

      const error = await harness.service
        .grant(input, operator)
        .catch((candidate) => candidate);

      expectDomainError(
        error,
        scenario === "missing reason"
          ? "policy_unavailable"
          : "module_access_denied",
      );
      expect(harness.state).toEqual(before);
      expect(harness.state.audits).toEqual([]);
    },
  );

  test("revokes an existing entitlement conditionally and audits previous/new values", async () => {
    const harness = createHarness();
    harness.state.entitlements.push(entitlement());

    const revoked = await harness.service.revoke(
      {
        accountId: ACCOUNT_ID,
        moduleKey: "tf.search",
        reason: "Access no longer required",
      },
      operator,
    );

    expect(revoked.revokedAt).toEqual(NOW);
    expect(harness.state.audits[0]).toMatchObject({
      actorAccountId: OPERATOR_ID,
      targetType: "account_entitlement",
      targetId: revoked.id,
      action: "entitlement.revoked",
      correlationId: CORRELATION_ID,
      reason: "Access no longer required",
      previousValue: {
        accountId: ACCOUNT_ID,
        moduleKey: "tf.search",
        expiresAt: null,
        revokedAt: null,
        source: "operator",
      },
      newValue: {
        accountId: ACCOUNT_ID,
        moduleKey: "tf.search",
        expiresAt: null,
        revokedAt: NOW.toISOString(),
        source: "operator",
      },
    });
  });

  test.each(["missing", "already revoked"])(
    "rejects %s entitlement revocation without audit",
    async (scenario) => {
      const harness = createHarness();
      if (scenario === "already revoked") {
        harness.state.entitlements.push(entitlement({ revokedAt: NOW }));
      }

      const error = await harness.service
        .revoke(
          {
            accountId: ACCOUNT_ID,
            moduleKey: "tf.search",
            reason: "remove access",
          },
          operator,
        )
        .catch((candidate) => candidate);

      expectDomainError(error, "module_access_denied");
      expect(harness.state.audits).toEqual([]);
    },
  );

  test("returns effective entitlements sorted with strict expiry semantics", async () => {
    const harness = createHarness();
    harness.state.entitlements.push(
      entitlement({
        id: "00000000-0000-4000-8000-000000000120",
        moduleId: "00000000-0000-4000-8000-000000000121",
        moduleKey: "tf.integrations",
      }),
      entitlement({ expiresAt: new Date(NOW.getTime() + 1) }),
      entitlement({
        id: "00000000-0000-4000-8000-000000000122",
        moduleId: "00000000-0000-4000-8000-000000000123",
        moduleKey: "tf.downloads",
        expiresAt: NOW,
      }),
      entitlement({
        id: "00000000-0000-4000-8000-000000000124",
        moduleId: "00000000-0000-4000-8000-000000000125",
        moduleKey: "tf.collections",
        revokedAt: NOW,
      }),
    );

    const effective = await harness.service.listEffective(ACCOUNT_ID, NOW);

    expect(effective.map(({ moduleKey }) => moduleKey)).toEqual([
      "tf.integrations",
      "tf.search",
    ]);
  });

  test("rolls back entitlement mutation when audit insertion fails", async () => {
    const harness = createHarness();
    harness.repository.insertAuditEvent.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    const before = structuredClone(harness.state);

    const error = await harness.service
      .grant(
        {
          accountId: ACCOUNT_ID,
          moduleKey: "tf.search",
          reason: "approved",
        },
        operator,
      )
      .catch((candidate) => candidate);

    expectDomainError(error, "policy_unavailable");
    expect(harness.state).toEqual(before);
  });

  test("rolls back entitlement revocation when audit insertion fails", async () => {
    const harness = createHarness();
    harness.state.entitlements.push(entitlement());
    harness.repository.insertAuditEvent.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    const before = structuredClone(harness.state);

    const error = await harness.service
      .revoke(
        {
          accountId: ACCOUNT_ID,
          moduleKey: "tf.search",
          reason: "remove access",
        },
        operator,
      )
      .catch((candidate) => candidate);

    expectDomainError(error, "policy_unavailable");
    expect(harness.state).toEqual(before);
  });
});
