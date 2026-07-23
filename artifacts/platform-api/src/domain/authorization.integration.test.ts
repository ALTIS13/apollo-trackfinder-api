import {
  createHash,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";

import {
  createPlatformPool,
  runPlatformMigrations,
  setAccountContext,
  withPlatformTransaction,
  type PlatformPoolProfile,
} from "@workspace/platform-db";
import type { JWK } from "jose";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";

import {
  AuthorizationService,
  pkceS256,
} from "./authorization.js";
import { PlatformAssertionSigner } from "./assertions.js";
import { OAuthClientRegistry } from "./oauth-clients.js";
import { PostgresPlatformRepository } from "./postgres-repository.js";

const migratorConnectionString = process.env.PLATFORM_TEST_DATABASE_URL;
const runtimeConnectionString = process.env.PLATFORM_TEST_RUNTIME_DATABASE_URL;
const describePostgres =
  migratorConnectionString && runtimeConnectionString
    ? describe.sequential
    : describe.skip;

const clientId = "apollo-tf-integration";
const clientSecret = "integration-client-secret";
const redirectUri = "https://integration.tf.apollot.ru/callback";
const correlationId = "40000000-0000-4000-8000-000000000004";
const state = "s".repeat(43);
const nonce = "n".repeat(43);
const verifier = "v".repeat(43);

function pool(
  connectionString: string,
  profile: PlatformPoolProfile = "runtime",
): Pool {
  return createPlatformPool(connectionString, profile);
}

function signingKeys(): {
  readonly privateJwk: JWK;
  readonly publicJwk: JWK;
} {
  const pair = generateKeyPairSync("ed25519");
  const kid = "authorization-integration";
  return {
    privateJwk: {
      ...pair.privateKey.export({ format: "jwk" }),
      alg: "EdDSA",
      use: "sig",
      kid,
    },
    publicJwk: {
      ...pair.publicKey.export({ format: "jwk" }),
      alg: "EdDSA",
      use: "sig",
      kid,
    },
  };
}

describePostgres("AuthorizationService PostgreSQL integration", () => {
  let migrator: Pool;
  let runtime: Pool;
  let service: AuthorizationService;

  beforeAll(async () => {
    migrator = pool(migratorConnectionString!, "migration");
    runtime = pool(runtimeConnectionString!);
    await runPlatformMigrations(migrator);
    const keys = signingKeys();
    const clients = OAuthClientRegistry.parse(
      [
        {
          clientId,
          audience: "apollo-tf",
          redirectUris: [redirectUri],
          clientSecretDigest: createHash("sha256")
            .update(clientSecret)
            .digest("hex"),
        },
      ],
      "production",
    );
    const signer = new PlatformAssertionSigner({
      issuer: "https://api.apollot.ru",
      activePrivateJwk: keys.privateJwk,
      publicJwks: [keys.publicJwk],
      clock: () => new Date(),
    });
    service = new AuthorizationService(
      runtime,
      new PostgresPlatformRepository(),
      clients,
      signer,
      () => new Date(),
      clientId,
    );
  });

  afterAll(async () => {
    try {
      await migrator?.query("drop schema if exists apollo_platform cascade");
      if (migrator !== undefined) {
        await runPlatformMigrations(migrator);
      }
    } finally {
      await Promise.all([migrator?.end(), runtime?.end()]);
    }
  });

  async function seedAccount(
    moduleKeys: readonly string[] = ["tf.search"],
  ): Promise<{
    readonly accountId: string;
    readonly sessionId: string;
    readonly installationId: string;
  }> {
    const accountId = randomUUID();
    const sessionId = randomUUID();
    const installationId = randomUUID();
    await withPlatformTransaction(migrator, async (client) => {
      await setAccountContext(client, accountId);
      await client.query(
        `
          insert into apollo_platform.accounts
            (id, email, display_name, status, email_verified_at, activated_at)
          values ($1, $2, 'Authorization Integration', 'active', now(), now())
        `,
        [accountId, `${accountId}@example.test`],
      );
      await client.query(
        `
          insert into apollo_platform.auth_sessions
            (id, account_id, session_digest, audience, expires_at)
          values ($1, $2, $3, 'apollo-portal', now() + interval '1 hour')
        `,
        [
          sessionId,
          accountId,
          createHash("sha256").update(sessionId).digest("hex"),
        ],
      );
      for (const moduleKey of moduleKeys) {
        await client.query(
          `
            insert into apollo_platform.account_module_entitlements
              (account_id, module_id, source, reason)
            select $1, id, 'integration', 'authorization integration'
            from apollo_platform.modules
            where module_key = $2
          `,
          [accountId, moduleKey],
        );
      }
    });
    return { accountId, sessionId, installationId };
  }

  async function issue(
    binding: Awaited<ReturnType<typeof seedAccount>>,
  ) {
    return service.issueCode(
      {
        accountId: binding.accountId,
        sessionId: binding.sessionId,
        status: "active",
        emailVerified: true,
      },
      {
        clientId,
        redirectUri,
        responseType: "code",
        codeChallenge: pkceS256(verifier),
        codeChallengeMethod: "S256",
        state,
        nonce,
        installationId: binding.installationId,
        installationLabel: "PostgreSQL integration",
      },
      { correlationId },
    );
  }

  function exchangeRequest(rawCode: string) {
    return {
      grantType: "authorization_code" as const,
      clientId,
      code: rawCode,
      codeVerifier: verifier,
      redirectUri,
    };
  }

  test("allows one concurrent exchange and rejects replay generically", async () => {
    const binding = await seedAccount();
    const issued = await issue(binding);

    const concurrent = await Promise.allSettled([
      service.exchangeCode(
        exchangeRequest(issued.rawCode),
        clientSecret,
        { correlationId },
      ),
      service.exchangeCode(
        exchangeRequest(issued.rawCode),
        clientSecret,
        { correlationId },
      ),
    ]);

    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = concurrent.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "invalid_grant" },
    });
    await expect(
      service.exchangeCode(
        exchangeRequest(issued.rawCode),
        clientSecret,
        { correlationId },
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  test.each(["account", "session"] as const)(
    "rejects exchange after %s revocation",
    async (revokedBinding) => {
      const binding = await seedAccount();
      const issued = await issue(binding);
      await withPlatformTransaction(migrator, async (client) => {
        await setAccountContext(client, binding.accountId);
        if (revokedBinding === "account") {
          await client.query(
            `
              update apollo_platform.accounts
              set status = 'suspended', suspended_at = now(), updated_at = now()
              where id = $1
            `,
            [binding.accountId],
          );
        } else {
          await client.query(
            `
              update apollo_platform.auth_sessions
              set revoked_at = now()
              where id = $1
            `,
            [binding.sessionId],
          );
        }
      });

      await expect(
        service.exchangeCode(
          exchangeRequest(issued.rawCode),
          clientSecret,
          { correlationId },
        ),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    },
  );

  test("projects entitlements at exchange and introspection time", async () => {
    const binding = await seedAccount(["tf.search"]);
    const issued = await issue(binding);
    await withPlatformTransaction(migrator, async (client) => {
      await setAccountContext(client, binding.accountId);
      await client.query(
        `
          update apollo_platform.account_module_entitlements as entitlement
          set revoked_at = now(), updated_at = now()
          from apollo_platform.modules as module
          where entitlement.account_id = $1
            and module.id = entitlement.module_id
            and module.module_key = 'tf.search'
        `,
        [binding.accountId],
      );
      await client.query(
        `
          insert into apollo_platform.account_module_entitlements
            (account_id, module_id, source, reason)
          select $1, id, 'integration', 'current projection'
          from apollo_platform.modules
          where module_key = 'tf.downloads'
        `,
        [binding.accountId],
      );
    });

    const exchanged = await service.exchangeCode(
      exchangeRequest(issued.rawCode),
      clientSecret,
      { correlationId },
    );
    expect(exchanged.claims.entitlements).toEqual(["tf.downloads"]);
    await expect(
      service.introspect(
        {
          accountId: binding.accountId,
          sessionId: binding.sessionId,
          installationId: binding.installationId,
          audience: "apollo-tf",
        },
        clientSecret,
      ),
    ).resolves.toMatchObject({
      active: true,
      entitlements: ["tf.downloads"],
    });

    await withPlatformTransaction(migrator, async (client) => {
      await setAccountContext(client, binding.accountId);
      await client.query(
        `
          update apollo_platform.account_module_entitlements
          set revoked_at = now(), updated_at = now()
          where account_id = $1 and revoked_at is null
        `,
        [binding.accountId],
      );
    });
    await expect(
      service.introspect(
        {
          accountId: binding.accountId,
          sessionId: binding.sessionId,
          installationId: binding.installationId,
          audience: "apollo-tf",
        },
        clientSecret,
      ),
    ).resolves.toMatchObject({ active: true, entitlements: [] });
  });
});
