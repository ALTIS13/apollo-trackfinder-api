import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool, QueryResult } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  createIntegrationsPool,
  probeIntegrationsDatabase,
  runIntegrationsMigrations,
  type MigrationManifestEntry,
} from "./index.js";

type RecordedQuery = {
  readonly text: string;
  readonly values?: readonly unknown[];
};

class MigrationClientDouble {
  readonly events: string[] = [];
  readonly failures = new Map<string, Error>();
  readonly history = new Map<string, string>();
  readonly queries: RecordedQuery[] = [];
  releaseCount = 0;
  readonly releaseErrors: (Error | undefined)[] = [];
  releaseFailure?: Error;

  async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.events.push(text);
    this.queries.push({ text, values });
    const failure = this.failures.get(text);
    if (failure !== undefined) throw failure;

    if (text.includes("select name, checksum")) {
      return {
        rows: [...this.history].map(([name, checksum]) => ({ name, checksum })),
        rowCount: this.history.size,
      } as QueryResult;
    }
    if (text.includes("insert into apollo_tf_integrations.schema_migrations")) {
      const [name, checksum] = values ?? [];
      this.history.set(String(name), String(checksum));
    }
    return { rows: [], rowCount: 0 } as unknown as QueryResult;
  }

  release(error?: Error): void {
    this.events.push("release");
    this.releaseCount += 1;
    this.releaseErrors.push(error);
    if (this.releaseFailure !== undefined) throw this.releaseFailure;
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
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "apollo-tf-integrations-migrations-"),
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
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("integrations migrations", () => {
  it("accepts original 0001 history, applies 0002, and still rejects checksum drift", async () => {
    const originalChecksum =
      "6b21e525b90612e6aef5bf29263294824b3084343cb17f5b2910651951a4af1a";
    const pool = new MigrationPoolDouble();
    pool.client.history.set("0001_integrations.sql", originalChecksum);

    await expect(runIntegrationsMigrations(asPool(pool))).resolves.toEqual({
      applied: ["0002_canonical_token_envelope.sql"],
      alreadyApplied: ["0001_integrations.sql"],
    });
    expect(pool.client.history.get("0001_integrations.sql")).toBe(
      originalChecksum,
    );
    expect(pool.client.history.has("0002_canonical_token_envelope.sql")).toBe(
      true,
    );

    pool.client.history.set(
      "0001_integrations.sql",
      "drifted-original-checksum",
    );
    await expect(runIntegrationsMigrations(asPool(pool))).rejects.toMatchObject(
      { code: "migration_checksum_mismatch" },
    );
  });

  it("applies immutable numbered migrations once and rejects checksum drift", async () => {
    const directory = await fixtureDirectory({
      "0001_first.sql": "select 'first integration migration';",
      "0002_second.sql": "select 'second integration migration';",
    });
    const manifest = await fixtureManifest(directory, [
      "0001_first.sql",
      "0002_second.sql",
    ]);
    const pool = new MigrationPoolDouble();

    await expect(
      runIntegrationsMigrations(asPool(pool), directory, manifest),
    ).resolves.toEqual({
      applied: ["0001_first.sql", "0002_second.sql"],
      alreadyApplied: [],
    });
    await expect(
      runIntegrationsMigrations(asPool(pool), directory, manifest),
    ).resolves.toEqual({
      applied: [],
      alreadyApplied: ["0001_first.sql", "0002_second.sql"],
    });

    pool.client.history.set("0001_first.sql", "drifted-checksum");
    await expect(
      runIntegrationsMigrations(asPool(pool), directory, manifest),
    ).rejects.toMatchObject({ code: "migration_checksum_mismatch" });

    expect(
      pool.client.queries
        .map(({ text }) => text.trim())
        .filter((text) => /^(begin|commit|rollback)$/i.test(text)),
    ).toEqual(["BEGIN", "COMMIT", "BEGIN", "COMMIT"]);
    expect(pool.client.queries[0]).toEqual({
      text: "select pg_advisory_lock(hashtext($1))",
      values: ["apollo_tf_integrations_migrations"],
    });
    expect(pool.client.queries.at(-1)).toEqual({
      text: "select pg_advisory_unlock(hashtext($1))",
      values: ["apollo_tf_integrations_migrations"],
    });
    expect(pool.client.releaseCount).toBe(3);
  });

  it.each([
    ["migration SQL", "select 'failing integration migration';"],
    [
      "history insert",
      "insert into apollo_tf_integrations.schema_migrations (name, checksum) values ($1, $2)",
    ],
    ["COMMIT", "COMMIT"],
  ])("rolls back a %s failure before unlock and release", async (_, target) => {
    const migrationSql = "select 'failing integration migration';";
    const directory = await fixtureDirectory({
      "0001_failing.sql": migrationSql,
    });
    const manifest = await fixtureManifest(directory, ["0001_failing.sql"]);
    const pool = new MigrationPoolDouble();
    const failure = new Error(`forced failure: ${target}`);
    pool.client.failures.set(target, failure);

    await expect(
      runIntegrationsMigrations(asPool(pool), directory, manifest),
    ).rejects.toBe(failure);

    expect(pool.client.events.slice(-3)).toEqual([
      "ROLLBACK",
      "select pg_advisory_unlock(hashtext($1))",
      "release",
    ]);
    if (target === "COMMIT") {
      expect(pool.client.events.filter((event) => event === "COMMIT")).toEqual([
        "COMMIT",
      ]);
    } else {
      expect(pool.client.events).not.toContain("COMMIT");
    }
    expect(pool.client.releaseErrors).toEqual([undefined]);
  });

  it("preserves the migration error and destroys the client when ROLLBACK fails", async () => {
    const migrationSql = "select 'rollback failure migration';";
    const directory = await fixtureDirectory({
      "0001_rollback_failure.sql": migrationSql,
    });
    const manifest = await fixtureManifest(directory, [
      "0001_rollback_failure.sql",
    ]);
    const pool = new MigrationPoolDouble();
    const primaryFailure = new Error("migration SQL failed");
    const rollbackFailure = new Error("ROLLBACK failed");
    pool.client.failures.set(migrationSql, primaryFailure);
    pool.client.failures.set("ROLLBACK", rollbackFailure);

    await expect(
      runIntegrationsMigrations(asPool(pool), directory, manifest),
    ).rejects.toBe(primaryFailure);
    expect(pool.client.events.slice(-3)).toEqual([
      "ROLLBACK",
      "select pg_advisory_unlock(hashtext($1))",
      "release",
    ]);
    expect(pool.client.releaseErrors).toEqual([rollbackFailure]);
  });

  it("reports an advisory unlock failure and destroys the client before release", async () => {
    const directory = await fixtureDirectory({
      "0001_unlock_failure.sql": "select 'unlock failure migration';",
    });
    const manifest = await fixtureManifest(directory, [
      "0001_unlock_failure.sql",
    ]);
    const pool = new MigrationPoolDouble();
    const unlockFailure = new Error("advisory unlock failed");
    pool.client.failures.set(
      "select pg_advisory_unlock(hashtext($1))",
      unlockFailure,
    );

    await expect(
      runIntegrationsMigrations(asPool(pool), directory, manifest),
    ).rejects.toBe(unlockFailure);
    expect(pool.client.events.at(-1)).toBe("release");
    expect(pool.client.releaseErrors).toEqual([unlockFailure]);
  });

  it("reports a release failure after successful migration cleanup", async () => {
    const directory = await fixtureDirectory({
      "0001_release_failure.sql": "select 'release failure migration';",
    });
    const manifest = await fixtureManifest(directory, [
      "0001_release_failure.sql",
    ]);
    const pool = new MigrationPoolDouble();
    const releaseFailure = new Error("release failed");
    pool.client.releaseFailure = releaseFailure;

    await expect(
      runIntegrationsMigrations(asPool(pool), directory, manifest),
    ).rejects.toBe(releaseFailure);
    expect(pool.client.events.slice(-2)).toEqual([
      "select pg_advisory_unlock(hashtext($1))",
      "release",
    ]);
  });

  it("uses a bounded integration pool and sanitized health probe", async () => {
    const connectionString =
      "postgres://runtime:secret@127.0.0.1:5432/integrations";
    const pool = createIntegrationsPool(connectionString);
    expect(pool.options).toMatchObject({
      connectionString,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 10,
      query_timeout: 10_000,
      statement_timeout: 10_000,
      lock_timeout: 3_000,
      idle_in_transaction_session_timeout: 10_000,
    });
    await pool.end();

    const healthy = {
      query: async (text: string) => {
        expect(text).toBe("select 1");
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      },
    } as unknown as Pool;
    const unavailable = {
      query: async () => {
        throw new Error(
          "postgres://admin:secret@database/integrations SQLSTATE 08006",
        );
      },
    } as unknown as Pool;

    await expect(probeIntegrationsDatabase(healthy)).resolves.toBe(true);
    await expect(probeIntegrationsDatabase(unavailable)).resolves.toBe(false);
  });
});
