import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createPlatformPool,
  runPlatformMigrations,
  setAccountContext,
  withPlatformTransaction,
} from "@workspace/platform-db";

import { PlatformDomainError } from "./errors.js";
import {
  OPERATOR_CAPABILITIES,
  OperatorSessionService,
} from "./operator-sessions.js";
import { PostgresPlatformRepository } from "./postgres-repository.js";
import type { AuthSession } from "./repository.js";
import type { PlatformTransaction } from "./registration.js";

const migratorConnectionString = process.env.PLATFORM_TEST_DATABASE_URL;
const runtimeConnectionString = process.env.PLATFORM_TEST_RUNTIME_DATABASE_URL;
const describePostgres =
  migratorConnectionString && runtimeConnectionString
    ? describe.sequential
    : describe.skip;

const BOOTSTRAP_TOKEN = "task-6-real-postgres-bootstrap-token";
const NOW = new Date(Date.now() + 60_000);

class PausingDigestLookupRepository extends PostgresPlatformRepository {
  readonly initialReadCompleted: Promise<void>;
  private notifyInitialRead!: () => void;
  private readonly mutationCommitted: Promise<void>;
  private notifyMutationCommitted!: () => void;

  constructor() {
    super();
    this.initialReadCompleted = new Promise((resolve) => {
      this.notifyInitialRead = resolve;
    });
    this.mutationCommitted = new Promise((resolve) => {
      this.notifyMutationCommitted = resolve;
    });
  }

  override async findSessionByDigest(
    client: PoolClient,
    sessionDigest: string,
  ): Promise<AuthSession | null> {
    const staleSnapshot = await super.findSessionByDigest(
      client,
      sessionDigest,
    );
    this.notifyInitialRead();
    await this.mutationCommitted;
    return staleSnapshot;
  }

  releaseAfterMutationCommit(): void {
    this.notifyMutationCommitted();
  }
}

function createTransactionBarrier() {
  let arrivals = 0;
  let notifyArrived!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    notifyArrived = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction: PlatformTransaction = (pool, callback) =>
    withPlatformTransaction(pool, async (client) => {
      arrivals += 1;
      if (arrivals === 2) notifyArrived();
      await released;
      return callback(client);
    });
  return {
    transaction,
    bothArrived,
    release,
    get arrivals() {
      return arrivals;
    },
  };
}

