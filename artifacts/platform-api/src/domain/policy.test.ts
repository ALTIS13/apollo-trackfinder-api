import type { Pool, PoolClient } from "pg";
import { describe, expect, test, vi } from "vitest";

import { PROTECTED_PLATFORM_ROUTES } from "@workspace/platform-contract";

import { assertProtectedOperatorRoutes, PolicyService } from "./policy.js";
import type {
  Account,
  AccountEntitlement,
  AuthSession,
  PlatformModule,
  PlatformRepository,
} from "./repository.js";
import type { PlatformTransaction } from "./registration.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000201";
const SESSION_ID = "00000000-0000-4000-8000-000000000202";
const NOW = new Date("2026-07-16T14:00:00.000Z");

function activeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: ACCOUNT_ID,
    email: "policy-private@example.com",
    displayName: "Policy Account",
    status: "active",
    emailVerifiedAt: NOW,
    activatedAt: NOW,
    suspendedAt: null,
    deletedAt: null,
    createdAt: new Date(NOW.getTime() - 60_000),
    updatedAt: NOW,
    ...overrides,
  };
}

function authSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    id: SESSION_ID,
    accountId: ACCOUNT_ID,
    installationId: null,
    audience: "trackfinder-api",
    expiresAt: new Date(NOW.getTime() + 60_000),
    revokedAt: null,
    createdAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function moduleRecord(
  moduleKey: string,
  index: number,
  overrides: Partial<PlatformModule> = {},
): PlatformModule {
  return {
    id: `00000000-0000-4000-8000-${String(210 + index).padStart(12, "0")}`,
    moduleKey,
    product: "trackfinder",
    displayName: moduleKey,
    state: "active",
    description: moduleKey,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function entitlementFor(
  module: PlatformModule,
  overrides: Partial<AccountEntitlement> = {},
): AccountEntitlement {
  return {
    id: `00000000-0000-4000-8000-${String(230 + Number(module.id.slice(-1))).padStart(12, "0")}`,
    accountId: ACCOUNT_ID,
    moduleId: module.id,
    moduleKey: module.moduleKey,
    expiresAt: null,
    revokedAt: null,
    source: "operator",
    grantedByAccountId: null,
    reason: "policy fixture",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createHarness() {
  const modules = [
    moduleRecord("tf.search", 1),
    moduleRecord("tf.integrations", 2),
  ];
  const state = {
    account: activeAccount() as Account | null,
    session: authSession() as AuthSession | null,
    modules,
    entitlements: modules.map((module) => entitlementFor(module)),
  };
  const client = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as PoolClient;
  const repository = {
    lockAccountById: vi.fn(async (_client, accountId: string) =>
      state.account?.id === accountId ? state.account : null,
    ),
    findSessionById: vi.fn(async (_client, sessionId: string) =>
      state.session?.id === sessionId ? state.session : null,
    ),
    findModulesByKeys: vi.fn(async (_client, moduleKeys: readonly string[]) =>
      state.modules.filter((candidate) =>
        moduleKeys.includes(candidate.moduleKey),
      ),
    ),
    listAccountEntitlements: vi.fn(async (_client, accountId: string) =>
      state.entitlements.filter(
        (candidate) => candidate.accountId === accountId,
      ),
    ),
  };
  const transaction: PlatformTransaction = async (_pool, callback) =>
    callback(client);
  const service = new PolicyService(
    {} as Pool,
    repository as unknown as PlatformRepository,
    transaction,
  );
  return { service, state, repository };
}

function evaluateInput(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    audience: "trackfinder-api",
    requiredModules: ["tf.search", "tf.integrations"],
    now: NOW,
    ...overrides,
  };
}

describe("PolicyService", () => {
  test("allows an active account with the matching live session and all effective grants", async () => {
    const harness = createHarness();

    await expect(harness.service.evaluate(evaluateInput())).resolves.toEqual({
      allowed: true,
    });
  });

  test("returns sorted public missing module keys for absent, expired, and revoked grants", async () => {
    const harness = createHarness();
    harness.state.entitlements = [
      entitlementFor(harness.state.modules[0]!, { revokedAt: NOW }),
      entitlementFor(harness.state.modules[1]!, { expiresAt: NOW }),
    ];

    await expect(
      harness.service.evaluate(
        evaluateInput({ requiredModules: ["tf.search", "tf.integrations"] }),
      ),
    ).resolves.toEqual({
      allowed: false,
      code: "module_access_denied",
      missingModuleKeys: ["tf.integrations", "tf.search"],
    });
  });

  test.each([
    ["wrong session audience", { audience: "other-audience" }, {}],
    ["expired session", { expiresAt: NOW }, {}],
    ["revoked session", { revokedAt: NOW }, {}],
    ["suspended account", {}, { status: "suspended" }],
    ["deleted account", {}, { status: "deleted" }],
  ] as const)(
    "denies valid %s state without leaking private details",
    async (_scenario, sessionOverrides, accountOverrides) => {
      const harness = createHarness();
      harness.state.session = authSession(sessionOverrides);
      harness.state.account = activeAccount(
        accountOverrides as Partial<Account>,
      );

      const decision = await harness.service.evaluate(evaluateInput());

      expect(decision).toEqual({
        allowed: false,
        code: "module_access_denied",
        missingModuleKeys: ["tf.integrations", "tf.search"],
      });
      expect(JSON.stringify(decision)).not.toContain(
        "policy-private@example.com",
      );
      expect(JSON.stringify(decision)).not.toContain(SESSION_ID);
    },
  );

  test("denies immediately after entitlement revocation", async () => {
    const harness = createHarness();
    harness.state.entitlements[0] = entitlementFor(harness.state.modules[0]!, {
      revokedAt: NOW,
    });

    await expect(
      harness.service.evaluate(
        evaluateInput({ requiredModules: ["tf.search"] }),
      ),
    ).resolves.toEqual({
      allowed: false,
      code: "module_access_denied",
      missingModuleKeys: ["tf.search"],
    });
  });

  test.each([
    ["unknown module", () => undefined],
    [
      "disabled module",
      (harness: ReturnType<typeof createHarness>) => {
        harness.state.modules[0] = {
          ...harness.state.modules[0]!,
          state: "disabled",
        };
      },
    ],
    [
      "inconsistent entitlement module identity",
      (harness: ReturnType<typeof createHarness>) => {
        harness.state.entitlements[0] = {
          ...harness.state.entitlements[0]!,
          moduleId: "00000000-0000-4000-8000-000000000299",
        };
      },
    ],
  ] as const)("fails closed for %s", async (scenario, arrange) => {
    const harness = createHarness();
    arrange(harness);
    const input =
      scenario === "unknown module"
        ? evaluateInput({ requiredModules: ["tf.unknown"] })
        : evaluateInput({ requiredModules: ["tf.search"] });

    await expect(harness.service.evaluate(input)).resolves.toEqual({
      allowed: false,
      code: "policy_unavailable",
    });
  });

  test("fails closed for an invalid session expiry returned by the repository", async () => {
    const harness = createHarness();
    harness.state.session = authSession({ expiresAt: new Date("invalid") });

    await expect(harness.service.evaluate(evaluateInput())).resolves.toEqual({
      allowed: false,
      code: "policy_unavailable",
    });
  });

  test.each([
    { accountId: "not-a-uuid" },
    { sessionId: "not-a-uuid" },
    { audience: "" },
    { requiredModules: [] },
    { requiredModules: ["tf.search", "tf.search"] },
    { requiredModules: ["private module"] },
    { now: new Date("invalid") },
    { extra: true },
  ])("fails closed for malformed input %#", async (override) => {
    const harness = createHarness();
    await expect(
      harness.service.evaluate(evaluateInput(override)),
    ).resolves.toEqual({ allowed: false, code: "policy_unavailable" });
    expect(harness.repository.lockAccountById).not.toHaveBeenCalled();
  });

  test("maps repository and transaction failures to policy unavailable without throwing", async () => {
    const harness = createHarness();
    harness.repository.findSessionById.mockRejectedValueOnce(
      new Error("database connection failed"),
    );

    await expect(harness.service.evaluate(evaluateInput())).resolves.toEqual({
      allowed: false,
      code: "policy_unavailable",
    });
  });
});

describe("assertProtectedOperatorRoutes", () => {
  test("accepts the exact protected route manifest", () => {
    expect(() =>
      assertProtectedOperatorRoutes(PROTECTED_PLATFORM_ROUTES),
    ).not.toThrow();
  });

  test.each([
    [
      "missing route",
      Object.fromEntries(Object.entries(PROTECTED_PLATFORM_ROUTES).slice(1)),
    ],
    [
      "extra route",
      {
        ...PROTECTED_PLATFORM_ROUTES,
        "POST /v1/operator/unmapped": ["platform.accounts.manage"],
      },
    ],
    [
      "wrong capability",
      {
        ...PROTECTED_PLATFORM_ROUTES,
        "POST /v1/operator/invitations": ["platform.accounts.manage"],
      },
    ],
  ])("throws on %s", (_scenario, routes) => {
    expect(() => assertProtectedOperatorRoutes(routes)).toThrow(
      "Protected operator route mapping mismatch",
    );
  });
});
