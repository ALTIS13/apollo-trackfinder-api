import { randomBytes, randomUUID } from "node:crypto";

import type { Pool, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  INTEGRATIONS_MIGRATION_MANIFEST,
  PostgresProviderAccountRepository,
  type EncryptedTokenEnvelopeV1,
  type ProviderAccountRecord,
} from "./index.js";

type RecordedQuery = {
  readonly text: string;
  readonly values?: readonly unknown[];
};

class RepositoryPoolDouble {
  readonly queries: RecordedQuery[] = [];
  rows: QueryResultRow[] = [];
  rowCount = 0;
  failure?: unknown;

  async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.queries.push({ text, values });
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return {
      rows: this.rows,
      rowCount: this.rowCount,
    } as QueryResult;
  }
}

const accountId = "7a28499b-9603-489a-89b0-e57d72ccaf22";

function envelope(): EncryptedTokenEnvelopeV1 {
  return {
    version: 1,
    keyId: "2026-07",
    nonce: randomBytes(12).toString("base64url"),
    ciphertext: randomBytes(96).toString("base64url"),
    tag: randomBytes(16).toString("base64url"),
  };
}

function record(
  overrides: Partial<ProviderAccountRecord> = {},
): ProviderAccountRecord {
  return {
    accountId,
    provider: "spotify",
    tokenEnvelope: envelope(),
    providerUserId: "spotify-user-42",
    displayName: "Integration Person",
    ...overrides,
  };
}

function repository(double: RepositoryPoolDouble) {
  return new PostgresProviderAccountRepository(double as unknown as Pool);
}

describe("PostgresProviderAccountRepository", () => {
  it("uses parameterized SQL and never sends a plaintext token parameter", async () => {
    const plaintextCanary = `plaintext-token-${randomUUID()}`;
    const pool = new RepositoryPoolDouble();
    const stored = record();

    await repository(pool).upsert(stored);

    expect(pool.queries).toHaveLength(1);
    const query = pool.queries[0]!;
    expect(query.text).toMatch(
      /insert into apollo_tf_integrations\.provider_accounts/i,
    );
    expect(query.text).toMatch(/values \(\$1, \$2, \$3::jsonb, \$4, \$5\)/i);
    expect(query.text).not.toContain(accountId);
    expect(query.text).not.toContain(stored.providerUserId);
    expect(query.text).not.toContain(stored.displayName);
    expect(JSON.stringify(query.values)).not.toContain(plaintextCanary);
    expect(query.values).toEqual([
      stored.accountId,
      stored.provider,
      JSON.stringify(stored.tokenEnvelope),
      stored.providerUserId,
      stored.displayName,
    ]);
  });

  it("maps one canonical account-provider row and updates metadata atomically", async () => {
    const pool = new RepositoryPoolDouble();
    const stored = record({ provider: "yandex" });
    pool.rows = [
      {
        account_id: stored.accountId,
        provider: stored.provider,
        token_envelope: stored.tokenEnvelope,
        provider_user_id: stored.providerUserId,
        display_name: stored.displayName,
      },
    ];
    pool.rowCount = 1;

    await expect(
      repository(pool).get(stored.accountId, stored.provider),
    ).resolves.toEqual(stored);
    expect(pool.queries[0]?.values).toEqual([
      stored.accountId,
      stored.provider,
    ]);

    pool.queries.length = 0;
    await repository(pool).upsert(stored);
    expect(pool.queries[0]?.text).toMatch(
      /on conflict \(account_id, provider\) do update[\s\S]*token_envelope = excluded\.token_envelope[\s\S]*provider_user_id = excluded\.provider_user_id[\s\S]*display_name = excluded\.display_name[\s\S]*updated_at = now\(\)/i,
    );
    expect(pool.queries[0]?.text.match(/\b(insert|update)\b/gi)).toHaveLength(
      2,
    );
  });

  it("deletes only the requested account-provider row", async () => {
    const pool = new RepositoryPoolDouble();
    pool.rowCount = 1;

    await expect(repository(pool).delete(accountId, "spotify")).resolves.toBe(
      true,
    );

    expect(pool.queries).toEqual([
      {
        text: expect.stringMatching(
          /delete from apollo_tf_integrations\.provider_accounts\s+where account_id = \$1 and provider = \$2/i,
        ),
        values: [accountId, "spotify"],
      },
    ]);
  });

  it("reports readiness only when the expected migration is recorded", async () => {
    const pool = new RepositoryPoolDouble();
    const repo = repository(pool);
    pool.rows = [{ current: true }];
    pool.rowCount = 1;

    await expect(repo.isMigrationCurrent()).resolves.toBe(true);
    expect(pool.queries[0]?.values).toEqual([
      INTEGRATIONS_MIGRATION_MANIFEST.at(-1)?.name,
      INTEGRATIONS_MIGRATION_MANIFEST.at(-1)?.checksum,
      INTEGRATIONS_MIGRATION_MANIFEST.length,
    ]);

    pool.rows = [{ current: false }];
    await expect(repo.isMigrationCurrent()).resolves.toBe(false);
  });

  it("maps database failures to stable errors without leaking details", async () => {
    const connectionCanary = "postgres://admin:secret@database/integrations";
    const parameterCanary = `provider-user-${randomUUID()}`;
    const pool = new RepositoryPoolDouble();
    pool.failure = Object.assign(
      new Error(
        `${connectionCanary} failed with ${parameterCanary} in INSERT query`,
      ),
      { code: "23514", detail: parameterCanary },
    );

    let errorText = "";
    try {
      await repository(pool).upsert(
        record({ providerUserId: parameterCanary }),
      );
    } catch (error) {
      errorText = String(error);
      expect(error).toMatchObject({ code: "constraint_violation" });
    }

    expect(errorText).toBe(
      "Error: The provider account record violates a storage constraint.",
    );
    expect(errorText).not.toContain(connectionCanary);
    expect(errorText).not.toContain(parameterCanary);
    expect(errorText).not.toMatch(/insert|sqlstate/i);
  });
});
