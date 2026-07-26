import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresProviderAccountRepository,
  createIntegrationsPool,
  runIntegrationsMigrations,
  type EncryptedTokenEnvelopeV1,
  type ProviderAccountWrite,
  type TfIntegrationsCommandContext,
} from "./index.js";

const connectionString = process.env.TF_INTEGRATIONS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe.sequential : describe.skip;

function encryptCanary(
  accountId: string,
  plaintextCanary: string,
): EncryptedTokenEnvelopeV1 {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(
    Buffer.from(`apollo-tf-integrations-token:v1:yandex:${accountId}`, "utf8"),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ oauthToken: plaintextCanary }), "utf8"),
    cipher.final(),
  ]);

  return {
    version: 1,
    keyId: "integration-test",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function commandContext(
  controller = new AbortController(),
  deadlineAt = Date.now() + 5_000,
): TfIntegrationsCommandContext {
  return { signal: controller.signal, deadlineAt };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForBlockedMutation(client: PoolClient): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.query<{ blocked: boolean }>(`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and query like '%provider_accounts%'
          and state = 'active'
          and wait_event_type = 'Lock'
      ) as blocked
    `);
    if (result.rows[0]?.blocked === true) return;
    await delay(10);
  }
  const activity = await client.query<{
    state: string;
    wait_event_type: string | null;
    wait_event: string | null;
    query: string;
  }>(`
    select state, wait_event_type, wait_event, query
    from pg_stat_activity
    where datname = current_database()
      and pid <> pg_backend_pid()
  `);
  throw new Error(
    `Timed out waiting for blocked provider mutation: ${JSON.stringify(
      activity.rows.map((row) => ({
        state: row.state,
        waitEventType: row.wait_event_type,
        waitEvent: row.wait_event,
        queryKind: row.query.match(/\b(select|insert|update|delete)\b/i)?.[1],
      })),
    )}`,
  );
}

