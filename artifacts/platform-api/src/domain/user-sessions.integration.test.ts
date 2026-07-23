import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createPlatformPool,
  runPlatformMigrations,
  setAccountContext,
  withPlatformTransaction,
} from "@workspace/platform-db";

import { PostgresPlatformRepository } from "./postgres-repository.js";
import { digestOpaqueToken, hashPassword } from "./security.js";
import {
  APOLLO_PORTAL_AUDIENCE,
  UserSessionService,
} from "./user-sessions.js";

const migratorConnectionString = process.env.PLATFORM_TEST_DATABASE_URL;
const runtimeConnectionString = process.env.PLATFORM_TEST_RUNTIME_DATABASE_URL;
const describePostgres =
  migratorConnectionString && runtimeConnectionString
    ? describe.sequential
    : describe.skip;

const NOW = new Date("2030-07-24T10:00:00.000Z");
const PASSWORD = "correct horse battery staple";
const EMAIL = "task-3-pending@example.test";

describePostgres("UserSessionService PostgreSQL portal sessions", () => {
  let migrator: Pool;
  let runtime: Pool;
  const repository = new PostgresPlatformRepository();

  beforeAll(async () => {
    migrator = createPlatformPool(migratorConnectionString!);
    runtime = createPlatformPool(runtimeConnectionString!);
    await runPlatformMigrations(migrator);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([migrator?.end(), runtime?.end()]);
  });

  test("persists a digest-only portal session for a verified pending account and revokes that exact session", async () => {
    const account = await withPlatformTransaction(runtime, async (client) => {
      const account = await repository.createAccount(client, {
        normalizedEmail: EMAIL,
        displayName: "Task 3 Pending User",
      });
      await setAccountContext(client, account.id);
      await repository.createCredential(client, {
        accountId: account.id,
        passwordHash: await hashPassword(PASSWORD),
        passwordChangedAt: NOW,
      });
      return repository.markAccountEmailVerified(client, {
        accountId: account.id,
        verifiedAt: NOW,
      });
    });
    const service = new UserSessionService(
      runtime,
      repository,
      () => new Date(NOW),
    );

    const result = await service.login(
      { email: EMAIL, password: PASSWORD },
      { correlationId: "00000000-0000-4000-8000-000000000301" },
    );

    expect(result.account).toMatchObject({
      id: account.id,
      status: "pending",
      emailVerifiedAt: NOW,
    });
    expect(result.session).toMatchObject({
      accountId: account.id,
      audience: APOLLO_PORTAL_AUDIENCE,
      installationId: null,
      revokedAt: null,
    });
    await expect(service.authenticate(result.rawToken)).resolves.toEqual({
      accountId: account.id,
      sessionId: result.session.id,
      status: "pending",
      emailVerified: true,
    });

    const persisted = await withPlatformTransaction(runtime, async (client) => {
      await repository.findSessionByDigest(
        client,
        digestOpaqueToken(result.rawToken),
      );
      return client.query<{
        session_digest: string;
        audience: string;
        installation_id: string | null;
      }>(
        "select session_digest, audience, installation_id from apollo_platform.auth_sessions where id = $1",
        [result.session.id],
      );
    });
    expect(persisted.rows).toEqual([
      {
        session_digest: expect.not.stringContaining(result.rawToken),
        audience: APOLLO_PORTAL_AUDIENCE,
        installation_id: null,
      },
    ]);

    await service.revoke(result.rawToken, {
      correlationId: "00000000-0000-4000-8000-000000000302",
    });
    await expect(service.authenticate(result.rawToken)).rejects.toMatchObject({
      code: "invalid_credentials",
    });

    const audit = await withPlatformTransaction(runtime, async (client) => {
      await setAccountContext(client, account.id);
      return client.query<{
        action: string;
        reason: string;
        previous_value: unknown;
        new_value: unknown;
      }>(
        "select action, reason, previous_value, new_value from apollo_platform.audit_events where target_id = $1 order by occurred_at",
        [result.session.id],
      );
    });
    expect(audit.rows).toEqual([
      {
        action: "user.session_created",
        reason: "user_login",
        previous_value: null,
        new_value: expect.objectContaining({
          audience: APOLLO_PORTAL_AUDIENCE,
          status: "pending",
          revokedAt: null,
        }),
      },
      {
        action: "user.session_revoked",
        reason: "user_logout",
        previous_value: expect.objectContaining({
          audience: APOLLO_PORTAL_AUDIENCE,
          status: "pending",
          revokedAt: null,
        }),
        new_value: expect.objectContaining({
          audience: APOLLO_PORTAL_AUDIENCE,
          status: "pending",
          revokedAt: expect.any(String),
        }),
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(EMAIL);
    expect(JSON.stringify(audit.rows)).not.toContain(result.rawToken);
    expect(JSON.stringify(audit.rows)).not.toContain(persisted.rows[0]!.session_digest);
  }, 60_000);
});
