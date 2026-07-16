import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, QueryResult } from "pg";
import { afterEach, describe, expect, test } from "vitest";

import {
  createPlatformPool,
  setAccountContext,
  withPlatformTransaction,
} from "./index.js";
import { runPlatformMigrations } from "./migrations.js";

type RecordedQuery = {
  text: string;
  values?: readonly unknown[];
};

class MigrationClientDouble {
  readonly history = new Map<string, string>();
  readonly queries: RecordedQuery[] = [];
  releaseCount = 0;

  async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.queries.push({ text, values });

    if (text.includes("select name, checksum")) {
      return {
        rows: [...this.history].map(([name, checksum]) => ({ name, checksum })),
        rowCount: this.history.size,
      } as QueryResult;
    }

    if (text.includes("insert into apollo_platform.schema_migrations")) {
      const [name, checksum] = values ?? [];
      this.history.set(String(name), String(checksum));
    }

    return { rows: [], rowCount: 0 } as unknown as QueryResult;
  }

  release(): void {
    this.releaseCount += 1;
  }
}

class MigrationPoolDouble {
  readonly client = new MigrationClientDouble();

  async connect(): Promise<MigrationClientDouble> {
    return this.client;
  }
}

const temporaryDirectories: string[] = [];

async function fixtureDirectory(
  files: Record<string, string>,
): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "apollo-platform-migrations-"),
  );
  temporaryDirectories.push(directory);

  await Promise.all(
    Object.entries(files).map(([name, sql]) =>
      writeFile(join(directory, name), sql, "utf8"),
    ),
  );

  return directory;
}

function asPool(double: MigrationPoolDouble): Pool {
  return double as unknown as Pool;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("runPlatformMigrations", () => {
  test("applies numeric SQL migrations with immutable checksums and one transaction each", async () => {
    const directory = await fixtureDirectory({
      "0002_second.sql": "select 'second migration';",
      "0001_first.sql": "select 'first migration';",
      "README.md": "ignored",
      "0003-invalid.sql": "select 'also ignored';",
    });
    const pool = new MigrationPoolDouble();

    await expect(
      runPlatformMigrations(asPool(pool), directory),
    ).resolves.toEqual({
      applied: ["0001_first.sql", "0002_second.sql"],
      alreadyApplied: [],
    });

    expect([...pool.client.history]).toEqual([
      [
        "0001_first.sql",
        createHash("sha256").update("select 'first migration';").digest("hex"),
      ],
      [
        "0002_second.sql",
        createHash("sha256").update("select 'second migration';").digest("hex"),
      ],
    ]);
    expect(
      pool.client.queries
        .map(({ text }) => text.trim())
        .filter((text) => /^(begin|commit|rollback)$/i.test(text)),
    ).toEqual(["BEGIN", "COMMIT", "BEGIN", "COMMIT"]);

    const statements = pool.client.queries.map(({ text }) => text);
    const lockIndex = statements.findIndex((text) =>
      text.includes("pg_advisory_lock"),
    );
    const firstMigrationIndex = statements.indexOf("select 'first migration';");
    const secondMigrationIndex = statements.indexOf(
      "select 'second migration';",
    );
    const unlockIndex = statements.findIndex((text) =>
      text.includes("pg_advisory_unlock"),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(firstMigrationIndex).toBeGreaterThan(lockIndex);
    expect(secondMigrationIndex).toBeGreaterThan(firstMigrationIndex);
    expect(unlockIndex).toBeGreaterThan(secondMigrationIndex);
    expect(pool.client.releaseCount).toBe(1);
  });

  test("reports already-applied migrations without opening transactions", async () => {
    const directory = await fixtureDirectory({
      "0001_first.sql": "select 'first migration';",
      "0002_second.sql": "select 'second migration';",
    });
    const pool = new MigrationPoolDouble();
    await runPlatformMigrations(asPool(pool), directory);
    pool.client.queries.length = 0;

    await expect(
      runPlatformMigrations(asPool(pool), directory),
    ).resolves.toEqual({
      applied: [],
      alreadyApplied: ["0001_first.sql", "0002_second.sql"],
    });

    expect(
      pool.client.queries.filter(({ text }) =>
        /^(begin|commit|rollback)$/i.test(text),
      ),
    ).toEqual([]);
    expect(pool.client.releaseCount).toBe(2);
  });

  test("rejects a changed migration checksum and still releases the advisory lock", async () => {
    const originalDirectory = await fixtureDirectory({
      "0001_first.sql": "select 'original migration';",
    });
    const mutatedDirectory = await fixtureDirectory({
      "0001_first.sql": "select 'mutated migration';",
    });
    const pool = new MigrationPoolDouble();
    await runPlatformMigrations(asPool(pool), originalDirectory);
    pool.client.queries.length = 0;

    await expect(
      runPlatformMigrations(asPool(pool), mutatedDirectory),
    ).rejects.toMatchObject({
      code: "migration_checksum_mismatch",
    });

    expect(
      pool.client.queries.filter(({ text }) =>
        /^(begin|commit|rollback)$/i.test(text),
      ),
    ).toEqual([]);
    expect(pool.client.queries.at(-1)?.text).toContain("pg_advisory_unlock");
    expect(pool.client.releaseCount).toBe(2);
  });
});

describe("platform database helpers", () => {
  test("creates a PostgreSQL pool for the supplied connection string", async () => {
    const connectionString =
      "postgres://runtime:secret@127.0.0.1:5432/platform";
    const pool = createPlatformPool(connectionString);

    expect(pool.options.connectionString).toBe(connectionString);

    await pool.end();
  });

  test("sets account context inside a committed transaction", async () => {
    const pool = new MigrationPoolDouble();
    const accountId = "d55977df-c87e-4f86-bd2b-4e95afc9402a";

    await expect(
      withPlatformTransaction(asPool(pool), async (client) => {
        await setAccountContext(client, accountId);
        return "committed";
      }),
    ).resolves.toBe("committed");

    expect(pool.client.queries).toEqual([
      { text: "BEGIN", values: undefined },
      {
        text: "select set_config('app.account_id', $1, true)",
        values: [accountId],
      },
      { text: "COMMIT", values: undefined },
    ]);
    expect(pool.client.releaseCount).toBe(1);
  });

  test("rolls back and releases the client when a transaction callback fails", async () => {
    const pool = new MigrationPoolDouble();
    const failure = new Error("callback failed");

    await expect(
      withPlatformTransaction(asPool(pool), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(pool.client.queries).toEqual([
      { text: "BEGIN", values: undefined },
      { text: "ROLLBACK", values: undefined },
    ]);
    expect(pool.client.releaseCount).toBe(1);
  });
});
