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
    if (text.includes("insert into apollo_tf_integrations.schema_migrations")) {
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
