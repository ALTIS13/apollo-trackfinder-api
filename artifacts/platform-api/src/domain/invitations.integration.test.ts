import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createPlatformPool,
  runPlatformMigrations,
  setAccountContext,
  withPlatformTransaction,
} from "@workspace/platform-db";

import { PlatformDomainError } from "./errors.js";
import { InvitationService, type PlatformTransaction } from "./invitations.js";
import { PostgresPlatformRepository } from "./postgres-repository.js";

const migratorConnectionString = process.env.PLATFORM_TEST_DATABASE_URL;
const runtimeConnectionString = process.env.PLATFORM_TEST_RUNTIME_DATABASE_URL;
const describePostgres =
  migratorConnectionString && runtimeConnectionString
    ? describe.sequential
    : describe.skip;

const NOW = new Date(Date.now() + 60_000);
const EXPIRES_AT = new Date(NOW.getTime() + 24 * 60 * 60 * 1_000);
const CORRELATION_ID = "00000000-0000-4000-8000-000000000100";
const SECOND_CORRELATION_ID = "00000000-0000-4000-8000-000000000101";
const CANDIDATE_EMAILS = [
  "task-5-concurrent-first@example.com",
  "task-5-concurrent-second@example.com",
] as const;

function createTransactionBarrier() {
  let arrivalCount = 0;
  const pools = new Set<Pool>();
  const clients = new Set<unknown>();
  let notifyAllReached!: () => void;
  const allReached = new Promise<void>((resolve) => {
    notifyAllReached = resolve;
  });
  let releaseTransactions!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseTransactions = resolve;
  });

  const transaction: PlatformTransaction = (pool, callback) =>
    withPlatformTransaction(pool, async (client) => {
      arrivalCount += 1;
      pools.add(pool);
      clients.add(client);
      if (arrivalCount === 2) {
        notifyAllReached();
      }
      await released;
      return callback(client);
    });

  return {
    transaction,
    allReached,
    release: releaseTransactions,
    get arrivalCount() {
      return arrivalCount;
    },
    get poolCount() {
      return pools.size;
    },
    get clientCount() {
      return clients.size;
    },
  };
}

