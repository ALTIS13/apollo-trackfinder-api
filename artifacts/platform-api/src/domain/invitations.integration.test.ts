import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createPlatformPool,
  runPlatformMigrations,
  setAccountContext,
  withPlatformTransaction,
} from "@workspace/platform-db";

import { PlatformDomainError } from "./errors.js";
import { InvitationService } from "./invitations.js";
import { PostgresPlatformRepository } from "./postgres-repository.js";
import { digestOpaqueToken } from "./security.js";

const migratorConnectionString = process.env.PLATFORM_TEST_DATABASE_URL;
const runtimeConnectionString = process.env.PLATFORM_TEST_RUNTIME_DATABASE_URL;
const describePostgres =
  migratorConnectionString && runtimeConnectionString
    ? describe.sequential
    : describe.skip;

const NOW = new Date("2026-07-16T10:00:00.000Z");
const EXPIRES_AT = new Date("2026-07-17T10:00:00.000Z");
const CORRELATION_ID = "00000000-0000-4000-8000-000000000100";
const SECOND_CORRELATION_ID = "00000000-0000-4000-8000-000000000101";
const INVITEE_EMAIL = "task-5-concurrent-invitee@example.com";

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

  test("uses independent transactions so exactly one uses_limit=1 redemption commits", async () => {
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
        email: INVITEE_EMAIL,
        expiresAt: EXPIRES_AT.toISOString(),
        usesLimit: 1,
        moduleKeys: ["tf.search", "tf.collections"],
        reason: "Concurrent redemption proof",
      },
      { accountId: operator.id, correlationId: CORRELATION_ID },
    );

    const firstService = new InvitationService(
      firstRuntime,
      repository,
      () => new Date(NOW),
    );
    const secondService = new InvitationService(
      secondRuntime,
      repository,
      () => new Date(NOW),
    );
    const input = {
      invitationToken: created.rawToken,
      email: INVITEE_EMAIL,
      displayName: "Concurrent Invitee",
      password: "correct horse battery staple",
    };

    const outcomes = await Promise.allSettled([
      firstService.redeem(input, { correlationId: CORRELATION_ID }),
      secondService.redeem(input, {
        correlationId: SECOND_CORRELATION_ID,
      }),
    ]);
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
    const committed = await withPlatformTransaction(
      setupRuntime,
      async (client) => {
        const account = await repository.findAccountByNormalizedEmail(
          client,
          INVITEE_EMAIL,
        );
        const accountCount = await client.query<{ count: string }>(
          "select count(*)::text as count from apollo_platform.accounts where email = $1",
          [INVITEE_EMAIL],
        );
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
        const invitation = await repository.lockInvitationByDigest(
          client,
          digestOpaqueToken(created.rawToken),
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
          account,
          accountCount: Number(accountCount.rows[0]?.count),
          credentialCount: Number(credentialCount.rows[0]?.count),
          verificationCount: Number(verificationCount.rows[0]?.count),
          entitlementSet: {
            count: Number(entitlementSet.rows[0]?.count),
            moduleKeys: entitlementSet.rows[0]?.module_keys,
            invitationSource: entitlementSet.rows[0]?.invitation_source,
            correctGrantor: entitlementSet.rows[0]?.correct_grantor,
            noExpiry: entitlementSet.rows[0]?.no_expiry,
            stableReason: entitlementSet.rows[0]?.stable_reason,
          },
          invitation,
          invitationGrantCount: Number(invitationGrantCount.rows[0]?.count),
          redemptionAuditCount: Number(redemptionAuditCount.rows[0]?.count),
        };
      },
    );

    expect(committed).toMatchObject({
      account: { id: accountId, status: "pending" },
      accountCount: 1,
      credentialCount: 1,
      verificationCount: 1,
      entitlementSet: {
        count: 2,
        moduleKeys: ["tf.collections", "tf.search"],
        invitationSource: true,
        correctGrantor: true,
        noExpiry: true,
        stableReason: true,
      },
      invitation: { usesCount: 1, usesLimit: 1 },
      invitationGrantCount: 2,
      redemptionAuditCount: 1,
    });
  }, 60_000);
});
