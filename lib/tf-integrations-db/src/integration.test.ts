import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresProviderAccountRepository,
  createIntegrationsPool,
  runIntegrationsMigrations,
  type EncryptedTokenEnvelopeV1,
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
    await repository.upsert({
      accountId,
      provider: "yandex",
      tokenEnvelope: encryptCanary(accountId, plaintextCanary),
      providerUserId: "integration-user",
      providerLogin: "integration-login",
      displayName: "Integration User",
    });

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
});
