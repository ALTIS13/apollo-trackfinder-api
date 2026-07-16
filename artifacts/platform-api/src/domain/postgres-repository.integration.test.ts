import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createPlatformPool,
  runPlatformMigrations,
  setAccountContext,
  withPlatformTransaction,
} from "@workspace/platform-db";

import type { Account } from "./repository.js";
import { PostgresPlatformRepository } from "./postgres-repository.js";

const migratorConnectionString = process.env.PLATFORM_TEST_DATABASE_URL;
const runtimeConnectionString = process.env.PLATFORM_TEST_RUNTIME_DATABASE_URL;
const describePostgres =
  migratorConnectionString && runtimeConnectionString
    ? describe.sequential
    : describe.skip;

const firstEmail = "pre-auth-first@example.com";
const secondEmail = "pre-auth-second@example.com";
const firstVerificationDigest = "1".repeat(64);
const secondVerificationDigest = "2".repeat(64);
const firstSessionDigest = "3".repeat(64);
const secondSessionDigest = "4".repeat(64);
const missingDigest = "f".repeat(64);
const expiresAt = new Date("2030-07-16T10:00:00.000Z");

describePostgres("PostgresPlatformRepository forced-RLS bootstrap", () => {
  let migrator: Pool;
  let runtime: Pool;
  let firstAccount: Account;
  let secondAccount: Account;
  const repository = new PostgresPlatformRepository();

  beforeAll(async () => {
    migrator = createPlatformPool(migratorConnectionString!);
    runtime = createPlatformPool(runtimeConnectionString!);
    await runPlatformMigrations(migrator);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([migrator?.end(), runtime?.end()]);
  });

  test("runtime creates pending accounts with an exact pre-auth email context", async () => {
    firstAccount = await withPlatformTransaction(runtime, (client) =>
      repository.createAccount(client, {
        normalizedEmail: firstEmail,
        displayName: "First Pre-Auth Account",
      }),
    );
    secondAccount = await withPlatformTransaction(runtime, (client) =>
      repository.createAccount(client, {
        normalizedEmail: secondEmail,
        displayName: "Second Pre-Auth Account",
      }),
    );

    expect(firstAccount).toMatchObject({
      email: firstEmail,
      status: "pending",
    });
    expect(secondAccount).toMatchObject({
      email: secondEmail,
      status: "pending",
    });
  });

  test("exact email lookup exposes only the matching account", async () => {
    const exact = await withPlatformTransaction(runtime, async (client) => {
      const found = await repository.findAccountByNormalizedEmail(
        client,
        firstEmail,
      );
      const visible = await client.query<{ email: string }>(
        "select email from apollo_platform.accounts order by email",
      );
      return { found, visible: visible.rows.map(({ email }) => email) };
    });

    expect(exact.found?.id).toBe(firstAccount.id);
    expect(exact.visible).toEqual([firstEmail]);

    for (const normalizedEmail of ["missing@example.com", ""]) {
      const hidden = await withPlatformTransaction(runtime, async (client) => {
        const found = await repository.findAccountByNormalizedEmail(
          client,
          normalizedEmail,
        );
        const visible = await client.query(
          "select id from apollo_platform.accounts",
        );
        return { found, rowCount: visible.rowCount };
      });
      expect(hidden).toEqual({ found: null, rowCount: 0 });
    }
  });

  test("verification locking exposes only the exact digest", async () => {
    const [firstToken, secondToken] = await withPlatformTransaction(
      runtime,
      async (client) => {
        await setAccountContext(client, firstAccount.id);
        const firstToken = await repository.createVerificationToken(client, {
          accountId: firstAccount.id,
          tokenDigest: firstVerificationDigest,
          expiresAt,
        });
        const secondToken = await repository.createVerificationToken(client, {
          accountId: firstAccount.id,
          tokenDigest: secondVerificationDigest,
          expiresAt,
        });
        return [firstToken, secondToken];
      },
    );

    const exact = await withPlatformTransaction(runtime, async (client) => {
      const found = await repository.lockVerificationTokenByDigest(
        client,
        firstVerificationDigest,
      );
      const visible = await client.query<{ id: string }>(
        "select id from apollo_platform.email_verification_tokens order by id",
      );
      return { found, visible: visible.rows.map(({ id }) => id) };
    });

    expect(exact.found?.id).toBe(firstToken.id);
    expect(exact.visible).toEqual([firstToken.id]);
    expect(secondToken.id).not.toBe(firstToken.id);

    for (const tokenDigest of [missingDigest, ""]) {
      const hidden = await withPlatformTransaction(runtime, async (client) => {
        const found = await repository.lockVerificationTokenByDigest(
          client,
          tokenDigest,
        );
        const visible = await client.query(
          "select id from apollo_platform.email_verification_tokens",
        );
        return { found, rowCount: visible.rowCount };
      });
      expect(hidden).toEqual({ found: null, rowCount: 0 });
    }
  });

  test("session lookup exposes only the exact digest", async () => {
    const [firstSession, secondSession] = await withPlatformTransaction(
      runtime,
      async (client) => {
        await setAccountContext(client, secondAccount.id);
        const firstSession = await repository.createSession(client, {
          accountId: secondAccount.id,
          installationId: null,
          sessionDigest: firstSessionDigest,
          audience: "apollo-integration",
          expiresAt,
        });
        const secondSession = await repository.createSession(client, {
          accountId: secondAccount.id,
          installationId: null,
          sessionDigest: secondSessionDigest,
          audience: "apollo-integration",
          expiresAt,
        });
        return [firstSession, secondSession];
      },
    );

    const exact = await withPlatformTransaction(runtime, async (client) => {
      const found = await repository.findSessionByDigest(
        client,
        firstSessionDigest,
      );
      const visible = await client.query<{ id: string }>(
        "select id from apollo_platform.auth_sessions order by id",
      );
      return { found, visible: visible.rows.map(({ id }) => id) };
    });

    expect(exact.found?.id).toBe(firstSession.id);
    expect(exact.visible).toEqual([firstSession.id]);
    expect(secondSession.id).not.toBe(firstSession.id);

    for (const sessionDigest of [missingDigest, ""]) {
      const hidden = await withPlatformTransaction(runtime, async (client) => {
        const found = await repository.findSessionByDigest(
          client,
          sessionDigest,
        );
        const visible = await client.query(
          "select id from apollo_platform.auth_sessions",
        );
        return { found, rowCount: visible.rowCount };
      });
      expect(hidden).toEqual({ found: null, rowCount: 0 });
    }
  });

  test("absent transaction contexts expose no pre-auth rows", async () => {
    await expect(
      withPlatformTransaction(runtime, async (client) => {
        const accounts = await client.query(
          "select id from apollo_platform.accounts",
        );
        const verificationTokens = await client.query(
          "select id from apollo_platform.email_verification_tokens",
        );
        const sessions = await client.query(
          "select id from apollo_platform.auth_sessions",
        );
        return [
          accounts.rowCount,
          verificationTokens.rowCount,
          sessions.rowCount,
        ];
      }),
    ).resolves.toEqual([0, 0, 0]);
  });
});
