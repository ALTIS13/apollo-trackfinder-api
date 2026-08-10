import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createPlatformPool,
  runPlatformMigrations,
  setAccountContext,
  withPlatformTransaction,
} from "@workspace/platform-db";

import { PlatformAdminOverviewService } from "./admin-overview.js";
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
const authorizationCodeDigest = "5".repeat(64);
const stateDigest = "6".repeat(64);
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

  test("binds authorization codes to RLS-scoped installations and consumes them once", async () => {
    const seenAt = new Date();
    const { installation, authorizationCode, session } =
      await withPlatformTransaction(runtime, async (client) => {
        await setAccountContext(client, firstAccount.id);
        const installation = await repository.upsertClientInstallation(client, {
          installationId: "f3dd15c3-999a-4a6f-9934-0cc8163fbe88",
          accountId: firstAccount.id,
          label: "Integration browser",
          seenAt,
        });
        const session = await repository.createSession(client, {
          accountId: firstAccount.id,
          installationId: installation.id,
          sessionDigest: "7".repeat(64),
          audience: "apollo-integration",
          expiresAt,
        });
        const authorizationCode = await repository.createAuthorizationCode(
          client,
          {
            accountId: firstAccount.id,
            authSessionId: session.id,
            installationId: installation.id,
            codeDigest: authorizationCodeDigest,
            stateDigest,
            clientId: "apollo-integration",
            redirectUri: "https://client.example/callback",
            pkceChallenge: "pkce-challenge",
            nonce: "nonce",
            expiresAt,
          },
        );
        return { installation, authorizationCode, session };
      });

    expect(authorizationCode).toMatchObject({
      accountId: firstAccount.id,
      installationId: installation.id,
      pkceMethod: "S256",
      consumedAt: null,
    });
    expect(authorizationCode).not.toHaveProperty("codeDigest");
    expect(authorizationCode).not.toHaveProperty("stateDigest");

    const consumed = await withPlatformTransaction(runtime, async (client) => {
      await setAccountContext(client, firstAccount.id);
      const lockedInstallation = await repository.lockClientInstallation(
        client,
        installation.id,
      );
      const lockedSession = await repository.lockSessionById(
        client,
        session.id,
      );
      const lockedCode = await repository.lockAuthorizationCodeByDigest(
        client,
        authorizationCodeDigest,
      );
      const consumedAt = new Date();
      const firstConsumption = await repository.consumeAuthorizationCode(
        client,
        {
          authorizationCodeId: authorizationCode.id,
          consumedAt,
        },
      );
      const replay = await repository.consumeAuthorizationCode(client, {
        authorizationCodeId: authorizationCode.id,
        consumedAt,
      });
      return {
        lockedInstallation,
        lockedSession,
        lockedCode,
        firstConsumption,
        replay,
      };
    });

    expect(consumed.lockedInstallation?.id).toBe(installation.id);
    expect(consumed.lockedSession?.id).toBe(session.id);
    expect(consumed.lockedCode?.id).toBe(authorizationCode.id);
    expect(consumed.firstConsumption?.consumedAt).toBeInstanceOf(Date);
    expect(consumed.replay).toBeNull();

    const hidden = await withPlatformTransaction(runtime, async (client) => {
      await setAccountContext(client, secondAccount.id);
      return {
        installation: await repository.lockClientInstallation(
          client,
          installation.id,
        ),
        session: await repository.lockSessionById(client, session.id),
        authorizationCode: await repository.lockAuthorizationCodeByDigest(
          client,
          authorizationCodeDigest,
        ),
        digestMutation: await repository.consumeAuthorizationCode(client, {
          authorizationCodeId: authorizationCode.id,
          consumedAt: new Date(),
        }),
      };
    });
    expect(hidden).toEqual({
      installation: null,
      session: null,
      authorizationCode: null,
      digestMutation: null,
    });
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

  test("projects active and disabled module state with account entitlements", async () => {
    const moduleResult = await migrator.query<{ id: string }>(
      "select id from apollo_platform.modules where module_key = $1",
      ["tf.search"],
    );
    const moduleId = moduleResult.rows[0]!.id;
    const granted = await withPlatformTransaction(runtime, async (client) => {
      await setAccountContext(client, firstAccount.id);
      return repository.upsertAccountEntitlement(client, {
        accountId: firstAccount.id,
        moduleId,
        expiresAt: null,
        source: "operator",
        grantedByAccountId: null,
        reason: "module-state integration",
      });
    });
    expect(granted.moduleState).toBe("active");

    const readState = () =>
      withPlatformTransaction(runtime, async (client) => {
        await setAccountContext(client, firstAccount.id);
        const entitlements = await repository.listAccountEntitlements(
          client,
          firstAccount.id,
        );
        return entitlements.find(({ moduleKey }) => moduleKey === "tf.search")
          ?.moduleState;
      });

    await expect(readState()).resolves.toBe("active");
    await migrator.query(
      "update apollo_platform.modules set state = 'disabled' where id = $1",
      [moduleId],
    );
    try {
      await expect(readState()).resolves.toBe("disabled");
    } finally {
      await migrator.query(
        "update apollo_platform.modules set state = 'active' where id = $1",
        [moduleId],
      );
    }
  });

  test("exposes only the bounded operator overview while ordinary runtime stays isolated", async () => {
    const now = new Date();
    await withPlatformTransaction(runtime, async (client) => {
      await setAccountContext(client, firstAccount.id);
      await repository.updateAccountStatus(client, {
        accountId: firstAccount.id,
        status: "active",
        changedAt: now,
      });
      await repository.insertOperatorCapabilities(client, {
        accountId: firstAccount.id,
        capabilities: ["platform.accounts.manage"],
        grantedByAccountId: null,
        reason: "admin overview integration",
      });
    });
    await withPlatformTransaction(runtime, async (client) => {
      await setAccountContext(client, secondAccount.id);
      await repository.updateAccountStatus(client, {
        accountId: secondAccount.id,
        status: "active",
        changedAt: now,
      });
    });

    const roleSecurity = await migrator.query<{
      rolname: string;
      rolbypassrls: boolean;
    }>(`
      select rolname, rolbypassrls
      from pg_roles
      where rolname in ('apollo_platform_migrator', 'apollo_platform_runtime')
      order by rolname
    `);
    const functionSecurity = await migrator.query<{
      owner: string;
      security_definer: boolean;
    }>(`
      select pg_get_userbyid(proowner) as owner,
             prosecdef as security_definer
      from pg_proc
      where oid = 'apollo_platform.admin_account_overview(uuid,timestamptz,integer)'::regprocedure
    `);
    expect(roleSecurity.rows).toEqual([
      { rolname: "apollo_platform_migrator", rolbypassrls: false },
      { rolname: "apollo_platform_runtime", rolbypassrls: false },
    ]);
    expect(functionSecurity.rows).toEqual([
      {
        owner: "apollo_platform_migrator",
        security_definer: true,
      },
    ]);

    await expect(
      withPlatformTransaction(runtime, async (client) => {
        const accounts = await client.query(
          "select id from apollo_platform.accounts",
        );
        const sessions = await client.query(
          "select session_digest from apollo_platform.auth_sessions",
        );
        const mutation = await client.query(
          "update apollo_platform.accounts set display_name = display_name",
        );
        return [accounts.rowCount, sessions.rowCount, mutation.rowCount];
      }),
    ).resolves.toEqual([0, 0, 0]);
    await expect(
      runtime.query(
        "select * from apollo_platform.admin_account_overview($1, $2, $3)",
        [secondAccount.id, now, 100],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime.query(
        "select * from apollo_platform.admin_account_overview($1, $2, $3)",
        [firstAccount.id, now, null],
      ),
    ).rejects.toMatchObject({ code: "22023" });

    const overview = await new PlatformAdminOverviewService(
      runtime,
      repository,
      () => now,
    ).load();

    expect(overview).toMatchObject({
      total: 2,
      activeNow: 2,
      pending: 0,
      suspended: 0,
    });
    expect(overview.accounts.map(({ id }) => id).sort()).toEqual(
      [firstAccount.id, secondAccount.id].sort(),
    );
    expect(
      overview.accounts.map((account) => Object.keys(account).sort()),
    ).toEqual([
      [
        "activeSessionCount",
        "displayName",
        "email",
        "id",
        "latestActivityAt",
        "moduleKeys",
        "status",
      ],
      [
        "activeSessionCount",
        "displayName",
        "email",
        "id",
        "latestActivityAt",
        "moduleKeys",
        "status",
      ],
    ]);
    expect(JSON.stringify(overview)).not.toMatch(
      /session_digest|password|provider_user|token_digest/i,
    );
    await expect(
      runtime.query("select id from apollo_platform.accounts"),
    ).resolves.toMatchObject({ rowCount: 0 });
  });
});