describePostgres("InvitationService concurrent PostgreSQL redemption", () => {
  let migrator: Pool;
  let setupRuntime: Pool;
  let firstRuntime: Pool;
  let secondRuntime: Pool;
  const repository = new PostgresPlatformRepository();

  beforeAll(async () => {
    migrator = createPlatformPool(migratorConnectionString!);
    setupRuntime = createPlatformPool(runtimeConnectionString!);
    firstRuntime = createPlatformPool(runtimeConnectionString!);
    secondRuntime = createPlatformPool(runtimeConnectionString!);
    await runPlatformMigrations(migrator);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([
      migrator?.end(),
      setupRuntime?.end(),
      firstRuntime?.end(),
      secondRuntime?.end(),
    ]);
  });

  test("serializes two synchronized unbound uses_limit=1 redemptions", async () => {
    const operator = await withPlatformTransaction(
      setupRuntime,
      async (client) => {
        const account = await repository.createAccount(client, {
          normalizedEmail: "task-5-invitation-operator@example.com",
          displayName: "Task 5 Invitation Operator",
        });
        await repository.updateRegistrationSettings(client, {
          mode: "invite_only",
          updatedByAccountId: account.id,
        });
        return account;
      },
    );
    const setupService = new InvitationService(
      setupRuntime,
      repository,
      () => new Date(NOW),
    );
    const created = await setupService.create(
      {
        expiresAt: EXPIRES_AT.toISOString(),
        usesLimit: 1,
        moduleKeys: ["tf.search", "tf.collections"],
        reason: "Concurrent redemption proof",
      },
      { accountId: operator.id, correlationId: CORRELATION_ID },
    );
    expect(created.invitation.emailBound).toBe(false);

    const barrier = createTransactionBarrier();
    const firstService = new InvitationService(
      firstRuntime,
      repository,
      () => new Date(NOW),
      barrier.transaction,
    );
    const secondService = new InvitationService(
      secondRuntime,
      repository,
      () => new Date(NOW),
      barrier.transaction,
    );
    const redemptionPromises = [
      firstService.redeem(
        {
          invitationToken: created.rawToken,
          email: CANDIDATE_EMAILS[0],
          displayName: "Concurrent Invitee One",
          password: "correct horse battery staple",
        },
        { correlationId: CORRELATION_ID },
      ),
      secondService.redeem(
        {
          invitationToken: created.rawToken,
          email: CANDIDATE_EMAILS[1],
          displayName: "Concurrent Invitee Two",
          password: "correct horse battery staple",
        },
        {
          correlationId: SECOND_CORRELATION_ID,
        },
      ),
    ] as const;

    await barrier.allReached;
    expect(barrier.arrivalCount).toBe(2);
    expect(barrier.poolCount).toBe(2);
    expect(barrier.clientCount).toBe(2);
    barrier.release();

    const outcomes = await Promise.allSettled(redemptionPromises);
    const winners = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    const losers = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0];
    expect(loser?.status).toBe("rejected");
    if (loser?.status !== "rejected") {
      throw new Error("Expected one rejected redemption");
    }
    expect(loser.reason).toBeInstanceOf(PlatformDomainError);
    expect((loser.reason as PlatformDomainError).code).toBe(
      "invitation_not_available",
    );

    const winner = winners[0];
    if (winner?.status !== "fulfilled") {
      throw new Error("Expected one fulfilled redemption");
    }
    const accountId = winner.value.account.id;
    expect(CANDIDATE_EMAILS).toContain(winner.value.account.email);

    const committed = await withPlatformTransaction(
      setupRuntime,
      async (client) => {
        const candidateAccounts = [];
        for (const email of CANDIDATE_EMAILS) {
          const account = await repository.findAccountByNormalizedEmail(
            client,
            email,
          );
          if (account !== null) {
            candidateAccounts.push(account);
          }
        }
        await setAccountContext(client, accountId);
        const credentialCount = await client.query<{ count: string }>(
          "select count(*)::text as count from apollo_platform.credentials where account_id = $1",
          [accountId],
        );
        const verificationCount = await client.query<{ count: string }>(
          "select count(*)::text as count from apollo_platform.email_verification_tokens where account_id = $1",
          [accountId],
        );
        const entitlementSet = await client.query<{
          count: string;
          module_keys: string[];
          invitation_source: boolean;
          correct_grantor: boolean;
          no_expiry: boolean;
          stable_reason: boolean;
        }>(
          `select count(*)::text as count,
                  array_agg(module.module_key order by module.module_key) as module_keys,
                  bool_and(entitlement.source = 'invitation') as invitation_source,
                  bool_and(entitlement.granted_by_account_id = $2) as correct_grantor,
                  bool_and(entitlement.expires_at is null) as no_expiry,
                  bool_and(entitlement.reason = 'invitation_initial_grant') as stable_reason
           from apollo_platform.account_module_entitlements as entitlement
           join apollo_platform.modules as module on module.id = entitlement.module_id
           where entitlement.account_id = $1`,
          [accountId, operator.id],
        );
        const invitation = await client.query<{
          uses_count: number;
          uses_limit: number;
        }>(
          `select uses_count, uses_limit
           from apollo_platform.invitations
           where id = $1`,
          [created.invitation.id],
        );
        const invitationGrantCount = await client.query<{ count: string }>(
          "select count(*)::text as count from apollo_platform.invitation_module_grants where invitation_id = $1",
          [created.invitation.id],
        );
        const redemptionAuditCount = await client.query<{ count: string }>(
          `select count(*)::text as count
           from apollo_platform.audit_events
           where target_type = 'invitation'
             and target_id = $1
             and action = 'invitation.redeemed'`,
          [created.invitation.id],
        );
        return {
          candidateAccounts,
          credentialCount: credentialCount.rows[0]?.count,
          verificationCount: verificationCount.rows[0]?.count,
          entitlementSet: entitlementSet.rows[0],
          invitation: invitation.rows,
          invitationGrantCount: invitationGrantCount.rows[0]?.count,
          redemptionAuditCount: redemptionAuditCount.rows[0]?.count,
        };
      },
    );

    expect(committed.candidateAccounts).toEqual([winner.value.account]);
    expect(committed.credentialCount).toBe("1");
    expect(committed.verificationCount).toBe("1");
    expect(committed.entitlementSet).toEqual({
      count: "2",
      module_keys: ["tf.collections", "tf.search"],
      invitation_source: true,
      correct_grantor: true,
      no_expiry: true,
      stable_reason: true,
    });
    expect(committed.invitation).toEqual([{ uses_count: 1, uses_limit: 1 }]);
    expect(committed.invitationGrantCount).toBe("2");
    expect(committed.redemptionAuditCount).toBe("1");
  }, 60_000);
});
