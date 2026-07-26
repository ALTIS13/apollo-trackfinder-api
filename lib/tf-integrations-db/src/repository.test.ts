import { randomBytes, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  INTEGRATIONS_MIGRATION_MANIFEST,
  PostgresProviderAccountRepository,
  type EncryptedTokenEnvelopeV1,
  type ProviderAccountRecord,
  type TfIntegrationsCommandContext,
} from "./index.js";

type RecordedQuery = {
  readonly text: string;
  readonly values?: readonly unknown[];
};

class RepositoryPoolDouble {
  readonly queries: RecordedQuery[] = [];
  readonly client: RepositoryClientDouble;
  connectCalls = 0;
  rows: QueryResultRow[] = [];
  rowCount = 0;
  failure?: unknown;
  failurePattern = /\b(insert|update|delete)\b/i;
  #blockedPattern?: RegExp;
  #blockedResolve?: (result: QueryResult) => void;
  #blockedReject?: (error: Error) => void;
  #blockedStarted?: () => void;

  constructor() {
    this.client = new RepositoryClientDouble(this);
  }

  async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    return this.execute(text, values);
  }

  async connect(): Promise<PoolClient> {
    this.connectCalls += 1;
    return this.client as unknown as PoolClient;
  }

  async execute(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult> {
    this.queries.push({ text, values });
    if (this.failure !== undefined && this.failurePattern.test(text)) {
      throw this.failure;
    }
    if (this.#blockedPattern?.test(text)) {
      this.#blockedPattern = undefined;
      this.#blockedStarted?.();
      return await new Promise<QueryResult>((resolve, reject) => {
        this.#blockedResolve = resolve;
        this.#blockedReject = reject;
      });
    }
    return {
      rows: this.rows,
      rowCount: this.rowCount,
    } as QueryResult;
  }

  blockNextMutation(pattern: RegExp): Promise<void> {
    this.#blockedPattern = pattern;
    return new Promise<void>((resolve) => {
      this.#blockedStarted = resolve;
    });
  }

  completeBlockedMutation(): void {
    this.#blockedResolve?.({
      rows: this.rows,
      rowCount: this.rowCount,
    } as QueryResult);
    this.#clearBlockedMutation();
  }

  destroyBlockedMutation(): void {
    this.#blockedReject?.(new Error("test connection destroyed"));
    this.#clearBlockedMutation();
  }

  #clearBlockedMutation(): void {
    this.#blockedResolve = undefined;
    this.#blockedReject = undefined;
    this.#blockedStarted = undefined;
  }
}

class RepositoryClientDouble {
  readonly releases: Array<Error | boolean | undefined> = [];
  destroyed = false;
  readonly #pool: RepositoryPoolDouble;

  constructor(pool: RepositoryPoolDouble) {
    this.#pool = pool;
  }

