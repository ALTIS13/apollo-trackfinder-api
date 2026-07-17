import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import type { MigrationManifestEntry } from "./migrations.js";

type RecordedQuery = {
  text: string;
  values?: readonly unknown[];
};

class MigrationClientDouble {
  readonly events: string[] = [];
  readonly history = new Map<string, string>();
  readonly queries: RecordedQuery[] = [];
  failure?: { error: Error; text: string };
  releaseCount = 0;
  readonly releaseErrors: (Error | undefined)[] = [];

  async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.events.push(text);
    this.queries.push({ text, values });

    if (this.failure?.text === text) {
      throw this.failure.error;
    }

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

  release(error?: Error): void {
    this.events.push("release");
    this.releaseCount += 1;
    this.releaseErrors.push(error);
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

async function fixtureManifest(
  directory: string,
  names: readonly string[],
): Promise<readonly MigrationManifestEntry[]> {
  return Promise.all(
    names.map(async (name) => ({
      name,
      checksum: createHash("sha256")
        .update(await readFile(join(directory, name), "utf8"))
        .digest("hex"),
    })),
  );
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
  test("refuses filesystem migrations that are absent from the immutable manifest", async () => {
    const directory = await fixtureDirectory({
      "0001_first.sql": "select 'first migration';",
      "0002_unreviewed.sql": "select 'unreviewed migration';",
    });
    const manifest = await fixtureManifest(directory, ["0001_first.sql"]);
    const pool = new MigrationPoolDouble();

    await expect(
      runPlatformMigrations(asPool(pool), directory, manifest),
    ).rejects.toMatchObject({ code: "migration_manifest_mismatch" });
    expect(pool.client.queries).toEqual([]);
  });

  test("refuses a manifest checksum that differs from its filesystem migration", async () => {
    const directory = await fixtureDirectory({
      "0001_first.sql": "select 'first migration';",
    });
    const pool = new MigrationPoolDouble();

    await expect(
      runPlatformMigrations(asPool(pool), directory, [
        { name: "0001_first.sql", checksum: "wrong" },
      ]),
    ).rejects.toMatchObject({ code: "migration_manifest_mismatch" });
    expect(pool.client.queries).toEqual([]);
  });

  test("refuses persisted migration rows absent from the immutable manifest", async () => {
    const directory = await fixtureDirectory({
      "0001_first.sql": "select 'first migration';",
    });
    const manifest = await fixtureManifest(directory, ["0001_first.sql"]);
    const pool = new MigrationPoolDouble();
    pool.client.history.set("9999_untrusted.sql", "extra");

    await expect(
      runPlatformMigrations(asPool(pool), directory, manifest),
    ).rejects.toMatchObject({ code: "migration_history_mismatch" });
    expect(pool.client.queries.at(-1)?.text).toContain("pg_advisory_unlock");
    expect(pool.client.releaseCount).toBe(1);
  });

  test("ships an immutable bootstrap marker migration with a terminal insert trigger", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0002_operator_bootstrap_guard.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(sql).toMatch(/add column operator_bootstrap_account_id uuid/i);
    expect(sql).toMatch(
      /add column operator_bootstrap_completed_at timestamptz/i,
    );
    expect(sql).toMatch(/operator_bootstrap_metadata_check/i);
    expect(sql).toMatch(
      /from apollo_platform\.operator_roles[\s\S]*revoked_at is null/i,
    );
    expect(sql).toMatch(/before insert on apollo_platform\.operator_roles/i);
    expect(sql).toMatch(
      /for each row execute function apollo_platform\.record_operator_bootstrap\(\)/i,
    );
    expect(sql).toMatch(/operator_bootstrap_account_id is null/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(
      /revoke update on apollo_platform\.registration_settings[\s\S]*from apollo_platform_runtime/i,
    );
    expect(sql).toMatch(
      /grant update \(mode, revision, updated_by_account_id, updated_at\)[\s\S]*to apollo_platform_runtime/i,
    );
    expect(sql).toMatch(
      /revoke execute on function apollo_platform\.record_operator_bootstrap\(\)[\s\S]*from public/i,
    );
    expect(sql).not.toMatch(/disable row level security|bypassrls/i);
  });

  test("applies numeric SQL migrations with immutable checksums and one transaction each", async () => {
    const directory = await fixtureDirectory({
      "0002_second.sql": "select 'second migration';",
      "0001_first.sql": "select 'first migration';",
      "README.md": "ignored",
      "0003-invalid.sql": "select 'also ignored';",
    });
    const manifest = await fixtureManifest(directory, [
      "0001_first.sql",
      "0002_second.sql",
    ]);
    const pool = new MigrationPoolDouble();

    await expect(
      runPlatformMigrations(asPool(pool), directory, manifest),
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
    const manifest = await fixtureManifest(directory, [
      "0001_first.sql",
      "0002_second.sql",
    ]);
    const pool = new MigrationPoolDouble();
    await runPlatformMigrations(asPool(pool), directory, manifest);
    pool.client.queries.length = 0;

    await expect(
      runPlatformMigrations(asPool(pool), directory, manifest),
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

  test("rejects a changed persisted checksum and still releases the advisory lock", async () => {
    const originalDirectory = await fixtureDirectory({
      "0001_first.sql": "select 'original migration';",
    });
    const manifest = await fixtureManifest(originalDirectory, [
      "0001_first.sql",
    ]);
    const pool = new MigrationPoolDouble();
    await runPlatformMigrations(asPool(pool), originalDirectory, manifest);
    pool.client.queries.length = 0;
    pool.client.history.set("0001_first.sql", "changed-persisted-checksum");

    await expect(
      runPlatformMigrations(asPool(pool), originalDirectory, manifest),
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

  test("rolls back failed SQL without history and unlocks before release", async () => {
    const migrationSql = "select 'broken migration';";
    const directory = await fixtureDirectory({
      "0001_broken.sql": migrationSql,
    });
    const manifest = await fixtureManifest(directory, ["0001_broken.sql"]);
    const pool = new MigrationPoolDouble();
    const failure = new Error("migration SQL failed");
    pool.client.failure = { error: failure, text: migrationSql };

    await expect(
      runPlatformMigrations(asPool(pool), directory, manifest),
    ).rejects.toBe(failure);

    expect(pool.client.history).toEqual(new Map());
    expect(
      pool.client.queries.some(({ text }) =>
        text.includes("insert into apollo_platform.schema_migrations"),
      ),
    ).toBe(false);
    expect(pool.client.queries.some(({ text }) => text === "COMMIT")).toBe(
      false,
    );
    expect(pool.client.events.slice(-3)).toEqual([
      "ROLLBACK",
      "select pg_advisory_unlock(hashtext($1))",
      "release",
    ]);
  });
});

describe("platform database helpers", () => {
  test("creates a PostgreSQL pool for the supplied connection string", async () => {
    const connectionString =
      "postgres://runtime:secret@127.0.0.1:5432/platform";
    const pool = createPlatformPool(connectionString);

    expect(pool.options.connectionString).toBe(connectionString);
    expect(pool.options).toMatchObject({
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 10,
      query_timeout: 10_000,
      statement_timeout: 10_000,
      lock_timeout: 3_000,
      idle_in_transaction_session_timeout: 10_000,
    });

    await pool.end();
  });

  test("uses an explicit longer bounded migrator pool profile", async () => {
    const pool = createPlatformPool(
      "postgres://migrator:secret@127.0.0.1:5432/platform",
      "migration",
    );

    expect(pool.options).toMatchObject({
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      max: 2,
      query_timeout: 120_000,
      statement_timeout: 120_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 30_000,
    });
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

  test("retains the primary timeout and discards the client when rollback fails", async () => {
    const pool = new MigrationPoolDouble();
    const timeout = Object.assign(new Error("query timed out"), {
      code: "57014",
    });
    const rollbackFailure = new Error("rollback connection failure");
    pool.client.failure = { error: rollbackFailure, text: "ROLLBACK" };

    await expect(
      withPlatformTransaction(asPool(pool), async () => {
        throw timeout;
      }),
    ).rejects.toBe(timeout);

    expect(pool.client.queries).toEqual([
      { text: "BEGIN", values: undefined },
      { text: "ROLLBACK", values: undefined },
    ]);
    expect(pool.client.releaseErrors).toEqual([rollbackFailure]);
  });
});