describePostgres("OperatorSessionService PostgreSQL concurrency", () => {
  let migrator: Pool;
  let firstRuntime: Pool;
  let secondRuntime: Pool;
  const repository = new PostgresPlatformRepository();

  beforeAll(async () => {
    migrator = createPlatformPool(migratorConnectionString!);
    firstRuntime = createPlatformPool(runtimeConnectionString!);
    secondRuntime = createPlatformPool(runtimeConnectionString!);
    await runPlatformMigrations(migrator);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([
      migrator?.end(),
      firstRuntime?.end(),
      secondRuntime?.end(),
    ]);
  });

  test("serializes bootstrap and rejects stale authentication after revoke or rotation commits", async () => {
    const barrier = createTransactionBarrier();
    const first = new OperatorSessionService(
      firstRuntime,
      repository,
      BOOTSTRAP_TOKEN,
      () => new Date(NOW),
      barrier.transaction,
    );
    const second = new OperatorSessionService(
      secondRuntime,
      repository,
      BOOTSTRAP_TOKEN,
      () => new Date(NOW),
      barrier.transaction,
    );
    const attempts = [
      first.bootstrap(
        {
          bootstrapToken: BOOTSTRAP_TOKEN,
          email: "task-6-bootstrap-first@example.com",
          displayName: "Task 6 First Operator",
          password: "correct horse battery staple",
          reason: "Task 6 initial bootstrap",
        },
        { correlationId: "00000000-0000-4000-8000-000000000301" },
      ),
      second.bootstrap(
        {
          bootstrapToken: BOOTSTRAP_TOKEN,
          email: "task-6-bootstrap-second@example.com",
          displayName: "Task 6 Second Operator",
          password: "correct horse battery staple",
          reason: "Task 6 competing bootstrap",
        },
        { correlationId: "00000000-0000-4000-8000-000000000302" },
      ),
    ] as const;

    await barrier.bothArrived;
    expect(barrier.arrivals).toBe(2);
    barrier.release();
    const outcomes = await Promise.allSettled(attempts);
    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status).toBe("rejected");
    if (rejected[0]?.status !== "rejected")
      throw new Error("expected rejection");
    expect(rejected[0].reason).toBeInstanceOf(PlatformDomainError);
    expect((rejected[0].reason as PlatformDomainError).code).toBe(
      "invalid_credentials",
    );
    if (fulfilled[0]?.status !== "fulfilled")
      throw new Error("expected winner");
    const winner = fulfilled[0].value;
    const winnerReason = winner.email.includes("first")
      ? "Task 6 initial bootstrap"
      : "Task 6 competing bootstrap";

    const firstSession = await first.login(
      { email: winner.email, password: "correct horse battery staple" },
      { correlationId: "00000000-0000-4000-8000-000000000304" },
    );
    const revokeBarrierRepository = new PausingDigestLookupRepository();
    const authenticationDuringRevoke = new OperatorSessionService(
      firstRuntime,
      revokeBarrierRepository,
      BOOTSTRAP_TOKEN,
      () => new Date(NOW),
    ).authenticate(firstSession.rawToken);
    await revokeBarrierRepository.initialReadCompleted;
    try {
      await second.revoke(firstSession.rawToken, {
        correlationId: "00000000-0000-4000-8000-000000000305",
      });
    } finally {
      revokeBarrierRepository.releaseAfterMutationCommit();
    }
    await expect(authenticationDuringRevoke).rejects.toMatchObject({
      code: "invalid_credentials",
    });

    const rotationCandidate = await first.login(
      { email: winner.email, password: "correct horse battery staple" },
      { correlationId: "00000000-0000-4000-8000-000000000306" },
    );
    const rotationBarrierRepository = new PausingDigestLookupRepository();
    const authenticationDuringRotation = new OperatorSessionService(
      firstRuntime,
      rotationBarrierRepository,
      BOOTSTRAP_TOKEN,
      () => new Date(NOW),
    ).authenticate(rotationCandidate.rawToken);
    await rotationBarrierRepository.initialReadCompleted;
    try {
      await second.login(
        { email: winner.email, password: "correct horse battery staple" },
        { correlationId: "00000000-0000-4000-8000-000000000307" },
      );
    } finally {
      rotationBarrierRepository.releaseAfterMutationCommit();
    }
    await expect(authenticationDuringRotation).rejects.toMatchObject({
      code: "invalid_credentials",
    });

    const committed = await withPlatformTransaction(
      firstRuntime,
      async (client) => {
        const marker = await client.query<{
          operator_bootstrap_account_id: string;
          operator_bootstrap_completed_at: Date;
        }>(`
        select operator_bootstrap_account_id, operator_bootstrap_completed_at
        from apollo_platform.registration_settings
      `);
        const absentContextRoles = await client.query<{ count: string }>(
          "select count(*)::text as count from apollo_platform.operator_roles",
        );
        await setAccountContext(client, winner.id);
        const capabilities = await client.query<{ capability: string }>(`
        select capability
        from apollo_platform.operator_roles
        where revoked_at is null
        order by capability
      `);
        const entitlements = await client.query<{ count: string }>(
          "select count(*)::text as count from apollo_platform.account_module_entitlements",
        );
        const audit = await client.query<{
          actor_account_id: string | null;
          action: string;
          reason: string;
          previous_value: unknown;
          new_value: unknown;
        }>(
          `
        select actor_account_id, action, reason, previous_value, new_value
        from apollo_platform.audit_events
        where target_id = $1 and action = 'operator.bootstrap_completed'
      `,
          [winner.id],
        );
        await client.query(`
        update apollo_platform.operator_roles
        set revoked_at = now(),
            revoked_by_account_id = account_id,
            revocation_reason = 'integration revocation'
        where revoked_at is null
      `);
        const markerAfterRevocation = await client.query<{
          operator_bootstrap_account_id: string;
        }>(`
        select operator_bootstrap_account_id
        from apollo_platform.registration_settings
      `);
        return {
          marker: marker.rows[0],
          absentContextRoleCount: absentContextRoles.rows[0]?.count,
          capabilities: capabilities.rows.map(({ capability }) => capability),
          entitlementCount: entitlements.rows[0]?.count,
          audit: audit.rows,
          markerAfterRevocation: markerAfterRevocation.rows[0],
        };
      },
    );

    expect(committed.marker?.operator_bootstrap_account_id).toBe(winner.id);
    expect(committed.marker?.operator_bootstrap_completed_at).toBeInstanceOf(
      Date,
    );
    expect(committed.absentContextRoleCount).toBe("0");
    expect(committed.capabilities).toEqual([...OPERATOR_CAPABILITIES].sort());
    expect(committed.entitlementCount).toBe("0");
    expect(committed.audit).toEqual([
      {
        actor_account_id: null,
        action: "operator.bootstrap_completed",
        reason: winnerReason,
        previous_value: null,
        new_value: {
          status: "active",
          emailVerified: true,
          capabilities: [...OPERATOR_CAPABILITIES].sort(),
        },
      },
    ]);
    expect(committed.markerAfterRevocation?.operator_bootstrap_account_id).toBe(
      winner.id,
    );

    await expect(
      first.bootstrap(
        {
          bootstrapToken: BOOTSTRAP_TOKEN,
          email: "task-6-bootstrap-third@example.com",
          displayName: "Task 6 Third Operator",
          password: "correct horse battery staple",
          reason: "must remain terminal",
        },
        { correlationId: "00000000-0000-4000-8000-000000000303" },
      ),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  }, 120_000);
});