  async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    return this.#pool.execute(text, values);
  }

  release(error?: Error | boolean): void {
    this.releases.push(error);
    if (error === true || error instanceof Error) {
      this.destroyed = true;
      this.#pool.destroyBlockedMutation();
    }
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

function commandContext(
  controller = new AbortController(),
): TfIntegrationsCommandContext {
  return {
    signal: controller.signal,
    deadlineAt: Date.now() + 5_000,
  };
}

function findQuery(pool: RepositoryPoolDouble, pattern: RegExp): RecordedQuery {
  const query = pool.queries.find(({ text }) => pattern.test(text));
  if (query === undefined) {
    throw new Error(`Missing expected query: ${pattern.source}`);
  }
  return query;
}

describe("PostgresProviderAccountRepository", () => {
  it("uses parameterized SQL and creates a fresh unguessable generation for every replacement", async () => {
    const pool = new RepositoryPoolDouble();
    const stored = record();
    const target = repository(pool, [firstGeneration, secondGeneration]);

    await target.upsert(stored, commandContext());
    await target.upsert(stored, commandContext());

    const writes = pool.queries.filter(({ text }) =>
      /insert into apollo_tf_integrations\.provider_accounts/i.test(text),
    );
    expect(writes).toHaveLength(2);
    const query = writes[0]!;
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
    expect(writes[1]?.values?.[2]).toBe(secondGeneration);
    expect(writes[1]?.values?.[2]).not.toBe(firstGeneration);
  });

  it("runs a successful mutation in one deadline-bounded checked-out transaction", async () => {
    const pool = new RepositoryPoolDouble();
    const target = repository(pool);

    await target.upsert(record(), commandContext());

    expect(pool.connectCalls).toBe(1);
    expect(pool.queries.map(({ text }) => text.trim())).toEqual([
      "BEGIN",
      expect.stringMatching(/^SET LOCAL statement_timeout = \d+$/i),
      expect.stringMatching(/^SET LOCAL lock_timeout = \d+$/i),
      expect.stringMatching(
        /^insert into apollo_tf_integrations\.provider_accounts/i,
      ),
      "COMMIT",
    ]);
    expect(pool.client.releases).toEqual([undefined]);
    expect(pool.client.destroyed).toBe(false);

    const statementTimeout = Number(
      findQuery(pool, /^SET LOCAL statement_timeout/i).text.match(/\d+/)?.[0],
    );
    const lockTimeout = Number(
      findQuery(pool, /^SET LOCAL lock_timeout/i).text.match(/\d+/)?.[0],
    );
    expect(statementTimeout).toBeGreaterThan(0);
    expect(statementTimeout).toBeLessThanOrEqual(5_000);
    expect(lockTimeout).toBeGreaterThan(0);
    expect(lockTimeout).toBeLessThanOrEqual(3_000);
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
    await repository(pool).upsert(stored, commandContext());
    const write = findQuery(
      pool,
      /insert into apollo_tf_integrations\.provider_accounts/i,
    );
    expect(write.text).toMatch(
      /on conflict \(account_id, provider\) do update[\s\S]*generation = excluded\.generation[\s\S]*token_envelope = excluded\.token_envelope[\s\S]*provider_user_id = excluded\.provider_user_id[\s\S]*display_name = excluded\.display_name[\s\S]*provider_login = excluded\.provider_login[\s\S]*updated_at = now\(\)/i,
    );
    expect(write.text.match(/\b(insert|update)\b/gi)).toHaveLength(2);
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
      repository(pool).upsert(legacy, commandContext()),
    ).rejects.toMatchObject({ code: "constraint_violation" });
    await expect(
      repository(pool).upsert(
        {
          ...record(),
          providerLogin: "spotify-login",
        } as ProviderAccountRecord,
        commandContext(),
      ),
    ).rejects.toMatchObject({ code: "constraint_violation" });
  });

  it("deletes only the requested account-provider row", async () => {
    const pool = new RepositoryPoolDouble();
    pool.rowCount = 1;

    await expect(
      repository(pool).delete(accountId, "spotify", commandContext()),
    ).resolves.toBe(true);

    expect(
      findQuery(pool, /delete from apollo_tf_integrations\.provider_accounts/i),
    ).toEqual({
      text: expect.stringMatching(
        /delete from apollo_tf_integrations\.provider_accounts\s+where account_id = \$1 and provider = \$2/i,
      ),
      values: [accountId, "spotify"],
    });
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
        commandContext(),
      ),
    ).resolves.toBe(false);

    const update = findQuery(
      pool,
      /update apollo_tf_integrations\.provider_accounts/i,
    );
    expect(update).toEqual({
      text: expect.stringMatching(
        /update apollo_tf_integrations\.provider_accounts[\s\S]*set token_envelope = \$4::jsonb[\s\S]*where account_id = \$1[\s\S]*and provider = \$2[\s\S]*and generation = \$3::uuid/i,
      ),
      values: [accountId, "spotify", firstGeneration, expect.any(String)],
    });
    expect(update.text).not.toMatch(/\binsert\b/i);

    pool.rowCount = 1;
    await expect(
      target.updateTokenEnvelopeIfGeneration(
        accountId,
        "spotify",
        firstGeneration,
        envelope(),
        commandContext(),
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
        commandContext(),
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
    expect(pool.queries.map(({ text }) => text.trim())).toContain("ROLLBACK");
    expect(pool.queries.map(({ text }) => text.trim())).not.toContain("COMMIT");
    expect(pool.client.releases).toEqual([undefined]);
  });

  it("destroys an in-flight mutation connection on abort so it cannot commit later", async () => {
    const pool = new RepositoryPoolDouble();
    const controller = new AbortController();
    const started = pool.blockNextMutation(
      /insert into apollo_tf_integrations\.provider_accounts/i,
    );
    const pending = repository(pool).upsert(
      record(),
      commandContext(controller),
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: "storage_unavailable",
    });

    await started;
    controller.abort();
    pool.completeBlockedMutation();

    await rejected;
    expect(pool.client.destroyed).toBe(true);
    expect(pool.client.releases).toEqual([true]);
    expect(pool.queries.map(({ text }) => text.trim())).not.toContain("COMMIT");
  });
});
