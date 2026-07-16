import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, QueryResultRow } from "pg";

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK = "apollo_platform_migrations";
const DEFAULT_MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

interface MigrationRow extends QueryResultRow {
  name: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function runPlatformMigrations(
  pool: Pool,
  directory = DEFAULT_MIGRATION_DIRECTORY,
): Promise<MigrationResult> {
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [
      MIGRATION_LOCK,
    ]);
    lockAcquired = true;

    await client.query("create schema if not exists apollo_platform");
    await client.query(`
      create table if not exists apollo_platform.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const names = (await readdir(directory))
      .filter((name) => MIGRATION_NAME.test(name))
      .sort();
    const persisted = await client.query<MigrationRow>(
      "select name, checksum from apollo_platform.schema_migrations",
    );
    const checksums = new Map(
      persisted.rows.map(({ name, checksum }) => [name, checksum]),
    );
    const result: MigrationResult = { applied: [], alreadyApplied: [] };

    for (const name of names) {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const persistedChecksum = checksums.get(name);

      if (persistedChecksum !== undefined) {
        if (persistedChecksum !== checksum) {
          throw Object.assign(
            new Error(
              `Migration checksum does not match persisted history: ${name}`,
            ),
            { code: "migration_checksum_mismatch" as const },
          );
        }

        result.alreadyApplied.push(name);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "insert into apollo_platform.schema_migrations (name, checksum) values ($1, $2)",
          [name, checksum],
        );
        await client.query("COMMIT");
        result.applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return result;
  } finally {
    try {
      if (lockAcquired) {
        await client.query("select pg_advisory_unlock(hashtext($1))", [
          MIGRATION_LOCK,
        ]);
      }
    } finally {
      client.release();
    }
  }
}