describePostgres("integrations disposable PostgreSQL boundary", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createIntegrationsPool(connectionString!, "migration");
    await pool.query("drop schema if exists apollo_tf_integrations cascade");
    await runIntegrationsMigrations(pool);
  });

  afterAll(async () => {
    try {
      await pool?.query("drop schema if exists apollo_tf_integrations cascade");
    } finally {
      await pool?.end();
    }
  });

  it("persists no plaintext canary in a disposable PostgreSQL database", async () => {
    const plaintextCanary = `plaintext-${randomUUID()}`;
    const accountId = randomUUID();
    const repository = new PostgresProviderAccountRepository(pool);
    await repository.upsert(
      {
        accountId,
        provider: "yandex",
        tokenEnvelope: encryptCanary(accountId, plaintextCanary),
        providerUserId: "integration-user",
        providerLogin: "integration-login",
        displayName: "Integration User",
      },
      commandContext(),
    );

    await expect(repository.get(accountId, "yandex")).resolves.toMatchObject({
      accountId,
      provider: "yandex",
      providerUserId: "integration-user",
      providerLogin: "integration-login",
      displayName: "Integration User",
    });

    const databaseText = await pool.query<{ contents: string }>(`
      select coalesce(string_agg(row_to_json(provider_accounts)::text, ''), '')
        as contents
      from apollo_tf_integrations.provider_accounts
    `);
    expect(databaseText.rows[0]?.contents).not.toContain(plaintextCanary);

    const columns = await pool.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'apollo_tf_integrations'
      order by table_name, ordinal_position
    `);
    expect(columns.rows.map(({ column_name }) => column_name)).not.toEqual(
      expect.arrayContaining(["access_token", "refresh_token", "oauth_token"]),
    );
  });

  it("rejects stale refresh generations after disconnect and reconnect", async () => {
    const repository = new PostgresProviderAccountRepository(pool);
    const accountId = randomUUID();
    const firstEnvelope = encryptCanary(accountId, `first-${randomUUID()}`);
    const staleEnvelope = encryptCanary(accountId, `stale-${randomUUID()}`);
    const replacementEnvelope = encryptCanary(
      accountId,
      `replacement-${randomUUID()}`,
    );

    await repository.upsert(
      {
        accountId,
        provider: "yandex",
        tokenEnvelope: firstEnvelope,
        providerUserId: "integration-user",
        providerLogin: "integration-login",
        displayName: "Integration User",
      },
      commandContext(),
    );
    const first = await repository.get(accountId, "yandex");
    expect(first).not.toBeNull();

    await repository.delete(accountId, "yandex", commandContext());
    await expect(
      repository.updateTokenEnvelopeIfGeneration(
        accountId,
        "yandex",
        first!.generation,
        staleEnvelope,
        commandContext(),
      ),
    ).resolves.toBe(false);
    await expect(repository.get(accountId, "yandex")).resolves.toBeNull();

    await repository.upsert(
      {
        accountId,
        provider: "yandex",
        tokenEnvelope: replacementEnvelope,
        providerUserId: "replacement-user",
        providerLogin: "replacement-login",
        displayName: "Replacement User",
      },
      commandContext(),
    );
    const replacement = await repository.get(accountId, "yandex");
    expect(replacement?.generation).not.toBe(first!.generation);
    await expect(
      repository.updateTokenEnvelopeIfGeneration(
        accountId,
        "yandex",
        first!.generation,
        staleEnvelope,
        commandContext(),
      ),
    ).resolves.toBe(false);
    await expect(repository.get(accountId, "yandex")).resolves.toEqual(
      replacement,
    );
  });

  it("never makes an aborted in-flight mutation visible after its deadline", async () => {
    const repository = new PostgresProviderAccountRepository(pool);
    const accountId = randomUUID();
    const original: ProviderAccountWrite = {
      accountId,
      provider: "yandex",
      tokenEnvelope: encryptCanary(accountId, `original-${randomUUID()}`),
      providerUserId: "original-user",
      providerLogin: "original-login",
      displayName: "Original User",
    };
    await repository.upsert(original, commandContext());

    const blocker = await pool.connect();
    const mutationConnection = await pool.connect();
    mutationConnection.release();
    let blockerTransaction = false;
    try {
      await blocker.query("BEGIN");
      blockerTransaction = true;
      const locked = await blocker.query(
        `
          select 1
          from apollo_tf_integrations.provider_accounts
          where account_id = $1 and provider = $2
          for update
        `,
        [accountId, "yandex"],
      );
      expect(locked.rowCount).toBe(1);

      const controller = new AbortController();
      const deadlineAt = Date.now() + 500;
      const pending = repository.upsert(
        {
          ...original,
          tokenEnvelope: encryptCanary(
            accountId,
            `replacement-${randomUUID()}`,
          ),
          providerUserId: "replacement-user",
          providerLogin: "replacement-login",
          displayName: "Replacement User",
        },
        commandContext(controller, deadlineAt),
      );
      let earlyOutcome: string | undefined;
      void pending.then(
        () => {
          earlyOutcome = "resolved";
        },
        (error: unknown) => {
          earlyOutcome = `rejected:${
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : "unknown"
          }`;
        },
      );
      await delay(25);
      if (earlyOutcome !== undefined) {
        throw new Error(`Mutation settled before blocking: ${earlyOutcome}`);
      }
      await waitForBlockedMutation(blocker);
      controller.abort();

      await delay(Math.max(0, deadlineAt - Date.now()) + 100);
      await blocker.query("ROLLBACK");
      blockerTransaction = false;
      const outcome = await pending.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({
          status: "rejected" as const,
          code:
            typeof error === "object" && error !== null && "code" in error
              ? error.code
              : undefined,
        }),
      );

      await delay(100);
      const persisted = await repository.get(accountId, "yandex");
      expect({
        outcome,
        providerUserId: persisted?.providerUserId,
        providerLogin: persisted?.providerLogin,
        displayName: persisted?.displayName,
      }).toEqual({
        outcome: {
          status: "rejected",
          code: "storage_unavailable",
        },
        providerUserId: "original-user",
        providerLogin: "original-login",
        displayName: "Original User",
      });
    } finally {
      if (blockerTransaction) {
        await blocker.query("ROLLBACK");
      }
      blocker.release();
    }
  });
});
