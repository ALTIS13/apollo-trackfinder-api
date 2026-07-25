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
const firstGeneration = "11111111-1111-4111-8111-111111111111";
const secondGeneration = "22222222-2222-4222-8222-222222222222";

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
    generation: firstGeneration,
    tokenEnvelope: envelope(),
    providerUserId: "spotify-user-42",
    displayName: "Integration Person",
    ...overrides,
  };
}

function repository(
  double: RepositoryPoolDouble,
  generations: readonly string[] = [firstGeneration],
) {
  const remaining = [...generations];
  return new PostgresProviderAccountRepository(
    double as unknown as Pool,
    () => remaining.shift()!,
  );
}

describe("PostgresProviderAccountRepository", () => {
  it("uses parameterized SQL and creates a fresh unguessable generation for every replacement", async () => {
    const pool = new RepositoryPoolDouble();
    const stored = record();
    const target = repository(pool, [firstGeneration, secondGeneration]);

    await target.upsert(stored);
    await target.upsert(stored);

    expect(pool.queries).toHaveLength(2);
    const query = pool.queries[0]!;
    expect(query.text).toMatch(
      /insert into apollo_tf_integrations\.provider_accounts/i,
    );
    expect(query.text).toMatch(
      /values \(\$1, \$2, \$3::uuid, \$4::jsonb, \$5, \$6, \$7\)/i,
    );
    expect(query.text).not.toContain(accountId);
    expect(query.text).not.toContain(stored.providerUserId);
    expect(query.text).not.toContain(stored.displayName);
    expect(query.values).toEqual([
      stored.accountId,
      stored.provider,
      firstGeneration,
      JSON.stringify(stored.tokenEnvelope),
      stored.providerUserId,
      stored.displayName,
      null,
    ]);
    expect(pool.queries[1]?.values?.[2]).toBe(secondGeneration);
    expect(pool.queries[1]?.values?.[2]).not.toBe(firstGeneration);
  });

  it("maps one canonical account-provider row and updates metadata atomically", async () => {
    const pool = new RepositoryPoolDouble();
    const stored = {
      ...record({ provider: "yandex" }),
      providerLogin: "yandex-user",
    } as ProviderAccountRecord;
    pool.rows = [
      {
        account_id: stored.accountId,
        provider: stored.provider,
        generation: firstGeneration,
        token_envelope: stored.tokenEnvelope,
        provider_user_id: stored.providerUserId,
        display_name: stored.displayName,
        provider_login: "yandex-user",
      },
    ];
    pool.rowCount = 1;

    await expect(
      repository(pool).get(stored.accountId, stored.provider),
    ).resolves.toEqual({ ...stored, generation: firstGeneration });
    expect(pool.queries[0]?.values).toEqual([
      stored.accountId,
      stored.provider,
    ]);

    pool.queries.length = 0;
    await repository(pool).upsert(stored);
    expect(pool.queries[0]?.text).toMatch(
      /on conflict \(account_id, provider\) do update[\s\S]*generation = excluded\.generation[\s\S]*token_envelope = excluded\.token_envelope[\s\S]*provider_user_id = excluded\.provider_user_id[\s\S]*display_name = excluded\.display_name[\s\S]*provider_login = excluded\.provider_login[\s\S]*updated_at = now\(\)/i,
    );
    expect(pool.queries[0]?.text.match(/\b(insert|update)\b/gi)).toHaveLength(
      2,
    );
  });

  it("keeps legacy Yandex metadata without login explicit and rejects cross-provider login", async () => {
    const pool = new RepositoryPoolDouble();
    const legacy = record({ provider: "yandex" });
    pool.rows = [
      {
        account_id: legacy.accountId,
        provider: legacy.provider,
        generation: firstGeneration,
        token_envelope: legacy.tokenEnvelope,
        provider_user_id: legacy.providerUserId,
        display_name: legacy.displayName,
        provider_login: null,
      },
    ];

    await expect(
      repository(pool).get(legacy.accountId, "yandex"),
    ).resolves.toEqual({ ...legacy, generation: firstGeneration });
    await expect(
      repository(pool).upsert(legacy),
    ).rejects.toMatchObject({ code: "constraint_violation" });
    await expect(
      repository(pool).upsert({
        ...record(),
        providerLogin: "spotify-login",
      } as ProviderAccountRecord),
    ).rejects.toMatchObject({ code: "constraint_violation" });
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

  it("refreshes only the exact loaded generation and can never insert a missing row", async () => {
    const pool = new RepositoryPoolDouble();
    const target = repository(pool);
    pool.rowCount = 0;

    await expect(
      target.updateTokenEnvelopeIfGeneration(
        accountId,
        "spotify",
        firstGeneration,
        envelope(),
      ),
    ).resolves.toBe(false);

    expect(pool.queries).toEqual([
      {
        text: expect.stringMatching(
          /update apollo_tf_integrations\.provider_accounts[\s\S]*set token_envelope = \$4::jsonb[\s\S]*where account_id = \$1[\s\S]*and provider = \$2[\s\S]*and generation = \$3::uuid/i,
        ),
        values: [
          accountId,
          "spotify",
          firstGeneration,
          expect.any(String),
        ],
      },
    ]);
    expect(pool.queries[0]?.text).not.toMatch(/\binsert\b/i);

    pool.rowCount = 1;
    await expect(
      target.updateTokenEnvelopeIfGeneration(
        accountId,
        "spotify",
        firstGeneration,
        envelope(),
      ),
    ).resolves.toBe(true);
  });

  it("reports readiness only when the expected migration is recorded", async () => {
    const pool = new RepositoryPoolDouble();
    const repo = repository(pool);
    pool.rows = [{ current: true }];
    pool.rowCount = 1;

    await expect(repo.isMigrationCurrent()).resolves.toBe(true);
    expect(pool.queries[0]?.values).toEqual([
      JSON.stringify(INTEGRATIONS_MIGRATION_MANIFEST),
      INTEGRATIONS_MIGRATION_MANIFEST.length,
    ]);
    expect(pool.queries[0]?.text).toMatch(
      /jsonb_array_elements\(\$1::jsonb\)/i,
    );
    expect(pool.queries[0]?.text).toMatch(
      /where persisted\.name = expected\.name[\s\S]*and persisted\.checksum = expected\.checksum/i,
    );

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
